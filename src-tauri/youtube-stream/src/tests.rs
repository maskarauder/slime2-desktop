use super::*;
use crate::proto::{
	live_chat_message_snippet::DisplayedContent,
	v3_data_live_chat_message_service_server::{
		V3DataLiveChatMessageService, V3DataLiveChatMessageServiceServer,
	},
	*,
};
use std::pin::Pin;
use tokio_stream::{Stream, wrappers::TcpListenerStream};
use tonic::{Response, transport::Server};

#[test]
fn command_futures_can_move_between_tauri_threads() {
	fn assert_send<T: Send>(_: T) {}
	let streams = YouTubeStreams::default();
	assert_send(streams.open(
		"a".into(),
		"s".into(),
		"token".into(),
		"chat".into(),
		None,
	));
	assert_send(streams.next("a", "s"));
}

#[derive(Clone)]
struct MockYouTube {
	requests: Arc<Mutex<Vec<LiveChatMessageListRequest>>>,
	mode: &'static str,
}

#[tonic::async_trait]
impl V3DataLiveChatMessageService for MockYouTube {
	type StreamListStream = Pin<
		Box<
			dyn Stream<Item = Result<LiveChatMessageListResponse, Status>>
				+ Send,
		>,
	>;
	async fn stream_list(
		&self,
		request: Request<LiveChatMessageListRequest>,
	) -> Result<Response<Self::StreamListStream>, Status> {
		assert_eq!(
			request.metadata().get("authorization").unwrap(),
			"Bearer test-token"
		);
		self.requests.lock().unwrap().push(request.into_inner());
		if self.mode == "auth" {
			return Err(Status::unauthenticated(
				"upstream-secret-must-not-be-logged",
			));
		}
		if self.mode == "idle" {
			return Ok(Response::new(Box::pin(tokio_stream::pending())));
		}
		let response = LiveChatMessageListResponse {
			next_page_token: Some("resume-after-1".into()),
			items: vec![text_message("1")],
			..Default::default()
		};
		Ok(Response::new(Box::pin(tokio_stream::iter([Ok(response)]))))
	}
}

async fn server(
	mode: &'static str,
) -> (
	String,
	Arc<Mutex<Vec<LiveChatMessageListRequest>>>,
	tokio::task::JoinHandle<()>,
) {
	let requests = Arc::new(Mutex::new(Vec::new()));
	let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
	let url = format!("http://{}", listener.local_addr().unwrap());
	let service = MockYouTube {
		mode,
		requests: requests.clone(),
	};
	let task = tokio::spawn(async move {
		Server::builder()
			.add_service(V3DataLiveChatMessageServiceServer::new(service))
			.serve_with_incoming(TcpListenerStream::new(listener))
			.await
			.unwrap();
	});
	(url, requests, task)
}

fn text_message(id: &str) -> LiveChatMessage {
	LiveChatMessage {
		id: Some(id.into()),
		snippet: Some(LiveChatMessageSnippet {
			r#type: Some(1),
			live_chat_id: Some("chat".into()),
			published_at: Some("2026-09-18T12:00:00Z".into()),
			display_message: Some("Hello :face-red-droopy-eyes:".into()),
			displayed_content: Some(DisplayedContent::TextMessageDetails(
				LiveChatTextMessageDetails {
					message_text: Some("Hello :face-red-droopy-eyes:".into()),
				},
			)),
			..Default::default()
		}),
		author_details: Some(LiveChatMessageAuthorDetails {
			channel_id: Some("UC123".into()),
			display_name: Some("Example".into()),
			is_chat_moderator: Some(true),
			..Default::default()
		}),
		..Default::default()
	}
}

#[tokio::test]
async fn reads_real_grpc_frames_with_oauth_and_resume_token() {
	let (url, requests, server) = server("batch").await;
	let streams = YouTubeStreams::default();
	streams
		.open_at(
			"account".into(),
			"session".into(),
			"test-token".into(),
			"chat".into(),
			Some("resume-before-1".into()),
			&url,
		)
		.await
		.unwrap();
	let batch = streams.next("account", "session").await.unwrap().unwrap();
	assert_eq!(batch["nextPageToken"], "resume-after-1");
	assert_eq!(batch["items"][0]["snippet"]["type"], "textMessageEvent");
	assert_eq!(
		batch["items"][0]["snippet"]["textMessageDetails"]["messageText"],
		"Hello :face-red-droopy-eyes:"
	);
	assert_eq!(batch["items"][0]["authorDetails"]["isChatModerator"], true);
	let requests = requests.lock().unwrap();
	assert_eq!(requests[0].page_token.as_deref(), Some("resume-before-1"));
	assert_eq!(requests[0].part, ["id", "snippet", "authorDetails"]);
	drop(requests);
	assert!(streams.next("account", "session").await.unwrap().is_none());
	assert!(streams.entries.lock().unwrap().is_empty());
	server.abort();
}

