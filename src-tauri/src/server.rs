use std::path::PathBuf;
use warp::{Filter, Reply};
pub mod access;
pub mod websocket;

#[derive(Debug)]
struct Forbidden;
impl warp::reject::Reject for Forbidden {}

pub fn setup(
	connections: websocket::WebsocketConnections,
	(overlay_server_path, tiles_path, temp_files_path, media_files_path): (
		PathBuf,
		PathBuf,
		PathBuf,
		PathBuf,
	),
) -> Result<(), Box<dyn std::error::Error + 'static>> {
	// home route that just returns the word "squish" for fun
	let home_route = warp::path::end().map(|| "squish");

	let overlay_server_route =
		warp::path("overlay").and(warp::fs::dir(overlay_server_path));

	// allows overlay server to access tile files
	let tiles_route = warp::path("tile").and(warp::fs::dir(tiles_path));

	// used to preview media files in the temp folder for file input
	let preview_route =
		warp::path("preview").and(warp::fs::dir(temp_files_path));

	// for all media files saved by widgets using media inputs
	let media_route = warp::path("media").and(warp::fs::dir(media_files_path));

	let websocket_route = warp::path("websocket")
		.and(warp::path::end())
		.and(warp::header::optional::<String>("origin"))
		.and_then(|origin: Option<String>| async move {
			if access::allowed_origin(origin.as_deref()) {
				Ok(())
			} else {
				Err(warp::reject::custom(Forbidden))
			}
		})
		.untuple_one()
		.and(warp::ws())
		.and(warp::any().map(move || connections.clone()))
		.map(
			|ws: warp::ws::Ws, connections: websocket::WebsocketConnections| {
				ws.max_message_size(1024 * 1024)
					.max_frame_size(1024 * 1024)
					.on_upgrade(|websocket| {
						websocket::connect(websocket, connections)
					})
			},
		);

	if cfg!(dev) {
		// no need to run overlay server in dev here
		// that's run from src-overlay directly on port 57141
		let routes = home_route
			.or(tiles_route)
			.or(websocket_route)
			.or(preview_route)
			.or(media_route)
			// Allow the separate development overlay and Tauri preview origins.
			.with(warp::cors().allow_origins([
				"http://localhost:57141",
				"http://127.0.0.1:57141",
				"http://tauri.localhost",
				"tauri://localhost",
			]));

		let routes = warp::header::<String>("host")
			.and_then(|host: String| async move {
				if access::allowed_host(&host) {
					Ok(())
				} else {
					Err(warp::reject::custom(Forbidden))
				}
			})
			.untuple_one()
			.and(routes)
			.recover(reject_forbidden);

		// port 57140 in dev
		// widget server running on port 57141
		tauri::async_runtime::spawn(
			warp::serve(routes).run(([127, 0, 0, 1], 57140)),
		);
	} else {
		let routes = home_route
			.or(overlay_server_route)
			.or(tiles_route)
			.or(preview_route)
			.or(media_route)
			// Browser WebSockets use the explicit Origin check above.
			.or(websocket_route);

		let routes = warp::header::<String>("host")
			.and_then(|host: String| async move {
				if access::allowed_host(&host) {
					Ok(())
				} else {
					Err(warp::reject::custom(Forbidden))
				}
			})
			.untuple_one()
			.and(routes)
			.recover(reject_forbidden);

		// port 57143 in production, widget server running on the same port
		// 57143 kind of looks like slime :3c
		tauri::async_runtime::spawn(
			warp::serve(routes).run(([127, 0, 0, 1], 57143)),
		);
	}

	Ok(())
}

async fn reject_forbidden(
	rejection: warp::Rejection,
) -> Result<warp::reply::Response, warp::Rejection> {
	if rejection.find::<Forbidden>().is_some() {
		Ok(warp::reply::with_status(
			"Forbidden",
			warp::http::StatusCode::FORBIDDEN,
		)
		.into_response())
	} else {
		Err(rejection)
	}
}
