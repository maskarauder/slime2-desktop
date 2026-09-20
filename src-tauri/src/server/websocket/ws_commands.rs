use super::{WebsocketConnection, WebsocketConnections};
use crate::get_app_handle;
use futures::stream::SplitSink;
use serde::{Deserialize, Serialize};
use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};
use tauri::{Emitter, EventTarget, Manager};
use warp::filters::ws::{Message, WebSocket};

#[derive(Deserialize)]
pub struct Command {
	pub r#type: String,
	pub data: CommandData,
}
#[derive(Deserialize)]
#[serde(untagged)]
pub enum CommandData {
	Register(RegisterData),
	Request(RequestData),
	Heartbeat(HeartbeatData),
}
#[derive(Deserialize)]
pub struct RegisterData {
	id: String,
	#[serde(default)]
	token: String,
	#[serde(default)]
	channels: HashSet<String>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct RequestData {
	widget_id: String,
	request_id: String,
	request_type: String,
	payload: HashMap<String, serde_json::Value>,
}
#[derive(Deserialize)]
pub struct HeartbeatData {
	widget_id: String,
	timestamp: u64,
}

pub async fn register(
	data: CommandData,
	id: usize,
	sink: SplitSink<WebSocket, Message>,
	connections: &WebsocketConnections,
) -> Result<Arc<WebsocketConnection>, String> {
	let CommandData::Register(data) = data else {
		return Err("Invalid widget registration.".into());
	};
	let app = get_app_handle();
	if !app
		.state::<crate::server::access::WidgetAccess>()
		.authorize(app, &data.id, &data.token)
	{
		return Err("Widget authentication failed. Copy its current Overlay URL from Slime2.".into());
	}
	let json = crate::file::load_json(
		crate::file::tiles_path(app)
			.join(&data.id)
			.join("core/config/meta"),
	)
	.map_err(|_| "Widget metadata unavailable.")?;
	let meta: serde_json::Value =
		serde_json::from_str(&json).map_err(|_| "Invalid widget metadata.")?;
	let allowed = meta.get("channels").and_then(|v| v.as_array());
	if data.channels.len() > 32
		|| data.channels.iter().any(|channel| {
			channel.len() > 120
				|| !allowed.is_some_and(|values| {
					values
						.iter()
						.any(|value| value.as_str() == Some(channel.as_str()))
				})
		}) {
		return Err("Widget requested undeclared channels.".into());
	}
	let mut channels: HashSet<String> = data
		.channels
		.into_iter()
		.map(|channel| format!("channel_{channel}"))
		.collect();
	channels.insert(format!("widget_{}", data.id));
	let connection = Arc::new(WebsocketConnection::new(
		id,
		data.id.clone(),
		sink,
		channels,
	));
	connections.write().await.push(connection.clone());
	connection.send_direct(
		&serde_json::json!({"widgetId":data.id,"type":"registered","data":{}})
			.to_string(),
	)?;
	app.emit_to(
		EventTarget::webview_window("main"),
		"websocket-registration",
		serde_json::json!({"id": data.id}),
	)
	.map_err(|_| "Unable to notify app of widget registration.")?;
	Ok(connection)
}

pub fn request(
	data: CommandData,
	connection: &WebsocketConnection,
) -> Result<(), String> {
	let CommandData::Request(data) = data else {
		return Err("Invalid widget request.".into());
	};
	if data.widget_id != connection.widget_id {
		return Err(
			"Widget request identity does not match its connection.".into()
		);
	}
	if data.request_type.len() > 100 {
		return Err("Invalid widget request type.".into());
	}
	connection.begin_request(&data.request_id)?;
	get_app_handle()
		.emit_to(
			EventTarget::webview_window("main"),
			"websocket-request",
			data,
		)
		.map_err(|_| "Unable to forward widget request.".into())
}

pub fn heartbeat(
	data: CommandData,
	connection: &WebsocketConnection,
) -> Result<(), String> {
	let CommandData::Heartbeat(data) = data else {
		return Err("Invalid widget heartbeat.".into());
	};
	if data.widget_id != connection.widget_id {
		return Err(
			"Widget heartbeat identity does not match its connection.".into()
		);
	}
	connection.send_direct(&serde_json::json!({"widgetId":data.widget_id,"type":"heartbeat","data":{"timestamp":data.timestamp}}).to_string())
}
