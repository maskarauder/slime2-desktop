use std::collections::HashMap;
use tokio::{sync::Mutex, task::JoinHandle};

#[derive(Default)]
pub struct SessionTasks {
	tasks: Mutex<HashMap<String, (String, JoinHandle<()>)>>,
}
impl SessionTasks {
	pub async fn replace(
		&self,
		account: String,
		session: String,
		spawn: impl FnOnce() -> JoinHandle<()>,
	) {
		let mut tasks = self.tasks.lock().await;
		if let Some((_, old)) = tasks.remove(&account) {
			old.abort();
		}
		tasks.insert(account, (session, spawn()));
	}
	pub async fn stop(&self, account: &str, session: &str) {
		let mut tasks = self.tasks.lock().await;
		if tasks.get(account).is_some_and(|(id, _)| id == session) {
			if let Some((_, task)) = tasks.remove(account) {
				task.abort();
			}
		}
	}
}
impl Drop for SessionTasks {
	fn drop(&mut self) {
		for (_, task) in self.tasks.get_mut().values() {
			task.abort();
		}
	}
}
#[cfg(test)]
mod tests {
	use super::*;
	#[tokio::test]
	async fn replacement_and_stale_stop_keep_only_current_session() {
		let tasks = SessionTasks::default();
		let old = tokio::spawn(std::future::pending::<()>());
		let old_abort = old.abort_handle();
		tasks.replace("account".into(), "old".into(), || old).await;
		let current = tokio::spawn(std::future::pending::<()>());
		let current_abort = current.abort_handle();
		tasks
			.replace("account".into(), "current".into(), || current)
			.await;
		tokio::task::yield_now().await;
		assert!(old_abort.is_finished());
		tasks.stop("account", "old").await;
		assert!(!current_abort.is_finished());
		tasks.stop("account", "current").await;
		tokio::task::yield_now().await;
		assert!(current_abort.is_finished());
		assert!(tasks.tasks.lock().await.is_empty());
	}
}
