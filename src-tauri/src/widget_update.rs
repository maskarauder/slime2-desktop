//! In-place widget updates. Only core/, config/values.json and account slots change.
//! ZIPs and replacements are staged before the first live rename. A rename journal
//! reverses every completed operation if any part of a multi-widget update fails.
use serde_json::{Map, Value, json};
use std::{
	collections::{BTreeMap, HashSet, hash_map::DefaultHasher},
	fs::{self, File},
	hash::{Hash, Hasher},
	io::{self, Read, Write},
	path::{Path, PathBuf},
};
use zip::ZipArchive;
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_JSON: u64 = 16 * 1024 * 1024;
const MAX_WIDGETS: usize = 50;
pub struct Paths {
	pub tiles: PathBuf,
	pub config: PathBuf,
	pub state: PathBuf,
}
pub struct Prepared {
	pub response: Value,
	stage: PathBuf,
	widgets: Vec<Installed>,
	staged_fingerprint: u64,
}
struct Installed {
	id: String,
	meta: Value,
	core_fingerprint: u64,
	values_bytes: Option<Vec<u8>>,
}
struct Replacement {
	id: String,
	core: PathBuf,
	values: Option<Value>,
	backup: Option<PathBuf>,
}

fn invalid(message: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, message)
}

fn regular(path: &Path) -> io::Result<()> {
	let metadata = fs::symlink_metadata(path)?;
	if !metadata.is_file() || metadata.file_type().is_symlink() {
		return Err(invalid("Widget files must be regular files, without symbolic links."));
	}
	Ok(())
}

fn directory(path: &Path) -> io::Result<()> {
	let metadata = fs::symlink_metadata(path)?;
	if !metadata.is_dir() || metadata.file_type().is_symlink() {
		return Err(invalid("Widget directories must not be symbolic links."));
	}
	Ok(())
}

fn json_file(path: &Path) -> io::Result<Value> {
	regular(path)?;
	if fs::metadata(path)?.len() > MAX_JSON {
		return Err(invalid("Widget JSON exceeds the size limit."));
	}
	serde_json::from_reader(File::open(path)?).map_err(|_| invalid("Invalid widget JSON."))
}

fn write_json(path: &Path, value: &Value) -> io::Result<()> {
	let bytes = serde_json::to_vec(value)?;
	if bytes.len() as u64 > MAX_JSON {
		return Err(invalid("Widget JSON exceeds the size limit."));
	}
	let mut output = File::create(path)?;
	output.write_all(&bytes)?;
	output.sync_all()
}

fn optional_bytes(path: &Path) -> io::Result<Option<Vec<u8>>> {
	match fs::symlink_metadata(path) {
		Ok(_) => {
			regular(path)?;
			if fs::metadata(path)?.len() > MAX_JSON {
				return Err(invalid("Widget JSON exceeds the size limit."));
			}
			fs::read(path).map(Some)
		}
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
		Err(error) => Err(error),
	}
}

fn parse_values(bytes: &Option<Vec<u8>>) -> io::Result<Value> {
	let value: Value = match bytes {
		Some(bytes) => serde_json::from_slice(bytes).map_err(|_| invalid("Invalid saved widget values."))?,
		None => json!({}),
	};
	if !value.is_object() {
		return Err(invalid("Widget values must be a JSON object."));
	}
	Ok(value)
}

fn safe_relative(name: &str) -> bool {
	!name.is_empty() && name.len() <= 1024 && name.split('/').count() <= 32
	&& name.split('/').all(|part| {
		let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
		!part.is_empty() && part != "." && part != ".."
		&& !part.ends_with([' ', '.'])
		&& !part.chars().any(|c| c.is_control() || "\\:*?\"<>|".contains(c))
		&& !["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
		"COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].contains(&base.as_str())
	})
}

fn valid_widget(paths: &Paths, id: &str) -> io::Result<PathBuf> {
	if !id.starts_with("widget_") || id.len() > 160
	|| !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
		return Err(invalid("Invalid installed widget ID."));
	}
	let tile = paths.tiles.join(id);
	directory(&paths.tiles)?;
	directory(&tile)?;
	directory(&tile.join("core"))?;
	directory(&tile.join("config"))?;
	Ok(tile)
}

