use futures::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tokio::{
	sync::Mutex,
	task::JoinHandle,
	time::{Duration, sleep},
};
use tokio_tungstenite::{
	connect_async,
	tungstenite::{Error as WebSocketError, Message},
};
use url::Url;

const EULER_STREAM_WEBSOCKET_URL: &str = "wss://ws.eulerstream.com";
const OFFLINE_RETRY_DELAY: Duration = Duration::from_secs(60);
const ERROR_RETRY_DELAY: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct TikTokConnections {
	tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl TikTokConnections {
	pub async fn start(
		&self,
		account_id: String,
		unique_id: String,
		api_key: String,
		app_handle: AppHandle,
	) {
		self.stop(&account_id).await;

		let task_account_id = account_id.clone();
		let task = tokio::spawn(async move {
			consume_live_chat(task_account_id, unique_id, api_key, app_handle)
				.await;
		});

		self.tasks.lock().await.insert(account_id, task);
	}

	pub async fn stop(&self, account_id: &str) {
		if let Some(task) = self.tasks.lock().await.remove(account_id) {
			task.abort();
		}
	}
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TikTokMessagePayload {
	account_id: String,
	message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TikTokStatusPayload {
	account_id: String,
	state: String,
	code: Option<u16>,
	message: Option<String>,
}

async fn consume_live_chat(
	account_id: String,
	unique_id: String,
	api_key: String,
	app_handle: AppHandle,
) {
	let websocket_url = match build_websocket_url(&unique_id, &api_key) {
		Ok(url) => url,
		Err(message) => {
			emit_status(
				&app_handle,
				&account_id,
				"error",
				None,
				Some(message),
			);
			return;
		}
	};

	loop {
		emit_status(
			&app_handle,
			&account_id,
			"connecting",
			None,
			None,
		);

		let (mut websocket, _) = match connect_async(websocket_url.as_str()).await {
			Ok(connection) => connection,
			Err(error) => {
				let status = websocket_error_status(&error);
				if matches!(status, Some(401 | 403)) {
					emit_status(
						&app_handle,
						&account_id,
						"reauthorize",
						status,
						Some(
							"Euler Stream rejected the API key or account permissions."
								.to_string(),
						),
					);
					return;
				}

				emit_status(
					&app_handle,
					&account_id,
					"reconnecting",
					status,
					Some("Unable to connect to Euler Stream.".to_string()),
				);
				sleep(ERROR_RETRY_DELAY).await;
				continue;
			}
		};

		emit_status(
			&app_handle,
			&account_id,
			"connected",
			None,
			None,
		);

		let mut close_code = None;
		let mut close_reason = None;

		while let Some(result) = websocket.next().await {
			match result {
				Ok(Message::Text(message)) => {
					emit_message(
						&app_handle,
						&account_id,
						message.to_string(),
					);
				}
				Ok(Message::Binary(message)) => {
					if let Ok(message) = String::from_utf8(message.to_vec()) {
						emit_message(&app_handle, &account_id, message);
					}
				}
				Ok(Message::Ping(payload)) => {
					if websocket.send(Message::Pong(payload)).await.is_err() {
						break;
					}
				}
				Ok(Message::Close(frame)) => {
					if let Some(frame) = frame {
						close_code = Some(u16::from(frame.code));
						if !frame.reason.is_empty() {
							close_reason = Some(frame.reason.to_string());
						}
					}
					break;
				}
				Ok(_) => {}
				Err(_) => break,
			}
		}

		match close_code {
			Some(4401 | 4403) => {
				emit_status(
					&app_handle,
					&account_id,
					"reauthorize",
					close_code,
					close_reason.or_else(|| {
						Some(
							"Euler Stream rejected the API key or account permissions."
								.to_string(),
						)
					}),
				);
				return;
			}
			Some(4400) => {
				emit_status(
					&app_handle,
					&account_id,
					"error",
					close_code,
					close_reason.or_else(|| {
						Some("Euler Stream rejected the connection options.".to_string())
					}),
				);
				return;
			}
			Some(4005 | 4404) => {
				emit_status(
					&app_handle,
					&account_id,
					"offline",
					close_code,
					close_reason,
				);
				sleep(OFFLINE_RETRY_DELAY).await;
			}
			_ => {
				emit_status(
					&app_handle,
					&account_id,
					"reconnecting",
					close_code,
					close_reason,
				);
				sleep(ERROR_RETRY_DELAY).await;
			}
		}
	}
}

fn build_websocket_url(unique_id: &str, api_key: &str) -> Result<Url, String> {
	let normalized_unique_id = unique_id
		.trim()
		.trim_start_matches('@')
		.trim_end_matches("/live")
		.trim();

	if normalized_unique_id.is_empty() {
		return Err("TikTok username cannot be empty.".to_string());
	}
	if api_key.trim().is_empty() {
		return Err("Euler Stream API key cannot be empty.".to_string());
	}

	let mut url = Url::parse(EULER_STREAM_WEBSOCKET_URL)
		.map_err(|error| format!("Invalid Euler Stream URL: {error}"))?;
	url.query_pairs_mut()
		.append_pair("uniqueId", normalized_unique_id)
		.append_pair("apiKey", api_key.trim())
		.append_pair("features.bundleEvents", "false")
		.append_pair("features.schemaVersion", "v2")
		.append_pair("features.normalizeUniqueId", "true");
	Ok(url)
}

fn websocket_error_status(error: &WebSocketError) -> Option<u16> {
	match error {
		WebSocketError::Http(response) => Some(response.status().as_u16()),
		_ => None,
	}
}

fn emit_message(app_handle: &AppHandle, account_id: &str, message: String) {
	if let Err(error) = app_handle.emit(
		"tiktok-live-message",
		TikTokMessagePayload {
			account_id: account_id.to_string(),
			message,
		},
	) {
		log::error!("Unable to emit a TikTok LIVE message: {error}");
	}
}

fn emit_status(
	app_handle: &AppHandle,
	account_id: &str,
	state: &str,
	code: Option<u16>,
	message: Option<String>,
) {
	if let Err(error) = app_handle.emit(
		"tiktok-live-status",
		TikTokStatusPayload {
			account_id: account_id.to_string(),
			state: state.to_string(),
			code,
			message,
		},
	) {
		log::error!("Unable to emit TikTok LIVE connection status: {error}");
	}
}
