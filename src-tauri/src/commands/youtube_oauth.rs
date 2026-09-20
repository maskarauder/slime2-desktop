use serde::{Deserialize, Serialize};
use tokio::{
	io::{AsyncReadExt, AsyncWriteExt},
	net::TcpListener,
	time::{Duration, timeout},
};
use url::Url;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallback {
	code: String,
	redirect_uri: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GoogleTokenResponse {
	access_token: String,
	expires_in: u64,
	#[serde(skip_serializing_if = "Option::is_none")]
	refresh_token: Option<String>,
	scope: String,
	token_type: String,
}

#[tauri::command]
pub async fn start_youtube_oauth(
	client_id: String,
	code_challenge: String,
	state: String,
	scope: String,
) -> Result<OAuthCallback, String> {
	let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
		.await
		.map_err(|error| {
			format!(
				"Unable to start the Google OAuth callback listener: {error}"
			)
		})?;
	let port = listener
		.local_addr()
		.map_err(|error| {
			format!("Unable to read the Google OAuth callback address: {error}")
		})?
		.port();
	let redirect_uri = format!("http://127.0.0.1:{port}");

	let mut authorization_url = Url::parse(
		"https://accounts.google.com/o/oauth2/v2/auth",
	)
	.map_err(|error| {
		format!("Unable to create the Google authorization URL: {error}")
	})?;
	authorization_url
		.query_pairs_mut()
		.append_pair("client_id", &client_id)
		.append_pair("redirect_uri", &redirect_uri)
		.append_pair("response_type", "code")
		.append_pair("scope", &scope)
		.append_pair("code_challenge", &code_challenge)
		.append_pair("code_challenge_method", "S256")
		.append_pair("state", &state)
		.append_pair("access_type", "offline")
		.append_pair("prompt", "consent");

	webbrowser::open(authorization_url.as_str()).map_err(|error| {
		format!("Unable to open Google authorization: {error}")
	})?;

	timeout(Duration::from_secs(5 * 60), async {
		loop {
			let (mut stream, _) = listener.accept().await.map_err(|error| {
				format!("Google OAuth callback failed: {error}")
			})?;
			let mut buffer = [0_u8; 8192];
			let bytes_read =
				stream.read(&mut buffer).await.map_err(|error| {
					format!("Unable to read the Google OAuth callback: {error}")
				})?;
			let request = String::from_utf8_lossy(&buffer[..bytes_read]);
			let request_target = request
				.lines()
				.next()
				.and_then(|line| line.split_whitespace().nth(1));

			let Some(request_target) = request_target else {
				write_oauth_response(&mut stream, "400 Bad Request", false)
					.await?;
				continue;
			};

			let callback_url =
				match Url::parse(&format!("{redirect_uri}{request_target}")) {
					Ok(url) => url,
					Err(_) => {
						write_oauth_response(
							&mut stream,
							"400 Bad Request",
							false,
						)
						.await?;
						continue;
					}
				};
			let query: std::collections::HashMap<_, _> =
				callback_url.query_pairs().into_owned().collect();

			if query.get("state") != Some(&state) {
				write_oauth_response(&mut stream, "400 Bad Request", false)
					.await?;
				continue;
			}

			if let Some(error) = query.get("error") {
				write_oauth_response(&mut stream, "200 OK", false).await?;
				return Err(format!(
					"Google authorization was not completed: {error}"
				));
			}

			if let Some(code) = query.get("code") {
				write_oauth_response(&mut stream, "200 OK", true).await?;
				return Ok(OAuthCallback {
					code: code.clone(),
					redirect_uri,
				});
			}

			write_oauth_response(&mut stream, "400 Bad Request", false).await?;
		}
	})
	.await
	.map_err(|_| {
		"Google authorization timed out after five minutes.".to_string()
	})?
}

#[tauri::command]
pub async fn exchange_youtube_oauth_code(
	client_id: String,
	client_secret: String,
	code: String,
	code_verifier: String,
	redirect_uri: String,
) -> Result<GoogleTokenResponse, String> {
	request_google_tokens(&[
		("client_id", client_id),
		("client_secret", client_secret),
		("code", code),
		("code_verifier", code_verifier),
		("grant_type", "authorization_code".to_string()),
		("redirect_uri", redirect_uri),
	])
	.await
}

#[tauri::command]
pub async fn refresh_youtube_oauth_token(
	client_id: String,
	client_secret: String,
	refresh_token: String,
) -> Result<GoogleTokenResponse, String> {
	request_google_tokens(&[
		("client_id", client_id),
		("client_secret", client_secret),
		("refresh_token", refresh_token),
		("grant_type", "refresh_token".to_string()),
	])
	.await
}

async fn request_google_tokens(
	params: &[(&str, String)],
) -> Result<GoogleTokenResponse, String> {
	// `Serializer` contains a non-Send encoding callback. Finish and drop it
	// before the request reaches an await point so Tauri can run this command
	// on its multithreaded async runtime.
	let request_body = {
		let mut serializer =
			url::form_urlencoded::Serializer::new(String::new());
		for (key, value) in params {
			serializer.append_pair(key, value);
		}
		serializer.finish()
	};
	let response = reqwest::Client::new()
		.post("https://oauth2.googleapis.com/token")
		.timeout(Duration::from_secs(30))
		.header("Content-Type", "application/x-www-form-urlencoded")
		.body(request_body)
		.send()
		.await
		.map_err(|error| format!("Unable to contact Google OAuth: {error}"))?;
	let status = response.status();
	let response_body = response.text().await.map_err(|error| {
		format!("Unable to read the Google OAuth response: {error}")
	})?;

	if !status.is_success() {
		let code = serde_json::from_str::<serde_json::Value>(&response_body)
			.ok()
			.and_then(|body| {
				body.get("error")
					.and_then(|value| value.as_str())
					.filter(|value| {
						value.len() <= 64
							&& value
								.chars()
								.all(|c| c.is_ascii_lowercase() || c == '_')
					})
					.map(str::to_string)
			})
			.unwrap_or_else(|| "unknown_error".to_string());
		return Err(serde_json::json!({
			"source": "google-oauth",
			"status": status.as_u16(),
				"message": format!(
					"Google OAuth token request failed: {code} (HTTP {status})."
				),
			"code": code,
		})
		.to_string());
	}

	serde_json::from_str(&response_body).map_err(|error| {
		format!("Google returned an invalid OAuth response: {error}")
	})
}

async fn write_oauth_response(
	stream: &mut tokio::net::TcpStream,
	status: &str,
	success: bool,
) -> Result<(), String> {
	let body = if success {
		"<!doctype html><meta charset=\"utf-8\"><title>Slime2 connected</title><p>YouTube is connected. You can close this tab and return to Slime2.</p>"
	} else {
		"<!doctype html><meta charset=\"utf-8\"><title>Slime2 connection failed</title><p>YouTube could not be connected. Return to Slime2 for details.</p>"
	};
	let response = format!(
		"HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
		body.len(),
	);
	stream
		.write_all(response.as_bytes())
		.await
		.map_err(|error| {
			format!("Unable to respond to the Google OAuth callback: {error}")
		})
}