fn collect(root: &Path) -> io::Result<Vec<PathBuf>> {
	directory(root)?;
	let mut result = Vec::new();
	let mut pending = vec![root.to_owned()];
	let mut count = 0usize;
	let mut bytes = 0u64;
	while let Some(path) = pending.pop() {
		count += 1;
		if count > MAX_FILES {
			return Err(invalid("Too many widget files."));
		}
		let meta = fs::symlink_metadata(&path)?;
		if meta.file_type().is_symlink() {
			return Err(invalid("Widget files cannot contain symbolic links."));
		}
		if meta.is_dir() {
			for entry in fs::read_dir(path)? {
				pending.push(entry?.path());
			}
		} else if meta.is_file() {
			bytes = bytes.checked_add(meta.len()).ok_or_else(|| invalid("Widget exceeds the size limit."))?;
			if meta.len() > MAX_FILE_BYTES || bytes > MAX_BYTES {
				return Err(invalid("Widget exceeds the size limit."));
			}
			result.push(path);
		} else {
			return Err(invalid("Unsupported widget file type."));
		}
	}
	result.sort();
	Ok(result)
}

fn fingerprint(root: &Path) -> io::Result<u64> {
	let mut hash = DefaultHasher::new();
	let mut buffer = [0u8; 64 * 1024];
	for path in collect(root)? {
		path.strip_prefix(root).map_err(io::Error::other)?.hash(&mut hash);
		fs::metadata(&path)?.len().hash(&mut hash);
		let mut file = File::open(path)?;
		loop {
			let count = file.read(&mut buffer)?;
			if count == 0 {
				break;
			}
			hash.write(&buffer[..count]);
		}
	}
	Ok(hash.finish())
}

fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
	fs::create_dir_all(destination)?;
	for file in collect(source)? {
		let relative = file.strip_prefix(source).map_err(io::Error::other)?;
		let output = destination.join(relative);
		fs::create_dir_all(output.parent().ok_or_else(|| invalid("Invalid widget path."))?)?;
		fs::copy(file, output)?;
	}
	Ok(())
}

fn extract(zip_path: &Path, destination: &Path) -> io::Result<()> {
	regular(zip_path)?;
	let mut archive = ZipArchive::new(File::open(zip_path)?)?;
	if archive.len() > MAX_FILES {
		return Err(invalid("Too many files in widget ZIP."));
	}
	let mut total = 0u64;
	// Include implied parent directories, preventing case aliases on Windows/macOS.
	let mut names: BTreeMap<String, (String, bool)> = BTreeMap::new();
	let mut explicit = HashSet::new();
	for index in 0..archive.len() {
		let entry = archive.by_index(index)?;
		let normalized = entry.name().replace('\\', "/");
		let name = normalized.strip_suffix('/').unwrap_or(&normalized);
		if !safe_relative(name) || !explicit.insert(name.to_lowercase()) {
			return Err(invalid("Widget ZIP has an unsafe or duplicate path."));
		}
		let mode = entry.unix_mode().unwrap_or(0) & 0o170000;
		if mode != 0 && mode != 0o100000 && mode != 0o040000 {
			return Err(invalid("Widget ZIP cannot contain symbolic links or special files."));
		}
		let parts: Vec<_> = name.split('/').collect();
		for length in 1..=parts.len() {
			let path = parts[..length].join("/");
			let is_directory = length < parts.len() || entry.is_dir() || normalized.ends_with('/');
			if let Some((existing, existing_dir)) = names.get(&path.to_lowercase()) {
				if existing != &path || !*existing_dir || !is_directory {
					return Err(invalid("Widget ZIP contains conflicting file paths."));
				}
			} else {
				names.insert(path.to_lowercase(), (path, is_directory));
			}
		}
		total = total.checked_add(entry.size()).ok_or_else(|| invalid("Widget ZIP exceeds the size limit."))?;
		if entry.size() > MAX_FILE_BYTES || total > MAX_BYTES {
			return Err(invalid("Widget ZIP exceeds the size limit."));
		}
	}
	fs::create_dir(destination)?;
	let mut actual_total = 0u64;
	for index in 0..archive.len() {
		let mut entry = archive.by_index(index)?;
		let name = entry.name().replace('\\', "/");
		let path = destination.join(name.trim_end_matches('/'));
		if entry.is_dir() || name.ends_with('/') {
			fs::create_dir_all(path)?;
		}
		else {
			fs::create_dir_all(path.parent().ok_or_else(|| invalid("Invalid archive path."))?)?;
			let mut output = File::create(path)?;
			let size = io::copy(&mut (&mut entry).take(MAX_FILE_BYTES + 1), &mut output)?;
			actual_total += size;
			if size > MAX_FILE_BYTES || actual_total > MAX_BYTES || size != entry.size() {
				return Err(invalid("Widget ZIP content exceeds declared limits."));
			}
		}
	}
	Ok(())
}

