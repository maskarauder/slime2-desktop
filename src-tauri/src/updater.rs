use crate::updater_policy::{self, MAX_DOWNLOAD_BYTES, REPOSITORY};
use futures::future::{AbortHandle, Abortable};
use serde::Serialize;
use std::{
	sync::{Arc, Mutex},
	time::{Duration, Instant},
};
#[cfg(target_os = "linux")]
use tauri::Manager;
use tauri::{ipc::Channel, AppHandle, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

const PREPARED_LIFETIME: Duration = Duration::from_secs(5 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Serialize)]
pub struct UpdateProgress {
	stage: &'static str,
	downloaded: u64,
	total: Option<u64>,
}

#[derive(Serialize)]
pub struct UpdateSupport {
	supported: bool,
	reason: Option<String>,
}

#[derive(Serialize)]
pub struct PreparedRelease {
	token: String,
	version: String,
}

struct PreparedUpdate {
	token: String,
	update: Update,
	bytes: Vec<u8>,
	prepared_at: Instant,
	progress: Channel<UpdateProgress>,
}

/// The lock spans download/installation. Other requests fail immediately;
/// they never queue another installer or retain another download in memory.
#[derive(Default)]
pub struct UpdateState(Arc<tokio::sync::Mutex<Option<PreparedUpdate>>>);

fn require_main(window: &WebviewWindow) -> Result<(), String> {
	if window.label() != "main" {
		return Err(
			"Only the Slime2 settings window can install updates.".into()
		);
	}
	Ok(())
}

fn unavailable_reason(app: &AppHandle) -> Option<String> {
	if cfg!(dev) || cfg!(debug_assertions) {
		return Some(
			"Automatic installation is available in release builds.".into(),
		);
	}
	let configured = app
		.config()
		.plugins
		.0
		.get("updater")
		.and_then(|config| config.get("pubkey"))
		.and_then(serde_json::Value::as_str)
		.is_some_and(|key| !key.trim().is_empty());
	if !configured {
		return Some("This build does not have an update verification key. Install a configured release first.".into());
	}
	if updater_policy::installer_target(
		std::env::consts::OS,
		std::env::consts::ARCH,
	)
	.is_none()
	{
		return Some(
			"Automatic installation is not available for this platform.".into(),
		);
	}
	#[cfg(target_os = "linux")]
	if app.env().appimage.is_none() {
		return Some("Automatic installation on Linux requires the AppImage. Update other packages with your package manager.".into());
	}
	None
}

#[tauri::command]
pub fn get_update_support(
	app: AppHandle,
	window: WebviewWindow,
) -> Result<UpdateSupport, String> {
	require_main(&window)?;
	let reason = unavailable_reason(&app);
	Ok(UpdateSupport {
		supported: reason.is_none(),
		reason,
	})
}

fn progress(
	channel: &Channel<UpdateProgress>,
	stage: &'static str,
	downloaded: u64,
	total: Option<u64>,
) -> Result<(), String> {
	channel
		.send(UpdateProgress {
			stage,
			downloaded,
			total,
		})
		.map_err(|_| {
			"The update window was closed. Check for updates again.".into()
		})
}

fn updater_error(error: tauri_plugin_updater::Error) -> String {
	use tauri_plugin_updater::Error;
	// Do not serialize complete HTTP errors/configuration to the normal log.
	match error {
		Error::Reqwest(error) if error.is_timeout() => "The update request timed out. Try again later.",
		Error::Reqwest(_) | Error::Network(_) => "Unable to download the update from GitHub. Check your connection and try again.",
		Error::ReleaseNotFound => "This release does not have a signed updater manifest yet. Use View release to install it manually.",
		Error::TargetNotFound(_) | Error::TargetsNotFound(_) => "This release does not include an updater installer for this platform and architecture.",
		Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) | Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => "The update signature could not be verified. Nothing was installed.",
		Error::Io(_) => "The installer could not be started or written. Check disk space and installation permissions.",
		Error::InvalidUpdaterFormat | Error::BinaryNotFoundInArchive => "The downloaded installer has an unsupported format. Nothing was installed.",
		Error::Serialization(_) | Error::Semver(_) => "This release has an invalid updater manifest.",
		_ => "The update could not be installed. Use View release to download the installer manually.",
	}.into()
}

