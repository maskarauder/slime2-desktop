use futures::StreamExt;
use std::{
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};
use tokio::sync::{RwLock, Semaphore};
use warp::filters::ws::{Message, WebSocket};
mod connection;
mod ws_commands;
pub use connection::WebsocketConnection;

static NEXT_CONNECTION_ID: AtomicUsize = AtomicUsize::new(0);
static ACTIVE: Semaphore = Semaphore::const_new(32);
const MAX_INBOUND_BYTES: usize = 1024 * 1024;
pub type WebsocketConnections = Arc<RwLock<Vec<Arc<WebsocketConnection>>>>;

pub async fn connect(websocket: WebSocket, connections: WebsocketConnections) {
	let Ok(_permit) = ACTIVE.try_acquire() else {
		return;
	};
	let id = NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
	if let Err(error) = message_handler(websocket, &connections, id).await {
		log::warn!("Widget connection {} ended: {}", id, error);
	}
	let mut guard = connections.write().await;
	if let Some(index) = guard.iter().position(|connection| connection.id == id)
	{
		let connection = guard.swap_remove(index);
		connection.close();
	}
}

fn get_command(message: Message) -> Result<ws_commands::Command, String> {
	if !message.is_text() || message.as_bytes().len() > MAX_INBOUND_BYTES {
		return Err("Invalid widget message type or size.".into());
	}
	serde_json::from_slice(message.as_bytes())
		.map_err(|_| "Malformed widget command.".into())
}

async fn message_handler(
	websocket: WebSocket,
	connections: &WebsocketConnections,
	id: usize,
) -> Result<(), String> {
	let (sender, mut receiver) = websocket.split();
	let first = tokio::time::timeout(Duration::from_secs(10), receiver.next())
		.await
		.map_err(|_| "Widget registration timed out.")?
		.ok_or("Widget closed before registration.")?
		.map_err(|_| "Widget registration failed.")?;
	let command = get_command(first)?;
	if command.r#type != "register" {
		return Err("First widget command must register.".into());
	}
	let connection =
		ws_commands::register(command.data, id, sender, connections).await?;
	let mut cancelled = connection.closed.subscribe();
	let mut tokens = 400f64;
	let mut last = Instant::now();
	loop {
		if *cancelled.borrow() {
			return Ok(());
		}
		let incoming = tokio::select! {
		 _ = cancelled.changed() => return Ok(()),
		 incoming = tokio::time::timeout(Duration::from_secs(60), receiver.next()) => incoming.map_err(|_| "Widget heartbeat timed out.")?,
		};
		let Some(incoming) = incoming else {
			return Ok(());
		};
		let message = incoming.map_err(|_| "Widget transport disconnected.")?;
		if message.is_close() {
			return Ok(());
		}
		let now = Instant::now();
		tokens = (tokens + now.duration_since(last).as_secs_f64() * 100.0)
			.min(400.0);
		last = now;
		if tokens < 1.0 {
			return Err("Widget request rate limit exceeded.".into());
		}
		tokens -= 1.0;
		if message.is_ping() || message.is_pong() {
			continue;
		}
		let command = get_command(message)?;
		match command.r#type.as_str() {
			"request" => ws_commands::request(command.data, &connection)?,
			"heartbeat" => ws_commands::heartbeat(command.data, &connection)?,
			_ => return Err("Unexpected widget command.".into()),
		}
	}
}