fn metadata(core: &Path) -> io::Result<(Value, Value)> {
	directory(&core.join("config"))?;
	let meta = json_file(&core.join("config/meta.json"))?;
	for field in ["id", "name", "creator", "version"] {
		if meta[field].as_str().is_none_or(|s| s.trim().is_empty()) {
			return Err(invalid("Widget metadata needs a nonempty ID, name, creator and version."));
		}
	}
	let types = meta["type"].as_array().ok_or_else(|| invalid("Widget metadata has no supported type."))?;
	if types.is_empty() || types.iter().any(|t| t != "bot" && t != "overlay") {
		return Err(invalid("Widget metadata has an unsupported type."));
	}
	if types.iter().any(|t| t == "overlay") {
		regular(&core.join("index.html"))?;
	}
	if types.iter().any(|t| t == "bot") {
		regular(&core.join("bot.js"))?;
	}
	if let Some(imports) = meta.get("import") {
		if !imports.is_object() {
			return Err(invalid("Invalid widget import definitions."));
		}
		for kind in ["js", "css"] {
			if let Some(items) = imports.get(kind) {
				for item in items.as_array().ok_or_else(|| invalid("Invalid widget import definitions."))? {
					let name = item.as_str().ok_or_else(|| invalid("Invalid widget import path."))?;
					if name.starts_with("https://") || name.starts_with("http://") {
						continue;
					}
					if !safe_relative(name) {
						return Err(invalid("Unsafe widget import path."));
					}
					regular(&core.join(name))?;
				}
			}
		}
	}
	if let Some(namespace) = meta.get("storageNamespace") {
		if !namespace.is_string() {
			return Err(invalid("Invalid widget storage namespace."));
		}
	}
	if let Some(accounts) = meta.get("accounts") {
		for account in accounts.as_array().ok_or_else(|| invalid("Invalid widget account slots."))? {
			if !["read", "bot", "mod"].contains(&account["type"].as_str().unwrap_or(""))
			|| !["twitch", "youtube", "tiktok"].contains(&account["service"].as_str().unwrap_or("")) {
				return Err(invalid("Invalid widget account slot."));
			}
		}
	}
	let settings = json_file(&core.join("config/settings.json"))?;
	if !settings.is_object() {
		return Err(invalid("Widget settings must be an object."));
	}
	Ok((meta, settings))
}

fn stage_path(paths: &Paths, token: &str) -> io::Result<PathBuf> {
	if token.len() < 16 || token.len() > 64 || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
		return Err(invalid("Invalid widget update token."));
	}
	fs::create_dir_all(&paths.state)?;
	directory(&paths.state)?;
	Ok(paths.state.join(format!("stage-{token}")))
}

pub fn discard(prepared: Prepared) -> io::Result<()> {
	fs::remove_dir_all(prepared.stage)
}

pub fn prepare(
	paths: &Paths,
	zip: &Path,
	widget_ids: &[String],
	token: &str,
) -> io::Result<Prepared> {
	if widget_ids.is_empty() || widget_ids.len() > MAX_WIDGETS || widget_ids.iter().collect::<HashSet<_>>().len() != widget_ids.len() {
		return Err(invalid("Choose between 1 and 50 distinct installed widgets."));
	}
	let stage = stage_path(paths, token)?;
	fs::create_dir(&stage)?;
	let result = (|| {
		let core = stage.join("core");
		extract(zip, &core)?;
		let (meta, settings) = metadata(&core)?;
		let migrations = if core.join("config/migrations.json").exists() {
			json_file(&core.join("config/migrations.json"))?
		} else {
			Value::Null
		};
		let mut widgets = Vec::new();
		let mut previews = Vec::new();
		for id in widget_ids {
			let tile = valid_widget(paths, id)?;
			let installed_core = tile.join("core");
			let (old_meta, old_settings) = metadata(&installed_core)?;
			if old_meta["id"] != meta["id"] {
				return Err(invalid("The ZIP belongs to a different widget family."));
			}
			if old_meta.get("storageNamespace") != meta.get("storageNamespace") {
				return Err(invalid("An update cannot change the widget's shared storage namespace."));
			}
			let values_bytes = optional_bytes(&tile.join("config/values.json"))?;
			let values = parse_values(&values_bytes)?;
			previews.push(json!({
				"widgetId":id,"meta":old_meta,"settings":old_settings,"values":values
			}));
			widgets.push(Installed {
				id: id.clone(), meta: old_meta, core_fingerprint: fingerprint(&installed_core)?, values_bytes
			});
		}
		Ok(Prepared {
			response: json!({
				"token":token,"meta":meta,"settings":settings,"migrations":migrations,"widgets":previews
			}), staged_fingerprint: fingerprint(&core)?, stage: stage.clone(), widgets
		})
	})();
	if result.is_err() {
		let _ = fs::remove_dir_all(stage);
	}
	result
}

