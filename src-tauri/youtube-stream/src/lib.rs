//! Native YouTube StreamList transport, independent of Tauri and the widgets.
//! A pull interface applies HTTP/2 backpressure while the frontend dispatches a
//! batch. There is no unbounded application queue or timeout on quiet chat.

mod normalize;
#[cfg(test)]
mod tests;

#[allow(dead_code)]
mod proto {
	tonic::include_proto!("youtube.api.v3");
}

use proto::{
	LiveChatMessageListRequest, LiveChatMessageListResponse,
	v3_data_live_chat_message_service_client::V3DataLiveChatMessageServiceClient,
};
use serde::Serialize;
use serde_json::Value;
use std::{
	collections::HashMap,
	sync::{Arc, Mutex},
	time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tonic::{
	Code, Request, Status, Streaming,
	transport::{Channel, ClientTlsConfig, Endpoint},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const ENDPOINT: &str = "https://youtube.googleapis.com:443";

#[derive(Debug, Clone, Serialize)]
pub struct StreamError {
	pub code: u32,
	pub message: &'static str,
}

impl StreamError {
	fn new(code: Code, message: &'static str) -> Self {
		Self {
			code: code as u32,
			message,
		}
	}

	fn cancelled() -> Self {
		Self::new(Code::Cancelled, "YouTube stream was stopped.")
	}
}

impl From<Status> for StreamError {
	fn from(status: Status) -> Self {
		// Do not expose response metadata, arbitrary upstream text or tokens.
		let message = match status.code() {
			Code::Unauthenticated => {
				"YouTube rejected the stream access token."
			}
			Code::PermissionDenied => {
				"YouTube denied permission to read this live chat."
			}
			Code::ResourceExhausted => {
				"YouTube reported a quota or rate limit for streaming."
			}
			Code::NotFound => "The YouTube live chat was not found.",
			Code::FailedPrecondition => {
				"The YouTube live chat has ended or is disabled."
			}
			Code::InvalidArgument => {
				"YouTube rejected the stream parameters or continuation token."
			}
			Code::Unimplemented => {
				"YouTube StreamList is unavailable on this connection."
			}
			Code::Cancelled => "YouTube stream was cancelled.",
			Code::DeadlineExceeded => "YouTube stream connection timed out.",
			_ => "YouTube stream transport failed.",
		};
		Self::new(status.code(), message)
	}
}

struct Entry {
	id: String,
	cancel: watch::Sender<bool>,
	stream: AsyncMutex<Option<Streaming<LiveChatMessageListResponse>>>,
}

/// One native connection per account. Session IDs protect a newer connection
/// from delayed cleanup commands belonging to an older frontend reader.
#[derive(Default)]
pub struct YouTubeStreams {
	entries: Mutex<HashMap<String, Arc<Entry>>>,
}

impl YouTubeStreams {
	pub async fn open(
		&self,
		account_id: String,
		session_id: String,
		access_token: String,
		live_chat_id: String,
		page_token: Option<String>,
	) -> Result<(), StreamError> {
		self.open_at(
			account_id,
			session_id,
			access_token,
			live_chat_id,
			page_token,
			ENDPOINT,
		)
		.await
	}

	async fn open_at(
		&self,
		account_id: String,
		session_id: String,
		access_token: String,
		live_chat_id: String,
		page_token: Option<String>,
		endpoint: &str,
	) -> Result<(), StreamError> {
		let (cancel, mut cancelled) = watch::channel(false);
		let entry = Arc::new(Entry {
			id: session_id.clone(),
			cancel,
			stream: AsyncMutex::new(None),
		});
		let old = self
			.entries
			.lock()
			.unwrap()
			.insert(account_id.clone(), entry.clone());
		if let Some(old) = old {
			old.cancel.send_replace(true);
		}

		let result = tokio::select! {
			biased;
			_ = cancelled.changed() => Err(StreamError::cancelled()),
			result = connect(endpoint, access_token, live_chat_id, page_token) => result,
		};
		match result {
			Ok(stream) if !*cancelled.borrow() => {
				*entry.stream.lock().await = Some(stream);
				Ok(())
			}
			result => {
				self.close(&account_id, &session_id);
				Err(result.err().unwrap_or_else(StreamError::cancelled))
			}
		}
	}

	pub async fn next(
		&self,
		account_id: &str,
		session_id: &str,
	) -> Result<Option<Value>, StreamError> {
		let entry = self
			.entries
			.lock()
			.unwrap()
			.get(account_id)
			.filter(|entry| entry.id == session_id)
			.cloned()
			.ok_or_else(StreamError::cancelled)?;
		let mut cancelled = entry.cancel.subscribe();
		if *cancelled.borrow() {
			return Err(StreamError::cancelled());
		}
		let result = tokio::select! {
			biased;
			_ = cancelled.changed() => Err(StreamError::cancelled()),
			result = async {
				let mut stream = entry.stream.lock().await;
				let stream = stream.as_mut().ok_or_else(StreamError::cancelled)?;
				stream.message().await.map_err(StreamError::from)
			} => result,
		};
		match result {
			Ok(Some(batch)) => Ok(Some(normalize::batch(batch))),
			result => {
				self.close(account_id, session_id);
				result.map(|_| None)
			}
		}
	}

	pub fn close(&self, account_id: &str, session_id: &str) {
		let mut entries = self.entries.lock().unwrap();
		if entries
			.get(account_id)
			.is_some_and(|entry| entry.id == session_id)
		{
			if let Some(entry) = entries.remove(account_id) {
				entry.cancel.send_replace(true);
			}
		}
	}
}

async fn connect(
	endpoint: &str,
	access_token: String,
	live_chat_id: String,
	page_token: Option<String>,
) -> Result<Streaming<LiveChatMessageListResponse>, StreamError> {
	let mut authorization = format!("Bearer {access_token}")
		.parse::<tonic::metadata::MetadataValue<_>>()
		.map_err(|_| {
			StreamError::new(
				Code::Unauthenticated,
				"Invalid YouTube access token.",
			)
		})?;
	authorization.set_sensitive(true);
	let mut endpoint = Endpoint::from_shared(endpoint.to_string())
		.map_err(|_| {
			StreamError::new(Code::Internal, "Invalid YouTube stream endpoint.")
		})?
		.connect_timeout(CONNECT_TIMEOUT)
		// Detect a broken network even when nobody is chatting. These are
		// transport probes, not additional YouTube API requests.
		.http2_keep_alive_interval(Duration::from_secs(60))
		.keep_alive_timeout(Duration::from_secs(20))
		.keep_alive_while_idle(true);
	if endpoint.uri().scheme_str() == Some("https") {
		endpoint = endpoint
			.tls_config(ClientTlsConfig::new().with_native_roots())
			.map_err(|_| {
				StreamError::new(
					Code::Unavailable,
					"Unable to configure YouTube TLS.",
				)
			})?;
	}
	let channel: Channel =
		tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect())
			.await
			.map_err(|_| StreamError::from(Status::deadline_exceeded("")))?
			.map_err(|_| {
				StreamError::new(
					Code::Unavailable,
					"Unable to connect to YouTube gRPC (network or TLS failure).",
				)
			})?;
	let mut client = V3DataLiveChatMessageServiceClient::new(channel)
		.max_decoding_message_size(8 * 1024 * 1024);
	let mut request = Request::new(LiveChatMessageListRequest {
		live_chat_id: Some(live_chat_id),
		part: vec!["id".into(), "snippet".into(), "authorDetails".into()],
		page_token,
		profile_image_size: Some(88),
		..Default::default()
	});
	request
		.metadata_mut()
		.insert("authorization", authorization);
	// Bound opening the RPC, but never impose a 30-second lifetime on the
	// response stream: a quiet chat can remain open indefinitely.
	tokio::time::timeout(CONNECT_TIMEOUT, client.stream_list(request))
		.await
		.map_err(|_| StreamError::from(Status::deadline_exceeded("")))?
		.map(|response| response.into_inner())
		.map_err(StreamError::from)
}
