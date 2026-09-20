mod policy;
use crate::file;
use policy::tokens_match;
pub use policy::{allowed_host, allowed_origin, valid_widget_id};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct WidgetAccess {
	tokens: Mutex<Option<HashMap<String, String>>>,
}

impl WidgetAccess {
	fn with_tokens<T>(
		&self,
		app: &AppHandle,
		action: impl FnOnce(&mut HashMap<String, String>) -> Result<T, String>,
	) -> Result<T, String> {
		let mut guard = self
			.tokens
			.lock()
			.map_err(|_| "Widget access store is unavailable.")?;
		if guard.is_none() {
			let path = file::config_path(app).join("widget-access");
			let stored = match file::load_json(path) {
				Ok(json) => serde_json::from_str(&json)
					.map_err(|_| "Widget access store is invalid.")?,
				Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
					HashMap::new()
				}
				Err(_) => {
					return Err("Unable to read widget access store.".into());
				}
			};
			*guard = Some(stored);
		}
		action(guard.as_mut().unwrap())
	}

	pub fn authorize(&self, app: &AppHandle, id: &str, token: &str) -> bool {
		if !valid_widget_id(id)
			|| token.len() != 48
			|| !file::tiles_path(app)
				.join(id)
				.join("core/config/meta.json")
				.is_file()
		{
			return false;
		}
		self.with_tokens(app, |tokens| {
			Ok(tokens
				.get(id)
				.is_some_and(|expected| tokens_match(expected, token)))
		})
		.unwrap_or(false)
	}

	pub fn issue(&self, app: &AppHandle, id: &str) -> Result<String, String> {
		if !valid_widget_id(id)
			|| !file::tiles_path(app)
				.join(id)
				.join("core/config/meta.json")
				.is_file()
		{
			return Err("Widget not found.".into());
		}
		self.with_tokens(app, |tokens| {
			if let Some(token) = tokens.get(id) {
				return Ok(token.clone());
			}
			let mut next = tokens.clone();
			next.retain(|widget_id, _| {
				valid_widget_id(widget_id)
					&& file::tiles_path(app)
						.join(widget_id)
						.join("core/config/meta.json")
						.is_file()
			});
			if next.len() >= 4096 {
				return Err("Too many widget access entries.".into());
			}
			let token = nanoid::nanoid!(48);
			next.insert(id.into(), token.clone());
			let json = serde_json::to_string(&next)
				.map_err(|_| "Unable to encode widget access store.")?;
			let path = file::config_path(app).join("widget-access");
			file::save_json_atomic(&json, path.clone())
				.map_err(|_| "Unable to save widget access store.")?;
			#[cfg(unix)]
			{
				use std::os::unix::fs::PermissionsExt;
				std::fs::set_permissions(
					path.with_extension("json"),
					std::fs::Permissions::from_mode(0o600),
				)
				.map_err(|_| "Unable to protect widget access store.")?;
			}
			*tokens = next;
			Ok(token)
		})
	}
}

#[tauri::command]
pub fn get_widget_access_token(
	widget_id: String,
	app: AppHandle,
	access: State<'_, WidgetAccess>,
) -> Result<String, String> {
	access.issue(&app, &widget_id)
}
