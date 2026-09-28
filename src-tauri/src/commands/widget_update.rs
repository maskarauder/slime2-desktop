//! App-owned, expiring ZIP previews. Tokens never contain caller-selected paths.
use crate::{file, widget_update};
use nanoid::nanoid;
use serde_json::Value;
use std::{
	collections::HashMap,
	path::Path,
	sync::{Mutex, OnceLock},
	time::{Duration, Instant},
};
use tauri::AppHandle;

const EXPIRY: Duration = Duration::from_secs(15 * 60);
const MAX_PREVIEWS: usize = 8;
struct Preview {
	created: Instant,
	prepared: widget_update::Prepared,
}
static PREVIEWS: OnceLock<Mutex<HashMap<String, Preview>>> = OnceLock::new();
fn previews() -> &'static Mutex<HashMap<String, Preview>> {
	PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn paths(app: &AppHandle) -> widget_update::Paths {
	let tiles = file::tiles_path(app);
	let state = tiles
		.parent()
		.expect("Tiles directory has no parent")
		.join("widget-updates");
	widget_update::Paths {
		tiles,
		config: file::config_path(app),
		state,
	}
}
pub fn recover_pending(app: &AppHandle) -> Result<(), String> {
	widget_update::recover(&paths(app)).map_err(|error| error.to_string())
}
fn expire(pending: &mut HashMap<String, Preview>) {
	let expired: Vec<_> = pending
		.iter()
		.filter(|(_, value)| value.created.elapsed() > EXPIRY)
		.map(|(key, _)| key.clone())
		.collect();
	for key in expired {
		if let Some(preview) = pending.remove(&key) {
			let _ = widget_update::discard(preview.prepared);
		}
	}
}
#[tauri::command]
pub async fn prepare_widget_update(
	zip_path: String,
	widget_ids: Vec<String>,
	app_handle: AppHandle,
) -> Result<Value, String> {
	let paths = paths(&app_handle);
	tauri::async_runtime::spawn_blocking(move || {
		let mut pending = previews().lock().map_err(|_| {
			"Widget updater is unavailable. Restart Slime2.".to_string()
		})?;
		expire(&mut pending);
		widget_update::recover(&paths).map_err(|error| error.to_string())?;
		if pending.len() >= MAX_PREVIEWS {
			return Err(
				"Too many widget previews are open. Close one and retry."
					.to_string(),
			);
		}
		let token = nanoid!(32);
		let prepared = widget_update::prepare(
			&paths,
			Path::new(&zip_path),
			&widget_ids,
			&token,
		)
		.map_err(|error| error.to_string())?;
		let response = prepared.response.clone();
		pending.insert(
			token,
			Preview {
				created: Instant::now(),
				prepared,
			},
		);
		Ok(response)
	})
	.await
	.map_err(|_| "Widget update task failed.".to_string())?
}
#[tauri::command]
pub async fn commit_widget_update(
	token: String,
	updates: Value,
	app_handle: AppHandle,
) -> Result<Value, String> {
	let paths = paths(&app_handle);
	tauri::async_runtime::spawn_blocking(move || {
		let mut pending = previews().lock().map_err(|_| {
			"Widget updater is unavailable. Restart Slime2.".to_string()
		})?;
		expire(&mut pending);
		let preview = pending.remove(&token).ok_or_else(|| {
			"Widget preview expired. Select the ZIP again.".to_string()
		})?;
		let result = widget_update::commit(&paths, &preview.prepared, &updates)
			.map_err(|error| error.to_string());
		if result.as_ref().err().is_none_or(|error| {
			!error.contains("rollback could not finish")
		}) {
			let _ = widget_update::discard(preview.prepared);
		}
		result
	})
	.await
	.map_err(|_| "Widget update task failed.".to_string())?
}
#[tauri::command]
pub async fn discard_widget_update(
	token: String,
) -> Result<(), String> {
	tauri::async_runtime::spawn_blocking(move || {
		let mut pending = previews().lock().map_err(|_| {
			"Widget updater is unavailable. Restart Slime2.".to_string()
		})?;
		if let Some(preview) = pending.remove(&token) {
			widget_update::discard(preview.prepared)
				.map_err(|error| error.to_string())?;
		}
		Ok(())
	})
	.await
	.map_err(|_| "Widget update task failed.".to_string())?
}
#[tauri::command]
pub async fn get_widget_update_status(
	widget_id: String,
	app_handle: AppHandle,
) -> Result<bool, String> {
	let paths = paths(&app_handle);
	tauri::async_runtime::spawn_blocking(move || {
		let _guard = previews().lock().map_err(|_| {
			"Widget updater is unavailable. Restart Slime2.".to_string()
		})?;
		widget_update::status(&paths, &widget_id).map_err(|e| e.to_string())
	})
	.await
	.map_err(|_| "Widget update task failed.".to_string())?
}
#[tauri::command]
pub async fn restore_widget_update(
	widget_id: String,
	app_handle: AppHandle,
) -> Result<Value, String> {
	let paths = paths(&app_handle);
	tauri::async_runtime::spawn_blocking(move || {
		let _guard = previews().lock().map_err(|_| {
			"Widget updater is unavailable. Restart Slime2.".to_string()
		})?;
		widget_update::recover(&paths).map_err(|error| error.to_string())?;
		widget_update::restore(&paths, &widget_id, &nanoid!(32))
			.map_err(|error| error.to_string())
	})
	.await
	.map_err(|_| "Widget update task failed.".to_string())?
}
