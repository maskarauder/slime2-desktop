//! Pure validation shared by the native updater and its headless tests.
use semver::Version;
use serde_json::Value;
use url::Url;

pub const REPOSITORY: &str = "maskarauder/slime2-desktop";
pub const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

pub fn release_version(tag: &str) -> Result<Version, String> {
	if tag.len() > 100 || !tag.is_ascii() {
		return Err("Invalid release version.".into());
	}
	let version = Version::parse(tag.strip_prefix('v').unwrap_or(tag))
		.map_err(|_| "Invalid release version.")?;
	if !version.build.is_empty()
		|| version.pre.as_str().to_ascii_lowercase().contains("debug")
	{
		return Err("This release cannot be installed automatically.".into());
	}
	Ok(version)
}

pub fn validate_versions(
	tag: &str,
	manifest_version: &str,
	current: &Version,
) -> Result<(), String> {
	let selected = release_version(tag)?;
	let manifest = Version::parse(manifest_version)
		.map_err(|_| "The updater manifest has an invalid version.")?;
	// Windows MSI versions remain numeric; release/test adds its suffix only
	// to the GitHub tag. Accept that existing publishing convention, but never
	// allow it to bypass the newer-than-installed check.
	let same_numeric_release = !selected.pre.is_empty()
		&& manifest.pre.is_empty()
		&& manifest.build.is_empty()
		&& (selected.major, selected.minor, selected.patch)
			== (manifest.major, manifest.minor, manifest.patch);
	if selected != manifest && !same_numeric_release {
		return Err("The updater manifest does not match this release.".into());
	}
	if selected <= *current || manifest <= *current {
		return Err("This release is not newer than the installed app.".into());
	}
	Ok(())
}

pub fn installer_target(
	os: &str,
	arch: &str,
) -> Option<(String, &'static str)> {
	if !matches!(arch, "x86_64" | "aarch64") {
		return None;
	}
	let (platform, installer, suffix) = match os {
		"windows" => ("windows", "msi", ".msi"),
		"linux" => ("linux", "appimage", ".appimage"),
		"macos" => ("darwin", "app", ".app.tar.gz"),
		_ => return None,
	};
	Some((format!("{platform}-{arch}-{installer}"), suffix))
}

fn clean_https_url(url: &Url) -> bool {
	url.scheme() == "https"
		&& url.username().is_empty()
		&& url.password().is_none()
		&& url.port().is_none()
		&& url.query().is_none()
		&& url.fragment().is_none()
}

