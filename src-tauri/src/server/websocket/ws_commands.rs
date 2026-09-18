//? Custom slime2 websocket commands
// Tauri commands found under commands.rs

use crate::get_app_handle;

use super::{WebsocketConnection, WebsocketConnections};
use futures::stream::SplitSink;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{Emitter, EventTarget};
use warp::filters::ws::{Message, WebSocket};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Command {
	pub r#type: String,
	pub data: CommandData,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(untagged)]
pub enum CommandData {
	Register(RegisterData),
	Request(RequestData),
	Heartbeat(HeartbeatData),
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RegisterData {
	id: String,
	channels: HashSet<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RequestData {
	widget_id: String,
	request_id: String,
	request_type: String,
	payload: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct HeartbeatData {
	widget_id: String,
	timestamp: u64,
}

#[derive(Clone, Serialize)]
struct RegisterPayload {
	id: String,
}

pub async fn register(
	command_data: CommandData,
	connection_id: usize,
	websocket_sender: SplitSink<WebSocket, Message>,
	connections: &WebsocketConnections,
) -> Result<(), String> {
	let CommandData::Register(register_data) = command_data else {
		// unexpected registration data
		return Err(String::from("Register command is incorrectly formatted!"));
	};

	let mut channels: HashSet<String> = HashSet::new();

	// prefix channel names to prevent collision with widget_id channel
	for channel in register_data.channels.iter() {
		channels.insert(format!("channel_{}", channel));
	}

	// add widget id as a channel for widget-specific data
	channels.insert(format!("widget_{}", register_data.id));

	if let Err(error) = get_app_handle().emit_to(
		EventTarget::webview_window("main"),
		"websocket-registration",
		RegisterPayload {
			id: register_data.id,
		},
	) {
		return Err(format!(
			"Error emitting websocket-registration event: {}",
			error
		));
	};

	// register connection, can now send websocket messages to this connection
	connections.write().await.push(
		WebsocketConnection::new(connection_id, websocket_sender, channels)
			.into(),
	);

	Ok(())
}

pub fn request(command_data: CommandData) -> Result<(), String> {
	let CommandData::Request(request_data) = command_data else {
		return Err(String::from("Request command is incorrectly formatted!"));
	};

	if let Err(error) = get_app_handle().emit_to(
		EventTarget::webview_window("main"),
		"websocket-request",
		request_data.clone(),
	) {
		return Err(format!(
			"Error emitting websocket-request event: {}",
			error
		));
	}

	Ok(())
}

pub async fn heartbeat(
	command_data: CommandData,
	connection_id: usize,
	connections: &WebsocketConnections,
) -> Result<(), String> {
	let CommandData::Heartbeat(heartbeat_data) = command_data else {
		return Err(String::from("Heartbeat command is incorrectly formatted!"));
	};

	let message = serde_json::json!({
		"widgetId": heartbeat_data.widget_id,
		"type": "heartbeat",
		"data": { "timestamp": heartbeat_data.timestamp },
	})
	.to_string();

	let connections_read_guard = connections.read().await;
	let Some(connection) = connections_read_guard
		.iter()
		.find(|connection| connection.id == connection_id)
	else {
		return Err(format!(
			"Heartbeat connection (ID: {}) is no longer registered!",
			connection_id
		));
	};

	connection.send_direct(&message)
}
