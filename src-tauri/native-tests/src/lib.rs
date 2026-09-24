// Compile the actual transport code without requiring a desktop display/toolkit.
#![allow(dead_code)]
#[path = "../../src/backup.rs"]
mod backup;
#[path = "../../build_metadata.rs"]
mod build_metadata;
#[path = "../../src/server/websocket/connection.rs"]
mod connection;
#[path = "../../src/server/access/policy.rs"]
mod policy;
#[path = "../../src/session_tasks.rs"]
mod session_tasks;
#[path = "../../src/tiktok_lookup.rs"]
mod tiktok_lookup;
#[path = "../../src/tls.rs"]
mod tls;
#[path = "../../src/updater_policy.rs"]
mod updater_policy;
