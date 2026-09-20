use reqwest::{header::HeaderValue, redirect::Policy};
use std::time::Duration;

// Euler Stream's documented username -> numeric chat user ID endpoint.
// Keep the API key in the native process and out of URLs, logs and widgets.
pub async fn lookup_user_id(username: &str, api_key: &str) -> Result<String, String> {
	if username.is_empty()
		|| username.len() > 32
		|| !username.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'.')
	{
		return Err("TIKTOK_LOOKUP_USERNAME".into());
	}
	if api_key.trim().is_empty() {
		return Err("TIKTOK_LOOKUP_CREDENTIALS".into());
	}
	let mut key = HeaderValue::from_str(api_key.trim())
		.map_err(|_| "TIKTOK_LOOKUP_CREDENTIALS".to_string())?;
	key.set_sensitive(true);
	let client = reqwest::Client::builder()
		.timeout(Duration::from_secs(15))
		.connect_timeout(Duration::from_secs(5))
		.redirect(Policy::none())
		.build()
		.map_err(|_| "TIKTOK_LOOKUP_NETWORK".to_string())?;
	let mut response = client
		.get(format!("https://api.eulerstream.com/webcast/anchors/{username}/user_id"))
		.header("x-api-key", key)
		.header("Accept", "application/json")
		.send()
		.await
		.map_err(|_| "TIKTOK_LOOKUP_NETWORK".to_string())?;
	if !response.status().is_success() {
		return Err(format!("TIKTOK_LOOKUP_HTTP_{}", response.status().as_u16()));
	}
	let mut body = Vec::new();
	while let Some(chunk) = response.chunk().await
		.map_err(|_| "TIKTOK_LOOKUP_NETWORK".to_string())?
	{
		if body.len() + chunk.len() > 64 * 1024 {
			return Err("TIKTOK_LOOKUP_RESPONSE".into());
		}
		body.extend_from_slice(&chunk);
	}
	parse_user_id(&body)
}

fn parse_user_id(body: &[u8]) -> Result<String, String> {
	let value: serde_json::Value = serde_json::from_slice(body)
		.map_err(|_| "TIKTOK_LOOKUP_RESPONSE".to_string())?;
	if let Some(code) = value.get("code").and_then(|code| code.as_u64()) {
		if (400..=599).contains(&code) {
			return Err(format!("TIKTOK_LOOKUP_HTTP_{code}"));
		}
	}
	let id = value.get("numeric_user_id").and_then(|id| id.as_str())
		.filter(|id| !id.is_empty() && id.len() <= 32 && id.bytes().all(|c| c.is_ascii_digit()))
		.ok_or_else(|| "TIKTOK_LOOKUP_NOT_FOUND".to_string())?;
	Ok(id.to_string())
}

#[cfg(test)]
mod tests {
	use super::parse_user_id;

	#[test]
	fn preserves_large_ids_without_floating_point_conversion() {
		assert_eq!(parse_user_id(br#"{"code":200,"numeric_user_id":"7312345678901234567"}"#).unwrap(), "7312345678901234567");
	}

	#[test]
	fn rejects_missing_numeric_or_error_responses_without_leaking_body() {
		for body in [r#"{"code":200}"#, r#"{"numeric_user_id":7312345678901234567}"#, r#"{"numeric_user_id":"nickname"}"#, r#"{"code":403,"message":"private","numeric_user_id":"123"}"#] {
			let error = parse_user_id(body.as_bytes()).unwrap_err();
			assert!(error.starts_with("TIKTOK_LOOKUP_"));
			assert!(!error.contains("private"));
		}
	}
}
