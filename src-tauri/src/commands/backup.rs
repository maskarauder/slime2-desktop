use crate::{backup, file};
use serde_json::Value;
use std::{
	path::PathBuf,
	sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, State};
#[derive(Default)]
pub struct RestoreState(Arc<Mutex<Option<String>>>);
pub fn paths(app: &AppHandle) -> Result<backup::Paths, String> {
	Ok(backup::Paths {
		config: file::config_path(app),
		tiles: file::tiles_path(app),
		media: file::media_files_path(app),
		state: app
			.path()
			.app_data_dir()
			.map_err(|_| "Unable to locate app data.")?,
	})
}
#[tauri::command]
pub async fn export_app_backup(
	app: AppHandle,
	destination: String,
) -> Result<(), String> {
	let paths = paths(&app)?;
	let version = app.package_info().version.to_string();
	tokio::task::spawn_blocking(move || {
		backup::create(&paths, &PathBuf::from(destination), &version)
			.map_err(|e| format!("Backup failed: {e}"))
	})
	.await
	.map_err(|_| "Backup task stopped.")?
}
#[tauri::command]
pub async fn preview_app_restore(
	app: AppHandle,
	source: String,
	state: State<'_, RestoreState>,
) -> Result<Value, String> {
	let paths = paths(&app)?;
	let state = state.0.clone();
	tokio::task::spawn_blocking(move || {
		let mut prepared =
			state.lock().map_err(|_| "Restore state is unavailable.")?;
		std::fs::create_dir_all(&paths.state)
			.map_err(|_| "Unable to create restore staging directory.")?;
		let token = nanoid::nanoid!(
			32,
			&[
				'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b',
				'c', 'd', 'e', 'f'
			]
		);
		let preview = backup::stage(&paths, &PathBuf::from(source), &token)
			.map_err(|e| format!("Cannot restore this backup: {e}"))?;
		if let Some(old) = prepared.replace(token) {
			let _ = std::fs::remove_dir_all(
				paths.stage(&old).map_err(|e| e.to_string())?,
			);
		}
		Ok(preview)
	})
	.await
	.map_err(|_| "Restore preview stopped.")?
}
#[tauri::command]
pub async fn cancel_app_restore(
	app: AppHandle,
	token: String,
	state: State<'_, RestoreState>,
) -> Result<(), String> {
	let paths = paths(&app)?;
	let state = state.0.clone();
	tokio::task::spawn_blocking(move || {
		let mut prepared =
			state.lock().map_err(|_| "Restore state is unavailable.")?;
		if prepared.as_deref() == Some(&token) {
			std::fs::remove_dir_all(
				paths.stage(&token).map_err(|e| e.to_string())?,
			)
			.map_err(|e| format!("Unable to remove restore preview: {e}"))?;
			prepared.take();
		}
		Ok(())
	})
	.await
	.map_err(|_| "Restore cleanup stopped.")?
}
#[tauri::command]
pub async fn restore_app_backup(
	app: AppHandle,
	token: String,
	state: State<'_, RestoreState>,
) -> Result<(), String> {
	let paths = paths(&app)?;
	{
		let mut prepared = state
			.0
			.lock()
			.map_err(|_| "Restore state is unavailable.")?;
		if prepared.as_deref() != Some(&token) {
			return Err("Preview the backup again before restoring.".into());
		}
		backup::schedule(&paths, &token)
			.map_err(|e| format!("Unable to schedule restore: {e}"))?;
		prepared.take();
	}
	app.restart();
}