fn accounts(paths: &Paths) -> io::Result<Value> {
	directory(&paths.config)?;
	let value = parse_values(&optional_bytes(&paths.config.join("accounts.json"))?)?;
	for account in value.as_object().ok_or_else(|| invalid("Invalid saved accounts."))?.values() {
		if !account.is_object() || account.get("widgets").is_some_and(|w| !w.is_object()) {
			return Err(invalid("Invalid saved account assignments."));
		}
	}
	Ok(value)
}

fn account_slots(accounts: &Value, id: &str) -> Value {
	let mut slots = Map::new();
	if let Some(accounts) = accounts.as_object() {
		for (account_id, account) in accounts {
			if let Some(index) = account.get("widgets").and_then(|v| v.get(id)) {
				slots.insert(account_id.clone(), index.clone());
			}
		}
	}
	Value::Object(slots)
}

fn backup_path(paths: &Paths, id: &str) -> io::Result<PathBuf> {
	valid_widget(paths, id)?;
	let backups = paths.state.join("backups");
	fs::create_dir_all(&backups)?;
	directory(&backups)?;
	Ok(backups.join(id))
}

pub fn status(paths: &Paths, id: &str) -> io::Result<bool> {
	let backup = backup_path(paths, id)?;
	if !backup.exists() {
		return Ok(false);
	}
	directory(&backup)?;
	Ok(backup.join("core/config/meta.json").is_file() && backup.join("receipt.json").is_file())
}

fn save_backup(
	tile: &Path,
	destination: &Path,
	account_slots: Value,
) -> io::Result<()> {
	fs::create_dir(destination)?;
	copy_tree(&tile.join("core"), &destination.join("core"))?;
	let bytes = optional_bytes(&tile.join("config/values.json"))?;
	if let Some(bytes) = &bytes {
		fs::write(destination.join("values.json"), bytes)?;
	}
	write_json(&destination.join("receipt.json"), &json!({
		"valuesPresent":bytes.is_some(),"accountSlots":account_slots
	}))
}

fn media_fields(settings: &Value, values: &Value) -> Vec<(String, Value)> {
	fn visit(id: &str, setting: &Value, prefix: &str, values: &Value, output: &mut Vec<(String,
	Value)>) {
		let key = if prefix.is_empty() {
			id.to_string()
		} else {
			format!("{prefix}.{id}")
		};
		let kind = setting["type"].as_str().unwrap_or("");
		if kind == "section" {
			if let Some(children) = setting["settings"].as_object() {
				for (child_id, child) in children {
					visit(child_id, child, prefix, values, output);
				}
			}
		} else if kind == "multi-section" {
			if let (Some(rows), Some(children)) = (values[&key].as_array(), setting["settings"].as_object()) {
				for row in rows.iter().filter_map(Value::as_str) {
					for (child_id, child) in children {
						visit(child_id, child, row, values, output);
					}
				}
			}
		} else if ["image-input", "audio-input", "video-input", "multi-image-input", "multi-audio-input",
		"multi-video-input"].contains(&kind) {
			output.push((key.clone(), values.get(&key).or_else(|| setting.get("defaultValue")).cloned().unwrap_or(Value::Null)));
		}
	}
	let mut output = Vec::new();
	if let Some(categories) = settings.as_object() {
		for category in categories.values() {
			if let Some(children) = category["settings"].as_object() {
				for (id, setting) in children {
					visit(id, setting, "", values, &mut output);
				}
			}
		}
	}
	output
}

fn preserve_media(
	old_core: &Path,
	new_core: &Path,
	settings: &Value,
	values: &Value,
) -> io::Result<()> {
	for (_, media) in media_fields(settings, values) {
		let refs = match &media {
			Value::String(text) => vec![text.as_str()], Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
			_ => vec![]
		};
		for reference in refs {
			if reference.is_empty() || reference.starts_with("gallery:") || reference.starts_with("local:") || reference.starts_with("https://") || reference.starts_with("http://") {
				continue;
			}
			if !safe_relative(reference) {
				return Err(invalid("Saved widget media has an unsafe relative path."));
			}
			let destination = new_core.join(reference);
			if destination.exists() {
				regular(&destination)?;
				continue;
			}
			let source = old_core.join(reference);
			regular(&source).map_err(|_| invalid("The update is missing a saved core media asset. Restore the file or choose different media first."))?;
			// The complete old core was checked for symlinks by fingerprint().
			fs::create_dir_all(destination.parent().ok_or_else(|| invalid("Invalid media path."))?)?;
			fs::copy(source, destination)?;
		}
	}
	Ok(())
}
struct Journal {
	entries: Vec<(PathBuf, PathBuf)>,
	file: PathBuf,
}