#[tokio::test]
async fn stopping_idle_reader_cancels_pending_read_and_old_stop_cannot_close_new_reader()
 {
	let (url, _, server) = server("idle").await;
	let streams = Arc::new(YouTubeStreams::default());
	streams
		.open_at(
			"account".into(),
			"old".into(),
			"test-token".into(),
			"chat".into(),
			None,
			&url,
		)
		.await
		.unwrap();
	let copy = streams.clone();
	let pending =
		tokio::spawn(async move { copy.next("account", "old").await });
	tokio::task::yield_now().await;
	// Passing the REST interval must not tear down a healthy, quiet gRPC read.
	tokio::time::pause();
	tokio::time::advance(Duration::from_secs(31)).await;
	assert!(!pending.is_finished());
	tokio::time::resume();
	streams
		.open_at(
			"account".into(),
			"new".into(),
			"test-token".into(),
			"chat".into(),
			None,
			&url,
		)
		.await
		.unwrap();
	assert_eq!(
		tokio::time::timeout(Duration::from_secs(2), pending)
			.await
			.unwrap()
			.unwrap()
			.unwrap_err()
			.code,
		1
	);
	streams.close("account", "old");
	assert_eq!(
		streams.entries.lock().unwrap().get("account").unwrap().id,
		"new"
	);
	let copy = streams.clone();
	let pending =
		tokio::spawn(async move { copy.next("account", "new").await });
	tokio::task::yield_now().await;
	streams.close("account", "new");
	assert_eq!(
		tokio::time::timeout(Duration::from_secs(2), pending)
			.await
			.unwrap()
			.unwrap()
			.unwrap_err()
			.code,
		1
	);
	assert!(streams.entries.lock().unwrap().is_empty());
	server.abort();
}

#[tokio::test]
async fn authentication_failure_is_safe_and_releases_registry_entry() {
	let (url, _, server) = server("auth").await;
	let streams = YouTubeStreams::default();
	let error = streams
		.open_at(
			"account".into(),
			"session".into(),
			"test-token".into(),
			"chat".into(),
			None,
			&url,
		)
		.await
		.unwrap_err();
	assert_eq!(error.code, 16);
	let log = serde_json::to_string(&error).unwrap();
	assert!(!log.contains("secret"));
	assert!(!log.contains("test-token"));
	assert!(streams.entries.lock().unwrap().is_empty());
	server.abort();
}

#[test]
fn normalizes_payment_membership_moderation_sticker_gift_and_poll_events() {
	let cases = [
		(
			15,
			"superChatEvent",
			"superChatDetails",
			DisplayedContent::SuperChatDetails(LiveChatSuperChatDetails {
				amount_micros: Some(9007199254740993),
				currency: Some("USD".into()),
				..Default::default()
			}),
		),
		(
			16,
			"superStickerEvent",
			"superStickerDetails",
			DisplayedContent::SuperStickerDetails(
				LiveChatSuperStickerDetails {
					super_sticker_metadata: Some(SuperStickerMetadata {
						alt_text_language: Some("en".into()),
						..Default::default()
					}),
					..Default::default()
				},
			),
		),
		(
			7,
			"newSponsorEvent",
			"newSponsorDetails",
			DisplayedContent::NewSponsorDetails(
				LiveChatNewSponsorDetails::default(),
			),
		),
		(
			17,
			"memberMilestoneChatEvent",
			"memberMilestoneChatDetails",
			DisplayedContent::MemberMilestoneChatDetails(
				LiveChatMemberMilestoneChatDetails::default(),
			),
		),
		(
			18,
			"membershipGiftingEvent",
			"membershipGiftingDetails",
			DisplayedContent::MembershipGiftingDetails(
				LiveChatMembershipGiftingDetails::default(),
			),
		),
		(
			19,
			"giftMembershipReceivedEvent",
			"giftMembershipReceivedDetails",
			DisplayedContent::GiftMembershipReceivedDetails(
				LiveChatGiftMembershipReceivedDetails::default(),
			),
		),
		(
			10,
			"userBannedEvent",
			"userBannedDetails",
			DisplayedContent::UserBannedDetails(
				LiveChatUserBannedMessageDetails {
					ban_type: Some(2),
					ban_duration_seconds: Some(300),
					..Default::default()
				},
			),
		),
		(
			20,
			"pollEvent",
			"pollDetails",
			DisplayedContent::PollDetails(LiveChatPollDetails {
				status: Some(1),
				..Default::default()
			}),
		),
		(
			21,
			"giftEvent",
			"giftEventDetails",
			DisplayedContent::GiftDetails(LiveChatGiftDetails {
				gift_name: Some("Gift".into()),
				combo_count: Some(3),
				..Default::default()
			}),
		),
	];
	for (code, kind, details, content) in cases {
		let mut event = text_message("id");
		let snippet = event.snippet.as_mut().unwrap();
		snippet.r#type = Some(code);
		snippet.displayed_content = Some(content);
		let batch = normalize::batch(LiveChatMessageListResponse {
			items: vec![event],
			..Default::default()
		});
		let snippet = &batch["items"][0]["snippet"];
		assert_eq!(snippet["type"], kind);
		assert!(snippet[details].is_object());
		if code == 15 {
			assert_eq!(snippet[details]["amountMicros"], "9007199254740993");
		}
		if code == 16 {
			assert_eq!(
				snippet[details]["superStickerMetadata"]["language"],
				"en"
			);
		}
		if code == 10 {
			assert_eq!(snippet[details]["banDurationSeconds"], "300");
		}
		if code == 20 {
			assert_eq!(snippet[details]["status"], "active");
		}
		if code == 21 {
			assert_eq!(snippet[details]["giftMetadata"]["giftName"], "Gift");
		}
	}
}

#[test]
fn ignores_malformed_messages_but_keeps_resume_and_end_markers() {
	let batch = normalize::batch(LiveChatMessageListResponse {
		items: vec![LiveChatMessage::default()],
		next_page_token: Some("last-page".into()),
		offline_at: Some("2026-09-18T12:00:00Z".into()),
		..Default::default()
	});
	assert_eq!(batch["items"], serde_json::json!([]));
	assert_eq!(batch["nextPageToken"], "last-page");
	assert!(batch["offlineAt"].is_string());
}
