use crate::{
	AppState,
	secret::{delete_secret, get_secret, set_secret},
};
use tauri::State;

#[tauri::command]
pub async fn get_secret_key(
	state: State<'_, AppState>,
	key: &str,
) -> Result<String, String> {
	return match get_secret(state, key) {
		Ok(entry) => Ok(entry),
		Err(error) => {
			let error_message =
				format!("Error getting secret key ({}): {}", key, error);
			log::error!("{}", error_message);
			return Err(error_message);
		}
	};
}

#[tauri::command]
pub async fn set_secret_key(
	state: State<'_, AppState>,
	key: &str,
	value: &str,
) -> Result<(), String> {
	return match set_secret(state, key, value) {
		Ok(()) => Ok(()),
		Err(error) => {
			let error_message =
				format!("Error setting secret key ({}): {}", key, error);
			log::error!("{}", error_message);
			return Err(error_message);
		}
	};
}

#[tauri::command]
pub async fn delete_secret_key(
	state: State<'_, AppState>,
	key: &str,
) -> Result<(), String> {
	return match delete_secret(state, key) {
		Ok(()) => Ok(()),
		Err(error) => {
			let error_message =
				format!("Error deleting secret key ({}): {}", key, error);
			log::error!("{}", error_message);
			return Err(error_message);
		}
	};
}