fn describe_path(paths: &Paths, path: &Path) -> io::Result<Value> {
	for (name, root) in [("state", &paths.state), ("tiles", &paths.tiles), ("config",
	&paths.config)] {
		if let Ok(relative) = path.strip_prefix(root) {
			let relative = relative.to_str().ok_or_else(|| invalid("Invalid transaction path."))?.replace('\\',
			"/");
			return Ok(json!({
				"root":name,"path":relative
			}));
		}
	}
	Err(invalid("Transaction path is outside app-owned storage."))
}

fn recover_path(
	paths: &Paths,
	stage: &Path,
	value: &Value,
) -> io::Result<PathBuf> {
	let relative = value["path"].as_str().ok_or_else(|| invalid("Invalid recovery path."))?;
	if !safe_relative(relative) {
		return Err(invalid("Unsafe recovery path."));
	}
	let parts: Vec<_> = relative.split('/').collect();
	let valid_id = |id: &str| id.starts_with("widget_") && id.len() <= 160 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
	match value["root"].as_str() {
		Some("state") => {
			let path = paths.state.join(relative);
			if path.starts_with(stage) || (parts.len() == 2 && parts[0] == "backups" && valid_id(parts[1])) {
				Ok(path)
			}
			else {
				Err(invalid("Recovery path does not belong to this update."))
			}
		}
		Some("tiles") if !parts.is_empty() && valid_id(parts[0]) && ((parts.len() == 2 && parts[1] == "core") || (parts.len() == 3 && parts[1] == "config" && parts[2] == "values.json")) => Ok(paths.tiles.join(relative)),
		Some("config") => {
			let token = stage.file_name().and_then(|v| v.to_str()).ok_or_else(|| invalid("Invalid recovery stage."))?;
			if relative == "accounts.json" || relative == format!(".{token}-accounts-next.json") || relative == format!(".{token}-accounts-old.json") {
				Ok(paths.config.join(relative))
			}
			else {
				Err(invalid("Recovery can only change account assignments."))
			}
		}
		_ => Err(invalid("Invalid recovery storage root.")),
	}
}

fn persist_journal(
	paths: &Paths,
	journal: &Journal,
	finished: bool,
) -> io::Result<()> {
	let mut entries = Vec::new();
	for (from, to) in &journal.entries {
		entries.push(json!({
			"from":describe_path(paths,from)?,"to":describe_path(paths,to)?
		}));
	}
	let temporary = journal.file.with_extension("tmp");
	write_json(&temporary,&json!({
		"version":1,"finished":finished,"moves":entries
	}))?;
	fs::rename(temporary,&journal.file)
}

fn reverse_journal(paths: &Paths, journal: &mut Journal) -> io::Result<()> {
	while let Some((from, to)) = journal.entries.last() {
		match (from.try_exists()?, to.try_exists()?) {
			(false,true) => fs::rename(to,from)?,
			(true,false) => {}, // Intent persisted before a rename that never happened.
			_ => return Err(invalid("Ambiguous widget recovery paths; preserve recovery files for manual repair.")),
		}
		journal.entries.pop();
		persist_journal(paths,journal,false)?;
	}
	persist_journal(paths,journal,true)
}

