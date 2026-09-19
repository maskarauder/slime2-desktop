use slime2_youtube_stream::{StreamError, YouTubeStreams};
use tauri::State;

#[tauri::command]
pub async fn open_youtube_chat_stream(
	account_id: String,
	session_id: String,
	access_token: String,
	live_chat_id: String,
	page_token: Option<String>,
	streams: State<'_, YouTubeStreams>,
) -> Result<(), StreamError> {
	streams
		.open(
			account_id,
			session_id,
			access_token,
			live_chat_id,
			page_token,
		)
		.await
}

#[tauri::command]
pub async fn next_youtube_chat_batch(
	account_id: String,
	session_id: String,
	streams: State<'_, YouTubeStreams>,
) -> Result<Option<serde_json::Value>, StreamError> {
	streams.next(&account_id, &session_id).await
}

#[tauri::command]
pub fn close_youtube_chat_stream(
	account_id: String,
	session_id: String,
	streams: State<'_, YouTubeStreams>,
) {
	streams.close(&account_id, &session_id);
}
