use super::*;
use std::sync::atomic::{
	AtomicU64, Ordering
};
use zip::{
	ZipWriter, write::SimpleFileOptions
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
struct Fixture {
	root: PathBuf, paths: Paths
}
impl Fixture {
	fn new() -> Self {
		let root = std::env::temp_dir().join(format!("slime2-widget-update-{}-{}", std::process::id(),
		NEXT.fetch_add(1, Ordering::Relaxed)));
		fs::create_dir(&root).unwrap();
		let paths = Paths {
			tiles: root.join("tiles"), config: root.join("config"), state: root.join("widget-updates")
		};
		fs::create_dir(&paths.tiles).unwrap();
		fs::create_dir(&paths.config).unwrap();
		let fixture = Self {
			root, paths
		};
		for id in ["widget_left", "widget_right"] {
			let tile = fixture.paths.tiles.join(id);
			fs::create_dir_all(tile.join("core/config")).unwrap();
			fs::create_dir(tile.join("config")).unwrap();
			for (name, bytes) in package("1") {
				let destination = tile.join("core").join(name);
				fs::create_dir_all(destination.parent().unwrap()).unwrap();
				fs::write(destination, bytes).unwrap();
			}
			fs::write(tile.join("core/removed.js"), "old code").unwrap();
			fs::create_dir(tile.join("core/assets")).unwrap();
			fs::write(tile.join("core/assets/custom.png"), "saved artwork").unwrap();
			write_json(&tile.join("config/values.json"), &json!({
				"name":id,"picture":"assets/custom.png","count":5
			})).unwrap();
			fs::write(tile.join("config/meta.json"), "tile appearance").unwrap();
		}
		write_json(&fixture.paths.config.join("accounts.json"), &json!({
			"twitch_read_example": {
				"id":"twitch_read_example","service":"twitch","type":"read","displayName":"Viewer",
				"widgets":{
					"widget_left":0,"widget_right":0,"widget_other":7
				}
			},
			"youtube_read_example": {
				"id":"youtube_read_example","service":"youtube","type":"read","default":true,"widgets":{
					"widget_left":1,"widget_right":1
				}
			}
		})).unwrap();
		fs::create_dir(fixture.paths.config.join("widget_storage")).unwrap();
		fs::write(fixture.paths.config.join("widget_storage/ns-example.json"), "shared villagers").unwrap();
		fixture
	}
	fn zip(&self, version: &str) -> PathBuf {
		self.zip_entries(package(version))
	}
	fn zip_entries(&self, entries: Vec<(String, Vec<u8>)>) -> PathBuf {
		let path = self.root.join(format!("package-{}.zip", NEXT.fetch_add(1, Ordering::Relaxed)));
		let mut zip = ZipWriter::new(File::create(&path).unwrap());
		for (name, bytes) in entries {
			zip.start_file(name, SimpleFileOptions::default()).unwrap();
			zip.write_all(&bytes).unwrap();
		}
		zip.finish().unwrap();
		path
	}
	fn prepare(&self, version: &str, token: &str) -> Prepared {
		prepare(&self.paths, &self.zip(version), &["widget_left".into(), "widget_right".into()],
		token).unwrap()
	}
}
impl Drop for Fixture {
	fn drop(&mut self) {
		FAIL_AFTER.with(|cell| cell.set(None));
		let _ = fs::remove_dir_all(&self.root);
	}
}
fn package(version: &str) -> Vec<(String, Vec<u8>)> {
	let slots = if version == "1" {
		json!([{
			"service":"twitch","type":"read"
		},{
			"service":"youtube","type":"read"
		}])
	} else {
		json!([{
			"service":"youtube","type":"read"
		},{
			"service":"twitch","type":"read"
		}])
	};
	vec![
	("config/meta.json".into(), serde_json::to_vec(&json!({
		"id":"example:widget","name":"Example","creator":"Fixture","version":version,"type":["overlay"],
		"storageNamespace":"example-shared","accounts":slots,"import":{
			"js":["script.js"]
		}
	})).unwrap()),
	("config/settings.json".into(), serde_json::to_vec(&json!({
		"general":{
			"label":"General","settings":{
				"picture":{
					"type":"image-input"
				},"rows":{
					"type":"multi-section","settings":{
						"portrait":{
							"type":"image-input"
						}
					}
				}
			}
		}
	})).unwrap()),
	("index.html".into(), b"<div></div>".to_vec()),
	("script.js".into(), format!("version {version}").into_bytes()),
	]
}
fn updates() -> Value {
	json!([
	{
		"widgetId":"widget_left","values":{
			"name":"widget_left","picture":"assets/custom.png","newField":true
		},"slotMap":[1,0]
	},
	{
		"widgetId":"widget_right","values":{
			"name":"widget_right","picture":"assets/custom.png","newField":true
		},"slotMap":[1,0]
	}
	])
}
fn replace_meta(entries: &mut [(String, Vec<u8>)], f: impl FnOnce(&mut Value)) {
	let entry = entries.iter_mut().find(|(name, _)| name == "config/meta.json").unwrap();
	let mut meta: Value = serde_json::from_slice(&entry.1).unwrap();
	f(&mut meta);
	entry.1 = serde_json::to_vec(&meta).unwrap();
}
#[test]
fn updates_existing_widgets_preserve_media_tile_and_shared_data() {
	let f = Fixture::new();
	let prepared = f.prepare("2", TOKEN);
	let result = commit(&f.paths, &prepared, &updates()).unwrap();
	assert_eq!(result["widgetIds"], json!(["widget_left","widget_right"]));
	for id in ["widget_left", "widget_right"] {
		let tile = f.paths.tiles.join(id);
		assert_eq!(json_file(&tile.join("core/config/meta.json")).unwrap()["version"], "2");
		assert!(!tile.join("core/removed.js").exists());
		assert_eq!(fs::read_to_string(tile.join("core/assets/custom.png")).unwrap(), "saved artwork");
		assert_eq!(fs::read_to_string(tile.join("config/meta.json")).unwrap(), "tile appearance");
		assert_eq!(json_file(&tile.join("config/values.json")).unwrap()["newField"], true);
		assert!(status(&f.paths, id).unwrap());
	}
	assert_eq!(fs::read_to_string(f.paths.config.join("widget_storage/ns-example.json")).unwrap(),
	"shared villagers");
	let accounts = accounts(&f.paths).unwrap();
	assert_eq!(accounts["twitch_read_example"]["widgets"]["widget_left"], 1);
	assert_eq!(accounts["youtube_read_example"]["widgets"]["widget_left"], 0);
	assert_eq!(accounts["twitch_read_example"]["widgets"]["widget_other"], 7);
	assert_eq!(result["accountSlots"]["widget_left"]["youtube_read_example"], 0);
}
#[test]
fn undo_restores_only_target_widget_and_its_slots_in_latest_accounts() {
	let f = Fixture::new();
	let prepared = f.prepare("2", TOKEN);
	commit(&f.paths, &prepared, &updates()).unwrap();
	discard(prepared).unwrap();
	let mut saved = accounts(&f.paths).unwrap();
	saved["twitch_read_example"]["displayName"] = json!("Renamed since update");
	saved["twitch_read_example"]["widgets"]["widget_other"] = json!(9);
	saved["youtube_read_example"]["default"] = json!(false);
	saved["new_account"] = json!({
		"service":"twitch","type":"read","widgets":{
			"widget_left":1,"widget_else":3
		}
	});
	write_json(&f.paths.config.join("accounts.json"), &saved).unwrap();
	let restored = restore(&f.paths, "widget_left", TOKEN_2).unwrap();
	assert_eq!(restored["meta"]["version"], "1");
	assert_eq!(restored["values"]["count"], 5);
	assert_eq!(restored["accountSlots"]["twitch_read_example"], 0);
	let saved = accounts(&f.paths).unwrap();
	assert_eq!(saved["twitch_read_example"]["displayName"], "Renamed since update");
	assert_eq!(saved["twitch_read_example"]["widgets"]["widget_other"], 9);
	assert_eq!(saved["twitch_read_example"]["widgets"]["widget_right"], 1);
	assert_eq!(saved["youtube_read_example"]["default"], false);
	assert!(saved["new_account"]["widgets"].get("widget_left").is_none());
	assert_eq!(saved["new_account"]["widgets"]["widget_else"], 3);
	assert!(!status(&f.paths,"widget_left").unwrap());
	assert!(status(&f.paths,"widget_right").unwrap());
}
#[test]
fn every_partial_batch_rename_is_reversed_including_accounts_and_backups() {
	// Two targets: core old/new, values old/new, backup promotion each, then accounts old/new.
	for fail_after in 1..=12 {
		let f = Fixture::new();
		let prepared = f.prepare("2", TOKEN);
		let original_accounts = fs::read(f.paths.config.join("accounts.json")).unwrap();
		FAIL_AFTER.with(|cell| cell.set(Some(fail_after)));
		assert!(commit(&f.paths, &prepared, &updates()).is_err(), "failure {fail_after}");
		FAIL_AFTER.with(|cell| cell.set(None));
		for id in ["widget_left","widget_right"] {
			let tile = f.paths.tiles.join(id);
			assert_eq!(json_file(&tile.join("core/config/meta.json")).unwrap()["version"], "1",
			"failure {fail_after}");
			assert_eq!(json_file(&tile.join("config/values.json")).unwrap()["count"], 5);
			assert!(!status(&f.paths,id).unwrap());
		}
		assert_eq!(fs::read(f.paths.config.join("accounts.json")).unwrap(), original_accounts);
	}
}
#[test]
fn failed_later_update_retains_previous_undo() {
	let f = Fixture::new();
	let prepared = f.prepare("2", TOKEN);
	commit(&f.paths,&prepared,&updates()).unwrap();
	discard(prepared).unwrap();
	let prepared = f.prepare("3",TOKEN_2);
	let mut next = updates();
	for value in next.as_array_mut().unwrap() {
		value["slotMap"] = json!([0,1]);
	}
	FAIL_AFTER.with(|cell| cell.set(Some(6)));
	assert!(commit(&f.paths,&prepared,&next).is_err());
	FAIL_AFTER.with(|cell| cell.set(None));
	assert_eq!(json_file(&f.paths.state.join("backups/widget_left/core/config/meta.json")).unwrap()["version"],
	"1");
	assert_eq!(json_file(&f.paths.tiles.join("widget_left/core/config/meta.json")).unwrap()["version"],
	"2");
}
#[test]
fn stale_values_core_or_stage_cannot_be_committed() {
	for target in ["values", "core", "stage"] {
		let f = Fixture::new();
		let prepared = f.prepare("2", TOKEN);
		match target {
			"values" => fs::write(f.paths.tiles.join("widget_left/config/values.json"), "{\"newer\":true}").unwrap(),
			"core" => fs::write(f.paths.tiles.join("widget_right/core/script.js"), "newer local code").unwrap(),
			_ => fs::write(prepared.stage.join("core/script.js"), "tampered stage").unwrap(),
		}
		assert!(commit(&f.paths,&prepared,&updates()).is_err());
		assert_eq!(json_file(&f.paths.tiles.join("widget_left/core/config/meta.json")).unwrap()["version"],
		"1");
		assert!(!status(&f.paths,"widget_left").unwrap());
	}
}
#[test]
fn exact_targets_and_compatible_unique_account_slots_are_required() {
	for mode in ["missing", "duplicate", "unknown", "service", "target-duplicate", "negative"] {
		let f = Fixture::new();
		let prepared = f.prepare("2", TOKEN);
		let mut data = updates();
		match mode {
			"missing" => {
				data.as_array_mut().unwrap().pop();
			},
			"duplicate" => data[1]["widgetId"] = json!("widget_left"),
			"unknown" => data[0]["widgetId"] = json!("widget_nonexistent"),
			"service" => data[0]["slotMap"] = json!([0,1]),
			"target-duplicate" => data[0]["slotMap"] = json!([1,1]),
			_ => data[0]["slotMap"] = json!([-1,0]),
		}
		assert!(commit(&f.paths,&prepared,&data).is_err(),"{mode}");
		assert_eq!(json_file(&f.paths.tiles.join("widget_left/core/config/meta.json")).unwrap()["version"],
		"1");
	}
}
#[test]
fn package_family_namespace_and_required_imports_are_checked() {
	for mode in ["family","namespace","missing-import","empty-id"] {
		let f = Fixture::new();
		let mut entries = package("2");
		match mode {
			"family" => replace_meta(&mut entries,|m| m["id"] = json!("other:widget")),
			"namespace" => replace_meta(&mut entries,|m| m["storageNamespace"] = json!("changed")),
			"empty-id" => replace_meta(&mut entries,|m| m["id"] = json!("")),
			_ => entries.retain(|(name,_)| name != "script.js"),
		}
		assert!(prepare(&f.paths,&f.zip_entries(entries),&["widget_left".into()],TOKEN).is_err(),
		"{mode}");
		assert!(!f.paths.state.join(format!("stage-{TOKEN}")).exists());
	}
}
#[test]
fn archive_paths_reject_traversal_device_names_and_case_collisions() {
	for names in [vec!["../escaped"],vec!["/absolute"],vec!["C:/drive"],vec!["config/CON"],
	vec!["assets/a.png","Assets/b.png"],vec!["path","path/nested"],vec!["script.JS"]] {
		let f = Fixture::new();
		let mut entries = package("2");
		entries.extend(names.iter().map(|name| (name.to_string(),b"bad".to_vec())));
		assert!(prepare(&f.paths,&f.zip_entries(entries),&["widget_left".into()],TOKEN).is_err(),
		"{names:?}");
		assert!(!f.root.join("escaped").exists());
	}
}
#[test]
fn core_media_in_multisections_is_preserved_and_missing_media_blocks_commit() {
	let f = Fixture::new();
	let prepared = f.prepare("2", TOKEN);
	let mut data = updates();
	data[0]["values"] = json!({
		"rows":["custom-1"],"custom-1.portrait":"assets/custom.png"
	});
	commit(&f.paths,&prepared,&data).unwrap();
	assert!(f.paths.tiles.join("widget_left/core/assets/custom.png").exists());
	let f = Fixture::new();
	let prepared = f.prepare("2", TOKEN);
	let mut data = updates();
	data[0]["values"]["picture"] = json!("assets/missing.png");
	assert!(commit(&f.paths,&prepared,&data).is_err());
	assert_eq!(json_file(&f.paths.tiles.join("widget_left/core/config/meta.json")).unwrap()["version"],
	"1");
}
#[test]
fn missing_original_values_and_accounts_stay_valid_and_undo_restores_absence() {
	let f = Fixture::new();
	fs::remove_file(f.paths.tiles.join("widget_left/config/values.json")).unwrap();
	fs::remove_file(f.paths.config.join("accounts.json")).unwrap();
	let prepared = f.prepare("2",TOKEN);
	commit(&f.paths,&prepared,&updates()).unwrap();
	discard(prepared).unwrap();
	restore(&f.paths,"widget_left",TOKEN_2).unwrap();
	assert!(!f.paths.tiles.join("widget_left/config/values.json").exists());
	assert_eq!(accounts(&f.paths).unwrap(),json!({}));
}
#[cfg(unix)]
#[test]
fn installed_symlink_core_and_zip_symlinks_are_rejected() {
	let f = Fixture::new();
	std::os::unix::fs::symlink(f.root.join("outside"),f.paths.tiles.join("widget_left/core/link")).unwrap();
	assert!(prepare(&f.paths,&f.zip("2"),&["widget_left".into()],TOKEN).is_err());
	fs::remove_file(f.paths.tiles.join("widget_left/core/link")).unwrap();
	let path = f.root.join("symlink.zip");
	let mut zip = ZipWriter::new(File::create(&path).unwrap());
	zip.add_symlink("link","../outside",SimpleFileOptions::default()).unwrap();
	zip.finish().unwrap();
	assert!(prepare(&f.paths,&path,&["widget_left".into()],TOKEN).is_err());
}
#[test]
fn interrupted_process_recovery_reverses_logged_moves_and_unexecuted_intent() {
	let f = Fixture::new();
	let prepared = f.prepare("2",TOKEN);
	let work = prepared.stage.join("widget_left");
	fs::create_dir(&work).unwrap();
	let next_core = work.join("next-core");
	copy_tree(&prepared.stage.join("core"),&next_core).unwrap();
	let core = f.paths.tiles.join("widget_left/core");
	let mut journal = Journal {
		file:prepared.stage.join("transaction.json"),entries:Vec::new()
	};
	move_recorded(&f.paths,&core,&work.join("old-core"),&mut journal).unwrap();
	move_recorded(&f.paths,&next_core,&core,&mut journal).unwrap();
	// Crash after writing a rename intent, immediately before the rename itself.
	journal.entries.push((f.paths.tiles.join("widget_left/config/values.json"),work.join("old-values.json")));
	persist_journal(&f.paths,&journal,false).unwrap();
	recover(&f.paths).unwrap();
	assert_eq!(json_file(&core.join("config/meta.json")).unwrap()["version"],"1");
	assert_eq!(json_file(&f.paths.tiles.join("widget_left/config/values.json")).unwrap()["count"],
	5);
	assert!(!prepared.stage.exists());
	recover(&f.paths).unwrap();
	// Recovery is idempotent across another restart.
}
#[test]
fn finalized_transaction_recovery_keeps_update_and_undo() {
	let f = Fixture::new();
	let prepared = f.prepare("2",TOKEN);
	commit(&f.paths,&prepared,&updates()).unwrap();
	// A crash before cleanup must not roll back a committed update.
	recover(&f.paths).unwrap();
	assert_eq!(json_file(&f.paths.tiles.join("widget_left/core/config/meta.json")).unwrap()["version"],
	"2");
	assert!(status(&f.paths,"widget_left").unwrap());
	assert!(!prepared.stage.exists());
}
#[test]
fn recovery_rejects_paths_outside_the_recorded_transaction() {
	let f = Fixture::new();
	let stage = stage_path(&f.paths,TOKEN).unwrap();
	fs::create_dir(&stage).unwrap();
	write_json(&stage.join("transaction.json"),&json!({
		"version":1,"finished":false,"moves":[{
			"from":{
				"root":"config","path":"accounts.json"
			},"to":{
				"root":"config","path":"settings.json"
			}
		}]
	})).unwrap();
	assert!(recover(&f.paths).is_err());
	assert!(f.paths.config.join("accounts.json").is_file());
}