/// Bind the manifest's asset URL to the exact public GitHub release selected.
/// tauri-action uses the API asset URL; older manifests use the browser URL.
pub fn validate_asset(
	release: &Value,
	tag: &str,
	download_url: &Url,
	suffix: &str,
) -> Result<u64, String> {
	if release.get("tag_name").and_then(Value::as_str) != Some(tag)
		|| release.get("draft").and_then(Value::as_bool) != Some(false)
	{
		return Err(
			"GitHub did not return the requested public release.".into()
		);
	}
	let api_prefix = format!("/repos/{REPOSITORY}/releases/assets/");
	let browser_prefix = format!("/{REPOSITORY}/releases/download/{tag}/");
	let trusted_path = match download_url.host_str() {
		Some("api.github.com") => download_url
			.path()
			.strip_prefix(&api_prefix)
			.is_some_and(|id| {
				!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
			}),
		Some("github.com") => download_url
			.path()
			.strip_prefix(&browser_prefix)
			.is_some_and(|name| !name.is_empty() && !name.contains('/')),
		_ => false,
	};
	if !clean_https_url(download_url) || !trusted_path {
		return Err(
			"The update installer is outside this GitHub release.".into()
		);
	}
	let asset = release
		.get("assets")
		.and_then(Value::as_array)
		.and_then(|assets| {
			assets.iter().find(|asset| {
				["url", "browser_download_url"].iter().any(|field| {
					asset.get(field).and_then(Value::as_str)
						== Some(download_url.as_str())
				})
			})
		})
		.ok_or("The update installer does not belong to this release.")?;
	let name = asset.get("name").and_then(Value::as_str).unwrap_or("");
	let size = asset.get("size").and_then(Value::as_u64).unwrap_or(0);
	if asset.get("state").and_then(Value::as_str) != Some("uploaded")
		|| !name.to_ascii_lowercase().ends_with(suffix)
		|| !(1..=MAX_DOWNLOAD_BYTES).contains(&size)
	{
		return Err(
			"This release has no supported installer for this app.".into()
		);
	}
	Ok(size)
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	fn fixture() -> Value {
		json!({
			"tag_name": "v1.6.0", "draft": false,
			"assets": [{
				"name": "Slime2-v1.6.0_Windows-X64.msi", "size": 42,
				"state": "uploaded",
				"url": "https://api.github.com/repos/maskarauder/slime2-desktop/releases/assets/123",
				"browser_download_url": "https://github.com/maskarauder/slime2-desktop/releases/download/v1.6.0/Slime2-v1.6.0_Windows-X64.msi"
			}]
		})
	}

	#[test]
	fn release_versions_cannot_escape_the_endpoint_or_downgrade() {
		for bad in [
			"../latest",
			"v1.6.0/other",
			"v01.6.0",
			"v1.6.0+build",
			"v1.6.0-debug",
		] {
			assert!(release_version(bad).is_err(), "{bad}");
		}
		let current = Version::new(1, 5, 2);
		assert!(validate_versions("v1.6.0", "1.6.0", &current).is_ok());
		assert!(validate_versions("v1.6.0-test", "1.6.0", &current).is_ok());
		assert!(validate_versions("v1.6.0-test", "1.6.1", &current).is_err());
		assert!(validate_versions("v1.5.2", "1.5.2", &current).is_err());
		assert!(validate_versions("v1.5.2-test", "1.5.2", &current).is_err());
		assert!(validate_versions("v1.4.0", "1.6.0", &current).is_err());
	}

	#[test]
	fn target_selection_preserves_architecture_and_installer_family() {
		assert_eq!(
			installer_target("windows", "x86_64").unwrap().0,
			"windows-x86_64-msi"
		);
		assert_eq!(
			installer_target("windows", "aarch64").unwrap().0,
			"windows-aarch64-msi"
		);
		assert_eq!(
			installer_target("linux", "aarch64").unwrap().0,
			"linux-aarch64-appimage"
		);
		assert_eq!(
			installer_target("macos", "x86_64").unwrap().0,
			"darwin-x86_64-app"
		);
		assert!(installer_target("windows", "x86").is_none());
	}

	#[test]
	fn both_official_asset_url_formats_are_bound_to_release_metadata() {
		let release = fixture();
		for field in ["url", "browser_download_url"] {
			let url = Url::parse(release["assets"][0][field].as_str().unwrap())
				.unwrap();
			assert_eq!(
				validate_asset(&release, "v1.6.0", &url, ".msi").unwrap(),
				42
			);
		}
	}

	#[test]
	fn unrelated_assets_unsigned_families_and_oversized_downloads_are_rejected()
	{
		let release = fixture();
		let url =
			Url::parse(release["assets"][0]["url"].as_str().unwrap()).unwrap();
		assert!(validate_asset(&release, "v1.6.1", &url, ".msi").is_err());
		assert!(validate_asset(&release, "v1.6.0", &url, ".exe").is_err());
		for wrong in [
			"https://api.github.com/repos/maskarauder/slime2-desktop/releases/assets/999",
			"https://api.github.com/repos/another/app/releases/assets/123",
			"https://github.com.evil.invalid/maskarauder/slime2-desktop/releases/assets/123",
			"http://api.github.com/repos/maskarauder/slime2-desktop/releases/assets/123",
		] {
			assert!(validate_asset(&release, "v1.6.0", &Url::parse(wrong).unwrap(), ".msi").is_err());
		}
		let mut oversized = release.clone();
		oversized["assets"][0]["size"] = json!(MAX_DOWNLOAD_BYTES + 1);
		assert!(validate_asset(&oversized, "v1.6.0", &url, ".msi").is_err());
		let mut draft = release;
		draft["draft"] = json!(true);
		assert!(validate_asset(&draft, "v1.6.0", &url, ".msi").is_err());
	}
}