async fn release_metadata(tag: &str) -> Result<serde_json::Value, String> {
	let client = reqwest::Client::builder()
		.user_agent("Slime2-Updater")
		.connect_timeout(Duration::from_secs(10))
		.timeout(CHECK_TIMEOUT)
		.build()
		.map_err(|_| "Unable to initialize the update connection.")?;
	let mut response = client
		.get(format!(
			"https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}"
		))
		.header("Accept", "application/vnd.github+json")
		.header("X-GitHub-Api-Version", "2022-11-28")
		.send()
		.await
		.map_err(|_| {
			"Unable to read this release from GitHub. Check your connection."
		})?;
	match response.status().as_u16() {
		403 | 429 => {
			return Err(
				"GitHub's update rate limit was reached. Try again later."
					.into(),
			)
		}
		404 => {
			return Err("This release is no longer available on GitHub.".into())
		}
		200 => {}
		_ => {
			return Err(
				"GitHub could not provide this release. Try again later."
					.into(),
			)
		}
	}
	let mut body = Vec::new();
	while let Some(chunk) = response
		.chunk()
		.await
		.map_err(|_| "The release response was interrupted.")?
	{
		if body.len().saturating_add(chunk.len()) > 2 * 1024 * 1024 {
			return Err("The release metadata is unexpectedly large.".into());
		}
		body.extend_from_slice(&chunk);
	}
	serde_json::from_slice(&body)
		.map_err(|_| "GitHub returned invalid release metadata.".into())
}

#[tauri::command]
pub async fn prepare_release_update(
	app: AppHandle,
	window: WebviewWindow,
	state: State<'_, UpdateState>,
	tag: String,
	on_progress: Channel<UpdateProgress>,
) -> Result<PreparedRelease, String> {
	require_main(&window)?;
	if let Some(reason) = unavailable_reason(&app) {
		return Err(reason);
	}
	updater_policy::release_version(&tag)?;
	let mut pending = state
		.0
		.try_lock()
		.map_err(|_| "An update is already being downloaded or installed.")?;
	if pending
		.as_ref()
		.is_some_and(|update| update.prepared_at.elapsed() >= PREPARED_LIFETIME)
	{
		pending.take();
	}
	if pending.is_some() {
		return Err(
			"A downloaded update is already waiting to be installed.".into()
		);
	}
	progress(&on_progress, "checking", 0, None)?;
	log::info!("Checking signed update {tag}.");
	let result = prepare(&app, &tag, &on_progress).await;
	let (update, bytes) = match result {
		Ok(prepared) => prepared,
		Err(error) => {
			log::warn!("Update preparation failed: {error}");
			return Err(error);
		}
	};
	progress(
		&on_progress,
		"ready",
		bytes.len() as u64,
		Some(bytes.len() as u64),
	)?;
	let result = PreparedRelease {
		token: nanoid::nanoid!(32),
		version: update.version.clone(),
	};
	*pending = Some(PreparedUpdate {
		token: result.token.clone(),
		update,
		bytes,
		prepared_at: Instant::now(),
		progress: on_progress,
	});
	drop(pending);
	let storage = state.0.clone();
	let expiry_token = result.token.clone();
	tauri::async_runtime::spawn(async move {
		tokio::time::sleep(PREPARED_LIFETIME).await;
		let mut pending = storage.lock().await;
		if pending
			.as_ref()
			.is_some_and(|update| update.token == expiry_token)
		{
			pending.take();
			log::info!("Unused downloaded update expired and was released.");
		}
	});
	Ok(result)
}

