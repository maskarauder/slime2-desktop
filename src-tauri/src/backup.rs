//! Portable backups exclude the keyring. Restore swaps run before readers start.
use serde_json::{Value, json};
use std::{
	collections::HashSet,
	fs::{self, File},
	io::{self, Read, Write},
	path::{Path, PathBuf},
};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 50_000;
const MAX_JSON: u64 = 16 * 1024 * 1024;
const ROOTS: [&str; 3] = ["config", "tiles", "media"];
const CONFIG_FILES: [&str; 3] =
	["accounts.json", "settings.json", "tile_locations.json"];
pub struct Paths {
	pub config: PathBuf,
	pub tiles: PathBuf,
	pub media: PathBuf,
	pub state: PathBuf,
}
impl Paths {
	fn roots(&self) -> [&Path; 3] {
		[&self.config, &self.tiles, &self.media]
	}
	pub fn stage(&self, token: &str) -> io::Result<PathBuf> {
		if token.len() != 32 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
			return Err(invalid("Invalid restore token."));
		}
		Ok(self.state.join(format!("restore-stage-{token}")))
	}
}
fn invalid(message: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, message)
}
fn json_file(path: &Path) -> io::Result<Value> {
	if fs::metadata(path)?.len() > MAX_JSON {
		return Err(invalid("Backup JSON is too large."));
	}
	serde_json::from_reader(File::open(path)?).map_err(io::Error::other)
}
fn write_json(path: &Path, value: &Value) -> io::Result<()> {
	let temporary = path.with_extension("tmp");
	let mut output = File::create(&temporary)?;
	serde_json::to_writer(&mut output, value)?;
	output.sync_all()?;
	drop(output);
	fs::rename(temporary, path)
}
fn allowed(name: &str) -> bool {
	let parts: Vec<_> = name.split('/').collect();
	if parts.len() < 2
		|| parts.iter().any(|part| {
			let base =
				part.split('.').next().unwrap_or("").to_ascii_uppercase();
			part.is_empty()
				|| *part == "."
				|| *part == ".."
				|| part.ends_with([' ', '.'])
				|| part
					.chars()
					.any(|c| c.is_control() || "\\:*?\"<>|".contains(c))
				|| [
					"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4",
					"COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
					"LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
				]
				.contains(&base.as_str())
		}) {
		return false;
	}
	match parts[0] {
		"config" => {
			(parts.len() == 2 && CONFIG_FILES.contains(&parts[1]))
				|| (parts.len() == 3
					&& parts[1] == "widget_storage"
					&& parts[2].starts_with("ns-")
					&& parts[2].ends_with(".json"))
		}
		"tiles" | "media" => true,
		_ => false,
	}
}
fn collect(root: &Path) -> io::Result<Vec<PathBuf>> {
	let mut files = Vec::new();
	if !root.exists() {
		return Ok(files);
	}
	let mut pending = vec![root.to_owned()];
	let mut visited = 0;
	while let Some(path) = pending.pop() {
		visited += 1;
		if visited > MAX_FILES {
			return Err(invalid("Too many backup files/directories."));
		}
		let kind = fs::symlink_metadata(&path)?.file_type();
		if kind.is_symlink() {
			return Err(invalid("Backups cannot contain symbolic links."));
		}
		if kind.is_dir() {
			for entry in fs::read_dir(path)? {
				pending.push(entry?.path());
			}
		} else if kind.is_file() {
			files.push(path);
		} else {
			return Err(invalid("Unsupported backup file type."));
		}
	}
	files.sort();
	Ok(files)
}
pub fn create(
	paths: &Paths,
	destination: &Path,
	version: &str,
) -> io::Result<()> {
	let empty_layout = !paths.config.join("tile_locations.json").exists();
	if empty_layout && !collect(&paths.tiles)?.is_empty() {
		return Err(invalid(
			"Tile layout is missing. Wait for widget changes to save before backing up.",
		));
	}
	let canonical_parent = destination
		.parent()
		.ok_or_else(|| invalid("Choose a backup destination."))?
		.canonicalize()?;
	for root in paths.roots() {
		if root.exists() && canonical_parent.starts_with(root.canonicalize()?) {
			return Err(invalid(
				"Save the backup outside Slime2 configuration, tiles and media.",
			));
		}
	}
	let temporary = destination.with_extension("slime2-backup-tmp");
	let output = fs::OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&temporary)?;
	let result = (|| {
		let mut archive = ZipWriter::new(output);
		let options = SimpleFileOptions::default()
			.compression_method(zip::CompressionMethod::Deflated);
		archive.start_file("manifest.json", options)?;
		archive.write_all(
			serde_json::to_string(
				&json!({"format":"slime2-backup","version":1,"appVersion":version}),
			)?
			.as_bytes(),
		)?;
		if empty_layout {
			archive.start_file("config/tile_locations.json", options)?;
			archive.write_all(b"{}")?;
		}
		let mut bytes = 0u64;
		let mut count = 1usize + usize::from(empty_layout);
		for (name, root) in ROOTS.iter().zip(paths.roots()) {
			for source in collect(root)? {
				let relative = source
					.strip_prefix(root)
					.map_err(io::Error::other)?
					.to_str()
					.ok_or_else(|| invalid("Non-UTF-8 backup filename."))?
					.replace('\\', "/");
				let entry = format!("{name}/{relative}");
				if !allowed(&entry) {
					if *name == "config" {
						continue;
					}
					return Err(invalid(
						"A widget/media filename cannot be restored portably.",
					));
				}
				count += 1;
				if count > MAX_FILES {
					return Err(invalid("Too many backup files."));
				}
				archive.start_file(entry, options)?;
				bytes += io::copy(
					&mut File::open(source)?
						.take(MAX_BYTES.saturating_sub(bytes) + 1),
					&mut archive,
				)?;
				if bytes > MAX_BYTES {
					return Err(invalid("Backup exceeds 2 GiB."));
				}
			}
		}
		archive.finish()?.sync_all()?;
		fs::rename(&temporary, destination)
	})();
	if result.is_err() {
		let _ = fs::remove_file(&temporary);
	}
	result
}
pub fn stage(paths: &Paths, source: &Path, token: &str) -> io::Result<Value> {
	let folder = paths.stage(token)?;
	fs::create_dir(&folder)?;
	let result = (|| {
		let file = File::open(source)?;
		if file.metadata()?.len() > MAX_BYTES {
			return Err(invalid("Backup exceeds 2 GiB."));
		}
		let mut archive = ZipArchive::new(file)?;
		if archive.len() > MAX_FILES {
			return Err(invalid("Too many backup files."));
		}
		let mut total = 0u64;
		let mut names = HashSet::new();
		for i in 0..archive.len() {
			let mut entry = archive.by_index(i)?;
			let name = entry.name().to_owned();
			if name != "manifest.json" && !allowed(&name) {
				return Err(invalid("Unexpected or unsafe path in backup."));
			}
			if !names.insert(name.to_lowercase()) {
				return Err(invalid(
					"Duplicate/case-colliding file in backup.",
				));
			}
			if entry.is_dir()
				|| entry.unix_mode().is_some_and(|mode| {
					![0, 0o100000].contains(&(mode & 0o170000))
				}) {
				return Err(invalid("Backup must contain regular files only."));
			}
			if entry.size() > MAX_BYTES.saturating_sub(total) {
				return Err(invalid("Expanded backup exceeds 2 GiB."));
			}
			let path = folder.join(&name);
			fs::create_dir_all(path.parent().unwrap())?;
			let mut output = fs::OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(path)?;
			let copied = io::copy(
				&mut (&mut entry).take(MAX_BYTES.saturating_sub(total) + 1),
				&mut output,
			)?;
			total += copied;
			if copied != entry.size() || total > MAX_BYTES {
				return Err(invalid("Invalid expanded backup size."));
			}
			output.sync_all()?;
		}
		let manifest = json_file(&folder.join("manifest.json"))?;
		if manifest["format"] != "slime2-backup" || manifest["version"] != 1 {
			return Err(invalid("Unsupported backup format."));
		}
		for root in ROOTS {
			fs::create_dir_all(folder.join(root))?;
		}
		let accounts_file = folder.join("config/accounts.json");
		if accounts_file.exists() {
			let mut accounts = json_file(&accounts_file)?;
			for account in accounts
				.as_object_mut()
				.ok_or_else(|| invalid("Invalid accounts in backup."))?
				.values_mut()
			{
				let record = account
					.as_object_mut()
					.ok_or_else(|| invalid("Invalid account record."))?;
				record.retain(|key, _| {
					[
						"id",
						"serviceId",
						"service",
						"username",
						"displayName",
						"image",
						"scopes",
						"type",
						"reauthorize",
						"widgets",
						"default",
					]
					.contains(&key.as_str())
				});
				record.insert("reauthorize".into(), Value::Bool(true));
			}
			write_json(&accounts_file, &accounts)?;
		}
		for file in collect(&folder.join("config"))? {
			if !json_file(&file)?.is_object() {
				return Err(invalid("Invalid configuration object in backup."));
			}
		}
		validate_layout(&folder)?;
		Ok(
			json!({"token":token,"files":names.len()-1,"bytes":total,"appVersion":manifest["appVersion"]}),
		)
	})();
	if result.is_err() {
		let _ = fs::remove_dir_all(&folder);
	}
	result
}
fn validate_layout(folder: &Path) -> io::Result<()> {
	let value = json_file(&folder.join("config/tile_locations.json"))?;
	let locations = value
		.as_object()
		.ok_or_else(|| invalid("Invalid tile layout."))?;
	for (id, tile) in locations {
		if !allowed(&format!("tiles/{id}/config/meta.json"))
			|| id.contains('/')
			|| !(id.starts_with("widget_") || id.starts_with("folder_"))
			|| tile["id"] != id.as_str()
			|| tile["index"].as_u64().is_none()
			|| !tile["folderId"].is_string()
			|| !folder.join("tiles").join(id).is_dir()
		{
			return Err(invalid(
				"Backup layout references an invalid or missing tile.",
			));
		}
	}
	for entry in fs::read_dir(folder.join("tiles"))? {
		let entry = entry?;
		if !entry.file_type()?.is_dir()
			|| !locations
				.contains_key(&entry.file_name().to_string_lossy().into_owned())
		{
			return Err(invalid(
				"Backup contains tiles missing from its layout. Create a new backup after widget edits finish.",
			));
		}
	}
	Ok(())
}
pub fn schedule(paths: &Paths, token: &str) -> io::Result<()> {
	if !paths.stage(token)?.join("manifest.json").is_file() {
		return Err(invalid("Restore preview has expired."));
	}
	let journal = paths.state.join("restore-pending.json");
	if journal.exists() {
		return Err(invalid("A restore is already waiting for restart."));
	}
	write_json(&journal, &json!({"token":token,"phase":"ready"}))
}
fn adjacent(root: &Path, token: &str, label: &str) -> io::Result<PathBuf> {
	let name = root
		.file_name()
		.and_then(|v| v.to_str())
		.ok_or_else(|| invalid("Invalid restore root."))?;
	Ok(root.with_file_name(format!("{name}.restore-{label}-{token}")))
}
fn remove_dir(path: &Path) -> io::Result<()> {
	if path.exists() {
		fs::remove_dir_all(path)
	} else {
		Ok(())
	}
}
fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
	fs::create_dir_all(target)?;
	for file in collect(source)? {
		let destination =
			target.join(file.strip_prefix(source).map_err(io::Error::other)?);
		fs::create_dir_all(destination.parent().unwrap())?;
		fs::copy(file, destination)?;
	}
	Ok(())
}
fn rollback(paths: &Paths, token: &str, had: &[Value]) -> io::Result<()> {
	for (i, root) in paths.roots().iter().enumerate().rev() {
		let old = adjacent(root, token, "old")?;
		if old.exists() {
			remove_dir(root)?;
			fs::rename(old, root)?;
		} else if had.get(i) == Some(&Value::Bool(false)) {
			remove_dir(root)?;
		}
	}
	Ok(())
}
fn cleanup(paths: &Paths, token: &str) -> io::Result<()> {
	for root in paths.roots() {
		remove_dir(&adjacent(root, token, "new")?)?;
		remove_dir(&adjacent(root, token, "old")?)?;
	}
	remove_dir(&paths.stage(token)?)?;
	fs::remove_file(paths.state.join("restore-pending.json"))
}
pub fn apply_pending(paths: &Paths) -> io::Result<()> {
	let journal = paths.state.join("restore-pending.json");
	if !journal.exists() {
		return Ok(());
	}
	let mut record = json_file(&journal)?;
	let token = record["token"]
		.as_str()
		.ok_or_else(|| invalid("Invalid restore journal."))?
		.to_owned();
	let stage = paths.stage(&token)?;
	if record["phase"] == "committed" {
		return cleanup(paths, &token);
	}
	if record["phase"] == "applying" {
		rollback(
			paths,
			&token,
			record["had"]
				.as_array()
				.ok_or_else(|| invalid("Invalid rollback journal."))?,
		)?;
		return cleanup(paths, &token);
	}
	if record["phase"] != "ready" {
		return Err(invalid("Invalid restore phase."));
	}
	for (name, root) in ROOTS.iter().zip(paths.roots()) {
		let candidate = adjacent(root, &token, "new")?;
		remove_dir(&candidate)?;
		if *name == "config" && root.exists() {
			copy_tree(root, &candidate)?;
			for name in CONFIG_FILES {
				let path = candidate.join(name);
				if path.exists() {
					fs::remove_file(path)?;
				}
			}
			remove_dir(&candidate.join("widget_storage"))?;
		}
		copy_tree(&stage.join(name), &candidate)?;
	}
	let had: Vec<_> = paths
		.roots()
		.iter()
		.map(|root| Value::Bool(root.exists()))
		.collect();
	record["had"] = json!(had);
	record["phase"] = json!("applying");
	write_json(&journal, &record)?;
	let result = (|| {
		for root in paths.roots() {
			if root.exists() {
				fs::rename(root, adjacent(root, &token, "old")?)?;
			}
			fs::rename(adjacent(root, &token, "new")?, root)?;
		}
		record["phase"] = json!("committed");
		write_json(&journal, &record)
	})();
	if let Err(error) = result {
		rollback(paths, &token, &had)?;
		cleanup(paths, &token)?;
		return Err(error);
	}
	cleanup(paths, &token)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::atomic::{AtomicU64, Ordering};
	static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

	fn paths() -> Paths {
		paths_at(
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos(),
		)
	}
	fn paths_at(timestamp: u128) -> Paths {
		// A clock reading is not unique, even when expressed in nanoseconds.
		// Reserve a directory exclusively so concurrent tests and stale files
		// from an earlier process can never share a fixture.
		let base = loop {
			let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
			let candidate = std::env::temp_dir().join(format!(
				"slime2-backup-{}-{timestamp}-{sequence}",
				std::process::id(),
			));
			match fs::create_dir(&candidate) {
				Ok(()) => break candidate,
				Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
					continue;
				}
				Err(error) => {
					panic!("Unable to create backup test directory: {error}")
				}
			}
		};
		Paths {
			config: base.join("config"),
			tiles: base.join("tiles"),
			media: base.join("media"),
			state: base,
		}
	}
	#[test]
	fn fixtures_with_identical_timestamps_remain_isolated() {
		let fixtures = std::thread::scope(|scope| {
			let workers: Vec<_> =
				(0..8).map(|_| scope.spawn(|| paths_at(0))).collect();
			workers
				.into_iter()
				.map(|worker| worker.join().unwrap())
				.collect::<Vec<_>>()
		});
		let dirty = &fixtures[0];
		fs::create_dir_all(&dirty.config).unwrap();
		fs::write(dirty.config.join("settings.json"), "unchanged").unwrap();

		// Model the malformed fixture used by the invalid-archive test beside
		// the empty-installation test, without relying on clock resolution.
		let empty = &fixtures[1];
		let archive = empty.state.join("empty.zip");
		let token = "00000000000000000000000000000005";
		create(empty, &archive, "1.5.0").unwrap();
		stage(empty, &archive, token).unwrap();
		schedule(empty, token).unwrap();
		apply_pending(empty).unwrap();
		assert_eq!(
			json_file(&empty.config.join("tile_locations.json")).unwrap(),
			json!({})
		);
		assert!(!empty.config.join("settings.json").exists());
		assert_eq!(
			fs::read_to_string(dirty.config.join("settings.json")).unwrap(),
			"unchanged"
		);
		assert_eq!(
			fixtures
				.iter()
				.map(|p| &p.state)
				.collect::<HashSet<_>>()
				.len(),
			fixtures.len()
		);
		for fixture in fixtures {
			fs::remove_dir_all(fixture.state).unwrap();
		}
	}
	#[test]
	fn rejects_cross_platform_escapes() {
		for name in [
			"tiles/../secret",
			"tiles/a\\b",
			"tiles/C:/x",
			"/tiles/x",
			"tiles/NUL.txt",
			"tiles/a:stream",
			"config/tokens.json",
			"config/widget_storage/../../x",
		] {
			assert!(!allowed(name), "{name}");
		}
		assert!(allowed("tiles/widget_123/core/script.js"));
	}
	#[test]
	fn round_trip_requires_reauth_and_excludes_private_config() {
		let p = paths();
		fs::create_dir_all(&p.config).unwrap();
		fs::write(
			p.config.join("accounts.json"),
			r#"{"a":{"id":"a","reauthorize":false}}"#,
		)
		.unwrap();
		fs::write(p.config.join("private.json"), "SECRET").unwrap();
		fs::write(
			p.config.join("tile_locations.json"),
			r#"{"widget_1":{"id":"widget_1","index":0,"folderId":"root"}}"#,
		)
		.unwrap();
		fs::create_dir_all(p.tiles.join("widget_1")).unwrap();
		fs::write(p.tiles.join("widget_1/script.js"), "original").unwrap();
		let archive = p.state.join("backup.zip");
		create(&p, &archive, "1.5.0").unwrap();
		let token = "00000000000000000000000000000001";
		stage(&p, &archive, token).unwrap();
		assert!(!p.stage(token).unwrap().join("config/private.json").exists());
		schedule(&p, token).unwrap();
		fs::write(p.tiles.join("widget_1/script.js"), "changed").unwrap();
		apply_pending(&p).unwrap();
		assert_eq!(
			fs::read_to_string(p.tiles.join("widget_1/script.js")).unwrap(),
			"original"
		);
		assert_eq!(
			json_file(&p.config.join("accounts.json")).unwrap()["a"]["reauthorize"],
			true
		);
		fs::remove_dir_all(p.state).unwrap();
	}
	#[test]
	fn interrupted_swap_rolls_back() {
		let p = paths();
		let token = "00000000000000000000000000000002";
		fs::create_dir_all(&p.config).unwrap();
		fs::write(p.config.join("settings.json"), "original").unwrap();
		fs::rename(&p.config, adjacent(&p.config, token, "old").unwrap())
			.unwrap();
		fs::create_dir_all(&p.config).unwrap();
		fs::write(p.config.join("settings.json"), "restored").unwrap();
		write_json(
			&p.state.join("restore-pending.json"),
			&json!({"token":token,"phase":"applying","had":[true,false,false]}),
		)
		.unwrap();
		apply_pending(&p).unwrap();
		assert_eq!(
			fs::read_to_string(p.config.join("settings.json")).unwrap(),
			"original"
		);
		fs::remove_dir_all(p.state).unwrap();
	}
	#[test]
	fn empty_installation_backup_is_restorable() {
		let p = paths();
		let archive = p.state.join("empty.zip");
		create(&p, &archive, "1.5.0").unwrap();
		let token = "00000000000000000000000000000003";
		stage(&p, &archive, token).unwrap();
		schedule(&p, token).unwrap();
		apply_pending(&p).unwrap();
		assert_eq!(
			json_file(&p.config.join("tile_locations.json")).unwrap(),
			json!({})
		);
		fs::remove_dir_all(p.state).unwrap();
	}
	#[test]
	fn invalid_archives_leave_current_files_untouched() {
		let p = paths();
		fs::create_dir_all(&p.config).unwrap();
		fs::write(p.config.join("settings.json"), "unchanged").unwrap();
		let token = "00000000000000000000000000000004";
		for entry in ["tiles/../escape", "tiles/widget_orphan/core/script.js"] {
			let archive = p.state.join("invalid.zip");
			let mut writer = ZipWriter::new(File::create(&archive).unwrap());
			let options = SimpleFileOptions::default();
			for (name, bytes) in [
				("manifest.json", r#"{"format":"slime2-backup","version":1}"#),
				("config/tile_locations.json", "{}"),
				(entry, "invalid"),
			] {
				writer.start_file(name, options).unwrap();
				writer.write_all(bytes.as_bytes()).unwrap();
			}
			writer.finish().unwrap();
			assert!(stage(&p, &archive, token).is_err());
			assert!(!p.stage(token).unwrap().exists());
			assert_eq!(
				fs::read_to_string(p.config.join("settings.json")).unwrap(),
				"unchanged"
			);
		}
		fs::remove_dir_all(p.state).unwrap();
	}
}