fn move_recorded(
	paths: &Paths,
	from: &Path,
	to: &Path,
	journal: &mut Journal,
) -> io::Result<()> {
	if to.try_exists()? {
		return Err(invalid("A widget transaction destination already exists."));
	}
	journal.entries.push((from.to_owned(), to.to_owned()));
	// Persist intent before mutation. On a process crash recovery checks which
	// side of this rename exists and reverses the completed suffix in order.
	if let Err(error) = persist_journal(paths,journal,false) {
		journal.entries.pop();
		return Err(error);
	}
	fs::rename(from,to)?;
	#[cfg(test)]
	FAIL_AFTER.with(|cell| {
		if cell.get() == Some(journal.entries.len()) {
			return Err(io::Error::other("Injected rename failure"));
		}
		Ok(())
	})?;
	Ok(())
}
/// Called before readers start and before another update. Old, uncommitted ZIP
/// previews expire; interrupted live swaps are rolled back from the durable log.
pub fn recover(paths: &Paths) -> io::Result<()> {
	if !paths.state.exists() {
		return Ok(());
	}
	directory(&paths.state)?;
	for entry in fs::read_dir(&paths.state)? {
		let entry = entry?;
		let stage = entry.path();
		let name = entry.file_name();
		let Some(name) = name.to_str() else {
			continue;
		};
		if !name.starts_with("stage-") {
			continue;
		}
		directory(&stage)?;
		let file = stage.join("transaction.json");
		if file.exists() {
			let value = json_file(&file)?;
			if value["version"] != 1 {
				return Err(invalid("Unsupported widget recovery journal."));
			}
			let moves = value["moves"].as_array().ok_or_else(|| invalid("Invalid widget recovery journal."))?;
			if moves.len() > MAX_WIDGETS * 8 + 2 {
				return Err(invalid("Widget recovery journal exceeds the size limit."));
			}
			let mut journal = Journal {
				entries: Vec::new(),
				file
			};
			for item in moves {
				journal.entries.push((recover_path(paths,&stage,&item["from"])?,recover_path(paths,
				&stage,&item["to"])?));
			}
			if value["finished"] != true {
				reverse_journal(paths,&mut journal)?;
			}
			for suffix in ["next","old"] {
				let _ = fs::remove_file(paths.config.join(format!(".{name}-accounts-{suffix}.json")));
			}
			fs::remove_dir_all(stage)?;
		} else if entry.metadata()?.modified()?.elapsed().is_ok_and(|elapsed| elapsed > std::time::Duration::from_secs(24 * 60 * 60)) {
			for suffix in ["next","old"] {
				let _ = fs::remove_file(paths.config.join(format!(".{name}-accounts-{suffix}.json")));
			}
			fs::remove_dir_all(stage)?;
		}
	}
	Ok(())
}
// The journal also includes backup promotion, so a failed batch preserves the
// previously available Undo for every widget. All staging precedes live writes.
fn transact(
	paths: &Paths,
	stage: &Path,
	replacements: &[Replacement],
	previous_accounts: &Option<Vec<u8>>,
	next_accounts: &Value,
) -> io::Result<()> {
	let token = stage
		.file_name()
		.and_then(|value| value.to_str())
		.ok_or_else(|| invalid("Invalid update stage."))?;
	let account_next = paths.config.join(format!(".{token}-accounts-next.json"));
	let account_old = paths.config.join(format!(".{token}-accounts-old.json"));
	if account_next.exists() || account_old.exists() {
		return Err(invalid("An earlier account transaction needs recovery."));
	}
	write_json(&account_next, next_accounts)?;
	let mut journal = Journal {
		entries: Vec::new(),
		file: stage.join("transaction.json"),
	};
	let result = (|| {
		if optional_bytes(&paths.config.join("accounts.json"))?
			!= *previous_accounts
		{
			return Err(invalid(
				"Accounts changed during update. Preview the update again.",
			));
		}
		for replacement in replacements {
			let tile = valid_widget(paths, &replacement.id)?;
			let work = stage.join(&replacement.id);
			move_recorded(
				paths,
				&tile.join("core"),
				&work.join("old-core"),
				&mut journal,
			)?;
			move_recorded(
				paths,
				&replacement.core,
				&tile.join("core"),
				&mut journal,
			)?;
			if tile.join("config/values.json").exists() {
				move_recorded(
					paths,
					&tile.join("config/values.json"),
					&work.join("old-values.json"),
					&mut journal,
				)?;
			}
			if replacement.values.is_some() {
				move_recorded(
					paths,
					&work.join("next-values.json"),
					&tile.join("config/values.json"),
					&mut journal,
				)?;
			}
			let backup = backup_path(paths, &replacement.id)?;
			if backup.exists() {
				directory(&backup)?;
				move_recorded(
					paths,
					&backup,
					&work.join("previous-backup"),
					&mut journal,
				)?;
			}
			if let Some(next_backup) = &replacement.backup {
				move_recorded(paths, next_backup, &backup, &mut journal)?;
			}
		}
		if previous_accounts.is_some() {
			move_recorded(
				paths,
				&paths.config.join("accounts.json"),
				&account_old,
				&mut journal,
			)?;
		}
		move_recorded(
			paths,
			&account_next,
			&paths.config.join("accounts.json"),
			&mut journal,
		)?;
		Ok(())
	})();
	if result.is_err() {
		if reverse_journal(paths, &mut journal).is_err() {
			return Err(invalid(
				"Widget update failed and rollback could not finish. Restart Slime2 to recover the retained widget-updates files before continuing.",
			));
		}
	} else if persist_journal(paths, &journal, true).is_err() {
		if reverse_journal(paths, &mut journal).is_err() {
			return Err(invalid(
				"Widget update failed and rollback could not finish. Restart Slime2 to recover the retained widget-updates files before continuing.",
			));
		}
		return Err(invalid(
			"The widget update could not be finalized and was rolled back.",
		));
	}
	let _ = fs::remove_file(account_next);
	let _ = fs::remove_file(account_old);
	result
}

