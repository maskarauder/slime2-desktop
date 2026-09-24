use crate::session_tasks::{guard_reader, SessionTasks};
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, timeout, Duration};
use tokio_tungstenite::{
	connect_async_with_config,
	tungstenite::{
		protocol::WebSocketConfig, Error as WebSocketError, Message,
	},
	WebSocketStream,
};
use url::Url;

const EULER_STREAM_WEBSOCKET_URL: &str = "wss://ws.eulerstream.com";
const OFFLINE_RETRY_DELAY: Duration = Duration::from_secs(300);
const ERROR_RETRY_DELAY: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_PROBE_DELAY: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct TikTokConnections {
	tasks: SessionTasks,
}

impl TikTokConnections {
	pub async fn start(
		&self,
		account_id: String,
		session_id: String,
		unique_id: String,
		api_key: String,
		app_handle: AppHandle,
	) {
		let task_account_id = account_id.clone();
		let task_session_id = session_id.clone();
		self.tasks
			.replace(account_id, session_id, || {
				tokio::spawn(async move {
					loop {
						if guard_reader(consume_live_chat(
							task_account_id.clone(),
							task_session_id.clone(),
							unique_id.clone(),
							api_key.clone(),
							app_handle.clone(),
						))
						.await
						.is_ok()
						{
							break;
						}
						// The task used to die silently, leaving the UI stuck at
						// "connecting" forever. Do not expose a panic's payload:
						// library errors can contain the authenticated URL.
						log::error!("TikTok LIVE reader stopped unexpectedly; retrying in five minutes.");
						emit_status(
							&app_handle,
							&task_account_id,
							&task_session_id,
							"reconnecting",
							None,
							Some("The native TikTok reader stopped unexpectedly; retrying in five minutes.".into()),
						);
						sleep(ERROR_RETRY_DELAY).await;
					}
				})
			})
			.await;
	}
	pub async fn stop(&self, account_id: &str, session_id: &str) {
		self.tasks.stop(account_id, session_id).await;
	}
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TikTokMessagePayload {
	account_id: String,
	session_id: String,
	message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TikTokStatusPayload {
	account_id: String,
	session_id: String,
	state: String,
	code: Option<u16>,
	message: Option<String>,
	retry_after_ms: Option<u64>,
}

async fn consume_live_chat(
	account_id: String,
	session_id: String,
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
				&session_id,
				"error",
				None,
				Some(message),
			);
			return;
		}
	};

	loop {
		log::info!("TikTok LIVE connection attempt starting.");
		emit_status(
			&app_handle,
			&account_id,
			&session_id,
			"connecting",
			None,
			None,
		);

		let connection =
			match timeout(
				CONNECT_TIMEOUT,
				connect_async_with_config(
					websocket_url.as_str(),
					Some(
						WebSocketConfig::default()
							.max_message_size(Some(1024 * 1024))
							.max_frame_size(Some(1024 * 1024)),
					),
					false,
				),
			)
			.await
			{
				Ok(result) => result,
				Err(_) => {
					emit_status(
					&app_handle,
					&account_id,
					&session_id,
					"reconnecting",
					None,
					Some("Euler Stream connection timed out after 30 seconds.".to_string()),
				);
					sleep(ERROR_RETRY_DELAY).await;
					continue;
				}
			};
		let (mut websocket, _) = match connection {
			Ok(connection) => connection,
			Err(error) => {
				let status = websocket_error_status(&error);
				if matches!(status, Some(401 | 403)) {
					emit_status(
						&app_handle,
						&account_id,
						&session_id,
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
					&session_id,
					"reconnecting",
					status,
					Some(websocket_error_message(&error).to_string()),
				);
				sleep(ERROR_RETRY_DELAY).await;
				continue;
			}
		};

		emit_status(
			&app_handle,
			&account_id,
			&session_id,
			"connected",
			None,
			None,
		);

		let mut close_code = None;
		let mut close_reason = None;

		loop {
			let message = match read_live_message(
				&mut websocket,
				IDLE_PROBE_DELAY,
				PROBE_TIMEOUT,
			)
			.await
			{
				Ok(Some(message)) => message,
				Ok(None) => break,
				Err(reason) => {
					close_reason = Some(reason.to_string());
					break;
				}
			};
			match message {
				Message::Text(message) => {
					emit_message(
						&app_handle,
						&account_id,
						&session_id,
						message.to_string(),
					);
				}
				Message::Binary(message) => {
					if let Ok(message) = String::from_utf8(message.to_vec()) {
						emit_message(
							&app_handle,
							&account_id,
							&session_id,
							message,
						);
					}
				}
				Message::Ping(payload) => {
					if !matches!(
						timeout(
							WRITE_TIMEOUT,
							websocket.send(Message::Pong(payload))
						)
						.await,
						Ok(Ok(())),
					) {
						close_reason = Some(
							"Unable to send the Euler Stream heartbeat reply."
								.to_string(),
						);
						break;
					}
				}
				Message::Close(frame) => {
					if let Some(frame) = frame {
						close_code = Some(u16::from(frame.code));
						if !frame.reason.is_empty() {
							close_reason = Some(frame.reason.to_string());
						}
					}
					break;
				}
				_ => {}
			}
		}
		// Dispose of the old transport before waiting and opening another one.
		drop(websocket);

		match close_code {
			Some(4401 | 4403) => {
				emit_status(
					&app_handle,
					&account_id,
					&session_id,
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
					&session_id,
					"error",
					close_code,
					close_reason.or_else(|| {
						Some(
							"Euler Stream rejected the connection options."
								.to_string(),
						)
					}),
				);
				return;
			}
			Some(4005 | 4006 | 4404) => {
				emit_status(
					&app_handle,
					&account_id,
					&session_id,
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
					&session_id,
					"reconnecting",
					close_code,
					close_reason,
				);
				sleep(ERROR_RETRY_DELAY).await;
			}
		}
	}
}

