use futures::{SinkExt, stream::SplitSink};
use std::{
	collections::{HashMap, HashSet},
	sync::{
		Arc, Mutex,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};
use warp::filters::ws::{Message, WebSocket};
const MAX_QUEUE_MESSAGES: usize = 256;
const MAX_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const MAX_OUTBOUND_BYTES: usize = 8 * 1024 * 1024;
pub struct WebsocketConnection {
	pub(super) id: usize,
	pub(super) widget_id: String,
	sender: mpsc::Sender<(Message, usize)>,
	channels: HashSet<String>,
	queued_bytes: Arc<AtomicUsize>,
	pub(super) closed: watch::Sender<bool>,
	requests: Mutex<HashMap<String, Instant>>,
}

impl WebsocketConnection {
	pub(super) fn new(
		id: usize,
		widget_id: String,
		mut sink: SplitSink<WebSocket, Message>,
		channels: HashSet<String>,
	) -> Self {
		let (sender, mut receiver) =
			mpsc::channel::<(Message, usize)>(MAX_QUEUE_MESSAGES);
		let queued_bytes = Arc::new(AtomicUsize::new(0));
		let budget = queued_bytes.clone();
		let (closed, mut cancelled) = watch::channel(false);
		let stop = closed.clone();
		tokio::spawn(async move {
			loop {
				let item = tokio::select! {
				 _ = cancelled.changed() => break,
				 item = receiver.recv() => item,
				};
				let Some((message, bytes)) = item else {
					break;
				};
				budget.fetch_sub(bytes, Ordering::Relaxed);
				let result = tokio::select! {
				 _ = cancelled.changed() => break,
				 result = tokio::time::timeout(Duration::from_secs(10), sink.send(message)) => result,
				};
				if !matches!(result, Ok(Ok(()))) {
					break;
				}
			}
			stop.send_replace(true);
			// A closed/overloaded client reconnects and rejects pending requests.
			// We never retain an unbounded backlog or silently discard a response.
			let _ = tokio::time::timeout(Duration::from_secs(1), sink.close())
				.await;
		});
		Self {
			id,
			widget_id,
			sender,
			channels,
			queued_bytes,
			closed,
			requests: Mutex::new(HashMap::new()),
		}
	}

	pub fn send(&self, message: &str, channel: &str) {
		if channel != "all" && !self.channels.contains(channel) {
			return;
		}
		if message.contains("\"type\":\"widget-response\"") {
			if let Ok(value) =
				serde_json::from_str::<serde_json::Value>(message)
			{
				if let Some(id) =
					value.pointer("/data/request_id").and_then(|id| id.as_str())
				{
					let Ok(mut requests) = self.requests.lock() else {
						self.close();
						return;
					};
					if requests.remove(id).is_none() {
						return;
					} // Response belongs to another browser connection.
				}
			}
		}
		let _ = self.send_direct(message);
	}

	pub(super) fn close(&self) {
		self.closed.send_replace(true);
	}

	pub fn send_direct(&self, message: &str) -> Result<(), String> {
		let bytes = message.len();
		if *self.closed.borrow() {
			return Err("Websocket connection is closed.".into());
		}
		if bytes > MAX_OUTBOUND_BYTES
			|| self
				.queued_bytes
				.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
					used.checked_add(bytes)
						.filter(|total| *total <= MAX_QUEUE_BYTES)
				})
				.is_err()
		{
			if !self.closed.send_replace(true) {
				log::warn!(
					"Widget {} queue exceeded its byte limit; reconnecting.",
					self.id
				);
			}
			return Err(
				"Widget outgoing queue exceeded its byte limit; reconnecting."
					.into(),
			);
		}
		if self
			.sender
			.try_send((Message::text(message), bytes))
			.is_err()
		{
			self.queued_bytes.fetch_sub(bytes, Ordering::Relaxed);
			if !self.closed.send_replace(true) {
				log::warn!(
					"Widget {} queue is full or closed; reconnecting.",
					self.id
				);
			}
			return Err(
				"Widget outgoing queue is full or closed; reconnecting.".into(),
			);
		}
		Ok(())
	}

	pub(super) fn begin_request(&self, id: &str) -> Result<(), String> {
		if id.is_empty() || id.len() > 256 {
			return Err("Invalid widget request ID.".into());
		}
		let mut requests = self
			.requests
			.lock()
			.map_err(|_| "Request tracking unavailable.")?;
		requests.retain(|_, since| since.elapsed() < Duration::from_secs(45));
		if requests.len() >= 64 || requests.contains_key(id) {
			return Err("Widget has too many outstanding requests or a duplicate request ID.".into());
		}
		requests.insert(id.into(), Instant::now());
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	fn connection() -> (WebsocketConnection, mpsc::Receiver<(Message, usize)>) {
		let (sender, receiver) = mpsc::channel(MAX_QUEUE_MESSAGES);
		let (closed, _) = watch::channel(false);
		(
			WebsocketConnection {
				id: 1,
				widget_id: "w".into(),
				sender,
				channels: HashSet::from(["w".into()]),
				queued_bytes: Arc::new(AtomicUsize::new(0)),
				closed,
				requests: Mutex::new(HashMap::new()),
			},
			receiver,
		)
	}
	#[test]
	fn slow_browser_has_bounded_queue_without_closing_other_layouts() {
		let (slow, _rx) = connection();
		let (other, _other_rx) = connection();
		for _ in 0..256 {
			slow.send_direct("hello").unwrap();
		}
		assert!(slow.send_direct("overflow").is_err());
		assert!(*slow.closed.borrow());
		assert!(!*other.closed.borrow());
		assert!(other.send_direct("hello").is_ok());
		assert_eq!(slow.queued_bytes.load(Ordering::Relaxed), 256 * 5);
	}
	#[test]
	fn byte_budget_is_independent_of_message_count() {
		let (c, _rx) = connection();
		let large = "x".repeat(MAX_OUTBOUND_BYTES);
		c.send_direct(&large).unwrap();
		c.send_direct(&large).unwrap();
		assert!(c.send_direct("x").is_err());
		assert_eq!(c.queued_bytes.load(Ordering::Relaxed), MAX_QUEUE_BYTES);
	}
	#[test]
	fn responses_only_reach_requesting_connection() {
		let (a, mut arx) = connection();
		let (b, mut brx) = connection();
		a.begin_request("request").unwrap();
		let response =
			r#"{"type":"widget-response","data":{"request_id":"request"}}"#;
		a.send(response, "w");
		b.send(response, "w");
		assert!(arx.try_recv().is_ok());
		assert!(brx.try_recv().is_err());
		a.send(response, "w");
		assert!(arx.try_recv().is_err());
	}
	#[test]
	fn request_budget_and_duplicate_ids_are_enforced() {
		let (c, _rx) = connection();
		c.begin_request("0").unwrap();
		assert!(c.begin_request("0").is_err());
		for id in 1..64 {
			c.begin_request(&id.to_string()).unwrap();
		}
		assert!(c.begin_request("65").is_err());
	}
}