pub fn commit(
	paths: &Paths,
	prepared: &Prepared,
	updates: &Value,
) -> io::Result<Value> {
	let updates = updates.as_array().ok_or_else(|| invalid("Invalid widget update values."))?;
	if updates.len() != prepared.widgets.len() {
		return Err(invalid("The update must include exactly the previewed widgets."));
	}
	let mut seen = HashSet::new();
	for update in updates {
		let id = update["widgetId"].as_str().ok_or_else(|| invalid("Invalid widget update ID."))?;
		if !seen.insert(id) || !prepared.widgets.iter().any(|w| w.id == id) {
			return Err(invalid("The update must include exactly the previewed widgets."));
		}
	}
	if fingerprint(&prepared.stage.join("core"))? != prepared.staged_fingerprint {
		return Err(invalid("The staged ZIP changed. Preview the update again."));
	}
	for installed in &prepared.widgets {
		let tile = valid_widget(paths, &installed.id)?;
		if fingerprint(&tile.join("core"))? != installed.core_fingerprint
			|| optional_bytes(&tile.join("config/values.json"))?
				!= installed.values_bytes
		{
			return Err(invalid(
				"Widget files or settings changed after preview. Preview the update again."
			));
		}
	}
	let previous_accounts = optional_bytes(&paths.config.join("accounts.json"))?;
	let mut next_accounts = accounts(paths)?;
	let mut replacements = Vec::new();
	let new_meta = &prepared.response["meta"];
	let empty = Vec::new();
	let new_slots = new_meta["accounts"].as_array().unwrap_or(&empty);
	for installed in &prepared.widgets {
		let update = updates
			.iter()
			.find(|u| u["widgetId"] == installed.id)
			.ok_or_else(|| invalid("Missing widget update."))?;
		let values = &update["values"];
		if !values.is_object() {
			return Err(invalid("Widget values must be an object."));
		}
		let slot_map = update["slotMap"]
			.as_array()
			.ok_or_else(|| invalid("Missing account slot mapping."))?;
		let old_slots = installed.meta["accounts"].as_array().unwrap_or(&empty);
		if slot_map.len() != old_slots.len() {
			return Err(invalid("Account slot mapping does not match the installed widget."));
		}
		let mut target_slots = HashSet::new();
		for (old_index, mapped) in slot_map.iter().enumerate() {
			if mapped.is_null() {
				continue;
			}
			let index = mapped
				.as_u64()
				.and_then(|i| usize::try_from(i).ok())
				.ok_or_else(|| invalid("Invalid account slot mapping."))?;
			if index >= new_slots.len()
				|| !target_slots.insert(index)
				|| old_slots[old_index]["service"] != new_slots[index]["service"]
				|| old_slots[old_index]["type"] != new_slots[index]["type"]
			{
				return Err(invalid(
					"Account slot mapping changes service/type or duplicates a slot."
				));
			}
		}
		let old_assignments = account_slots(&next_accounts, &installed.id);
		for account in next_accounts
			.as_object_mut()
			.ok_or_else(|| invalid("Invalid accounts."))?
			.values_mut()
		{
			if let Some(assignments) = account
				.get_mut("widgets")
				.and_then(Value::as_object_mut)
			{
				if let Some(old) = assignments.remove(&installed.id) {
					let index = old
						.as_u64()
						.and_then(|n| usize::try_from(n).ok())
						.ok_or_else(|| invalid("Invalid saved account slot."))?;
					if let Some(mapped) = slot_map.get(index).filter(|v| !v.is_null()) {
						assignments.insert(installed.id.clone(), mapped.clone());
					}
				}
			}
		}
		let tile = valid_widget(paths, &installed.id)?;
		let work = prepared.stage.join(&installed.id);
		fs::create_dir(&work)?;
		let core = work.join("next-core");
		copy_tree(&prepared.stage.join("core"), &core)?;
		preserve_media(&tile.join("core"), &core, &prepared.response["settings"], values)?;
		let _ = fingerprint(&core)?;
		write_json(&work.join("next-values.json"), values)?;
		let backup = work.join("next-backup");
		save_backup(&tile, &backup, old_assignments)?;
		if fingerprint(&backup.join("core"))? != installed.core_fingerprint
			|| optional_bytes(&backup.join("values.json"))? != installed.values_bytes
		{
			return Err(invalid(
				"Widget files or settings changed while making the rollback copy. Preview the update again."
			));
		}
		replacements.push(Replacement {
			id: installed.id.clone(),
			core,
			values: Some(values.clone()),
			backup: Some(backup)
		});
	}
	for installed in &prepared.widgets {
		let tile = valid_widget(paths, &installed.id)?;
		if fingerprint(&tile.join("core"))? != installed.core_fingerprint
			|| optional_bytes(&tile.join("config/values.json"))?
				!= installed.values_bytes
		{
			return Err(invalid(
				"Widget files or settings changed while staging. Preview the update again."
			));
		}
	}
	transact(paths, &prepared.stage, &replacements, &previous_accounts, &next_accounts)?;
	let slots: Map<String, Value> = prepared
		.widgets
		.iter()
		.map(|w| (w.id.clone(), account_slots(&next_accounts, &w.id)))
		.collect();
	Ok(json!({
		"widgetIds": prepared.widgets.iter().map(|w| &w.id).collect::<Vec<_>>(),
		"accountSlots": slots
	}))
}