// Quiet chat is normal. Probe the WebSocket after a period with no frames,
// then reconnect only if the peer also fails to answer the protocol ping.
// Any received frame confirms the inbound transport is still working.
async fn read_live_message<S>(
	websocket: &mut WebSocketStream<S>,
	idle_delay: Duration,
	probe_timeout: Duration,
) -> Result<Option<Message>, &'static str>
where
	S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
	let result = match timeout(idle_delay, websocket.next()).await {
		Ok(result) => result,
		Err(_) => {
			if !matches!(
				timeout(
					WRITE_TIMEOUT,
					websocket.send(Message::Ping(Vec::<u8>::new().into())),
				)
				.await,
				Ok(Ok(())),
			) {
				return Err("Unable to send an Euler Stream heartbeat probe.");
			}
			timeout(probe_timeout, websocket.next())
				.await
				.map_err(|_| {
					"Euler Stream heartbeat timed out; reconnecting."
				})?
		}
	};
	result
		.transpose()
		.map_err(|_| "Euler Stream transport failed; reconnecting.")
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

fn websocket_error_message(error: &WebSocketError) -> &'static str {
	// Keep credentials and provider-controlled response bodies out of logs.
	match error {
		WebSocketError::Tls(_) => "Euler Stream TLS handshake failed.",
		WebSocketError::Io(_) => {
			"Euler Stream network connection failed (DNS, TCP or socket I/O)."
		}
		WebSocketError::Http(_) => {
			"Euler Stream rejected the WebSocket handshake."
		}
		WebSocketError::Protocol(_) => {
			"Euler Stream WebSocket protocol negotiation failed."
		}
		_ => "Unable to connect to Euler Stream.",
	}
}

fn emit_message(
	app_handle: &AppHandle,
	account_id: &str,
	session_id: &str,
	message: String,
) {
	if let Err(error) = app_handle.emit(
		"tiktok-live-message",
		TikTokMessagePayload {
			account_id: account_id.to_string(),
			session_id: session_id.to_string(),
			message,
		},
	) {
		log::error!("Unable to emit a TikTok LIVE message: {error}");
	}
}

fn emit_status(
	app_handle: &AppHandle,
	account_id: &str,
	session_id: &str,
	state: &str,
	code: Option<u16>,
	message: Option<String>,
) {
	if let Err(error) = app_handle.emit(
		"tiktok-live-status",
		TikTokStatusPayload {
			account_id: account_id.to_string(),
			session_id: session_id.to_string(),
			state: state.to_string(),
			retry_after_ms: match state {
				"offline" => Some(OFFLINE_RETRY_DELAY.as_millis() as u64),
				"reconnecting" => Some(ERROR_RETRY_DELAY.as_millis() as u64),
				_ => None,
			},
			code,
			message,
		},
	) {
		log::error!("Unable to emit TikTok LIVE connection status: {error}");
	}
}
