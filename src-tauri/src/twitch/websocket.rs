use tokio_tungstenite::connect_async;
static TWITCH_WEBSOCKET_URL: &str = "slime2.stream";

pub async fn connect(_twitch_read_account_id: String) {
	let (_websocket_stream, _response) =
		connect_async(TWITCH_WEBSOCKET_URL).await.expect(
			format!("Failed to connect to: {}", TWITCH_WEBSOCKET_URL).as_str(),
		);
}