pub fn restore(
	paths: &Paths,
	widget_id: &str,
	token: &str,
) -> io::Result<Value> {
	valid_widget(paths, widget_id)?;
	let backup = backup_path(paths, widget_id)?;
	directory(&backup)?;
	let (meta, settings) = metadata(&backup.join("core"))?;
	// Validate every backup file before copying, including files not in metadata.
	let _ = fingerprint(&backup.join("core"))?;
	let receipt = json_file(&backup.join("receipt.json"))?;
	let values = if receipt["valuesPresent"] == true {
		Some(json_file(&backup.join("values.json"))?)
	} else {
		None
	};
	let previous_accounts = optional_bytes(&paths.config.join("accounts.json"))?;
	let mut next_accounts = accounts(paths)?;
	let old_slots = receipt["accountSlots"]
		.as_object()
		.ok_or_else(|| invalid("Invalid widget rollback receipt."))?;
	for (id, account) in next_accounts
		.as_object_mut()
		.ok_or_else(|| invalid("Invalid saved accounts."))?
	{
		let old_index = old_slots
			.get(id)
			.and_then(Value::as_u64)
			.and_then(|v| usize::try_from(v).ok());
		let valid_index = old_index.filter(|index| {
			meta["accounts"]
				.as_array()
				.and_then(|slots| slots.get(*index))
				.is_some_and(|slot| {
					slot["service"] == account["service"]
						&& slot["type"] == account["type"]
				})
		});
		let object = account.as_object_mut().ok_or_else(|| invalid("Invalid saved account."))?;
		let assignments = object
			.entry("widgets")
			.or_insert_with(|| json!({}))
			.as_object_mut()
			.ok_or_else(|| invalid("Invalid account assignments."))?;
		assignments.remove(widget_id);
		if let Some(index) = valid_index {
			assignments.insert(widget_id.to_string(), json!(index));
		}
	}
	let stage = stage_path(paths, token)?;
	fs::create_dir(&stage)?;
	let result = (|| {
		let work = stage.join(widget_id);
		fs::create_dir(&work)?;
		let core = work.join("next-core");
		copy_tree(&backup.join("core"), &core)?;
		if let Some(value) = &values {
			write_json(&work.join("next-values.json"), value)?;
		}
		let replacements = vec![Replacement {
			id: widget_id.to_string(),
			core,
			values: values.clone(),
			backup: None
		}];
		transact(paths, &stage, &replacements, &previous_accounts, &next_accounts)?;
		Ok(json!({
			"widgetId": widget_id,
			"meta": meta,
			"settings": settings,
			"values": values.unwrap_or_else(|| json!({})),
			"accountSlots": account_slots(&next_accounts, widget_id)
		}))
	})();
	// Never erase retained recovery files if the rename journal could not unwind.
	if result.as_ref().err().is_none_or(|e: &io::Error| {
		!e.to_string().contains("rollback could not finish")
	}) {
		let _ = fs::remove_dir_all(stage);
	}
	result
}
#[cfg(test)]
thread_local! {
	static FAIL_AFTER: std::cell::Cell<Option<usize>> = const {
		std::cell::Cell::new(None)
	};
}
#[cfg(test)]
#[path = "widget_update_tests.rs"]
mod tests;
