use crate::{AppState, secret::get_secret, tiktok};
use serde::Deserialize;
use tauri::{AppHandle, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTokens {
	access_token: String,
}

#[tauri::command]
pub async fn start_tiktok_live(
	account_id: String,
	session_id: String,
	unique_id: String,
	app_handle: AppHandle,
	state: State<'_, AppState>,
	connections: State<'_, tiktok::TikTokConnections>,
) -> Result<(), String> {
	let stored_tokens = get_secret(state, &account_id).map_err(|_| {
		"Unable to read the TikTok API key from the credential store."
			.to_string()
	})?;
	let tokens: StoredTokens =
		serde_json::from_str(&stored_tokens).map_err(|_| {
			"The stored TikTok credentials are invalid.".to_string()
		})?;

	if tokens.access_token.trim().is_empty() {
		return Err("The stored Euler Stream API key is empty.".to_string());
	}

	connections
		.start(
			account_id,
			session_id,
			unique_id,
			tokens.access_token,
			app_handle,
		)
		.await;
	Ok(())
}

#[tauri::command]
pub async fn stop_tiktok_live(
	account_id: String,
	session_id: String,
	connections: State<'_, tiktok::TikTokConnections>,
) -> Result<(), String> {
	connections.stop(&account_id, &session_id).await;
	Ok(())
}

#[tauri::command]
pub async fn lookup_tiktok_user_id(
	account_id: String,
	username: String,
	state: State<'_, AppState>,
) -> Result<String, String> {
	let stored = get_secret(state, &account_id)
		.map_err(|_| "TIKTOK_LOOKUP_CREDENTIALS".to_string())?;
	let tokens: StoredTokens = serde_json::from_str(&stored)
		.map_err(|_| "TIKTOK_LOOKUP_CREDENTIALS".to_string())?;
	crate::tiktok_lookup::lookup_user_id(&username, &tokens.access_token).await
}
