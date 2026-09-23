use std::{
	fs::File,
	io::{Read, Seek, SeekFrom},
};
use tauri::{AppHandle, Manager};
#[tauri::command]
pub async fn read_recent_log(app: AppHandle) -> Result<String, String> {
	let path = app
		.path()
		.app_log_dir()
		.map_err(|_| "Unable to locate logs.")?
		.join(format!("{}.log", crate::get_log_file_name()));
	tokio::task::spawn_blocking(move || {
		let mut file =
			File::open(path).map_err(|_| "Unable to open the current log.")?;
		let start = file
			.metadata()
			.map_err(|_| "Unable to read log metadata.")?
			.len()
			.saturating_sub(512 * 1024);
		file.seek(SeekFrom::Start(start))
			.map_err(|_| "Unable to read log tail.")?;
		let mut bytes = Vec::new();
		file.take(512 * 1024)
			.read_to_end(&mut bytes)
			.map_err(|_| "Unable to read log tail.")?;
		let text = String::from_utf8_lossy(&bytes).into_owned();
		Ok(if start > 0 {
			text.split_once('\n')
				.map(|(_, tail)| tail.to_owned())
				.unwrap_or_default()
		} else {
			text
		})
	})
	.await
	.map_err(|_| "Log reader stopped.".to_string())?
}