async fn prepare(
	app: &AppHandle,
	tag: &str,
	on_progress: &Channel<UpdateProgress>,
) -> Result<(Update, Vec<u8>), String> {
	let metadata = release_metadata(tag).await?;
	let (target, suffix) = updater_policy::installer_target(
		std::env::consts::OS,
		std::env::consts::ARCH,
	)
	.ok_or("This app architecture has no supported installer.")?;
	let endpoint = url::Url::parse(&format!(
		"https://github.com/{REPOSITORY}/releases/download/{tag}/latest.json"
	))
	.map_err(|_| "Invalid update release URL.")?;
	let updater = app
		.updater_builder()
		.target(target)
		.timeout(CHECK_TIMEOUT)
		.configure_client(|client| {
			client.connect_timeout(Duration::from_secs(10))
		})
		.endpoints(vec![endpoint])
		.map_err(updater_error)?
		.build()
		.map_err(updater_error)?;
	let mut update = updater
		.check()
		.await
		.map_err(updater_error)?
		.ok_or("This release is not newer than the installed app.")?;
	updater_policy::validate_versions(
		tag,
		&update.version,
		&app.package_info().version,
	)?;
	let expected_size = updater_policy::validate_asset(
		&metadata,
		tag,
		&update.download_url,
		suffix,
	)?;
	// The plugin intentionally does not copy its check timeout to downloads.
	update.timeout = Some(DOWNLOAD_TIMEOUT);
	let (abort, registration) = AbortHandle::new_pair();
	let abort_reason = Arc::new(Mutex::new(None));
	let reason_for_progress = abort_reason.clone();
	let channel = on_progress.clone();
	let mut downloaded = 0u64;
	let mut last_progress = Instant::now();
	progress(on_progress, "downloading", 0, Some(expected_size))?;
	let download = update.download(
		move |length, total| {
			downloaded = downloaded.saturating_add(length as u64);
			let error = if downloaded > MAX_DOWNLOAD_BYTES
				|| downloaded > expected_size
				|| total.is_some_and(|size| size > MAX_DOWNLOAD_BYTES)
			{
				Some("The installer exceeds its expected size. Nothing was installed.")
			} else if last_progress.elapsed() >= Duration::from_millis(250) {
				last_progress = Instant::now();
				progress(
					&channel,
					"downloading",
					downloaded,
					Some(expected_size),
				)
				.err()
				.map(|_| {
					"The update window was closed. Check for updates again."
				})
			} else {
				None
			};
			if let Some(error) = error {
				if let Ok(mut reason) = reason_for_progress.lock() {
					*reason = Some(error);
				}
				abort.abort();
			}
		},
		|| {},
	);
	let bytes = match Abortable::new(download, registration).await {
		Ok(result) => result.map_err(updater_error)?,
		Err(_) => {
			return Err(abort_reason
				.lock()
				.ok()
				.and_then(|reason| *reason)
				.unwrap_or("The update download was cancelled.")
				.into())
		}
	};
	if bytes.len() as u64 != expected_size {
		return Err("The installer size does not match its release metadata. Nothing was installed.".into());
	}
	// Update::download verifies the detached signature before returning bytes.
	log::info!(
		"Signed update {tag} downloaded and verified ({expected_size} bytes)."
	);
	Ok((update, bytes))
}

#[tauri::command]
pub async fn discard_prepared_update(
	window: WebviewWindow,
	state: State<'_, UpdateState>,
	token: String,
) -> Result<(), String> {
	require_main(&window)?;
	let mut pending = state
		.0
		.try_lock()
		.map_err(|_| "An update operation is still running.")?;
	if pending.as_ref().is_some_and(|update| update.token == token) {
		pending.take();
	}
	Ok(())
}

#[tauri::command]
pub async fn install_prepared_update(
	app: AppHandle,
	window: WebviewWindow,
	state: State<'_, UpdateState>,
	token: String,
) -> Result<(), String> {
	require_main(&window)?;
	let mut pending = state
		.0
		.try_lock()
		.map_err(|_| "An update operation is still running.")?;
	if !pending.as_ref().is_some_and(|update| update.token == token) {
		return Err("This downloaded update is no longer available. Check for updates again.".into());
	}
	let prepared = pending
		.take()
		.ok_or("The downloaded update is unavailable.")?;
	if prepared.prepared_at.elapsed() >= PREPARED_LIFETIME {
		return Err(
			"This downloaded update expired. Check for updates again.".into()
		);
	}
	progress(
		&prepared.progress,
		"installing",
		prepared.bytes.len() as u64,
		Some(prepared.bytes.len() as u64),
	)?;
	log::info!(
		"Installing verified update {} and relaunching Slime2.",
		prepared.update.version
	);
	let result = tokio::task::spawn_blocking(move || {
		prepared.update.install(prepared.bytes)
	})
	.await
	.map_err(|_| "The update installer stopped unexpectedly.")?
	.map_err(updater_error);
	if let Err(error) = &result {
		log::error!("Update installation failed: {error}");
	}
	result?;
	// On Windows the plugin starts MSI with AUTOLAUNCHAPP=True and exits.
	// Restart only after a successful in-place macOS/AppImage installation.
	#[cfg(not(target_os = "windows"))]
	app.restart();
	#[cfg(target_os = "windows")]
	let _ = app;
	#[allow(unreachable_code)]
	Ok(())
}
