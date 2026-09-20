pub fn valid_widget_id(id: &str) -> bool {
	!id.is_empty()
		&& id.len() <= 120
		&& id
			.bytes()
			.all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn tokens_match(expected: &str, supplied: &str) -> bool {
	expected.len() == 48
		&& supplied.len() == 48
		&& expected
			.bytes()
			.zip(supplied.bytes())
			.fold(0u8, |diff, (a, b)| diff | (a ^ b))
			== 0
}

pub fn allowed_host(host: &str) -> bool {
	let port = if cfg!(dev) { 57140 } else { 57143 };
	host == format!("localhost:{port}") || host == format!("127.0.0.1:{port}")
}

pub fn allowed_origin(origin: Option<&str>) -> bool {
	let Some(origin) = origin else {
		return true;
	}; // Non-browser clients still need a widget token.
	let origins = if cfg!(dev) {
		vec!["http://localhost:57141", "http://127.0.0.1:57141"]
	} else {
		vec!["http://localhost:57143", "http://127.0.0.1:57143"]
	};
	origins.contains(&origin)
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn rejects_rebinding_hosts_and_remote_origins() {
		assert!(!allowed_host("attacker.example:57143"));
		assert!(!allowed_origin(Some("https://attacker.example")));
		assert!(!allowed_origin(Some("null")));
		assert!(!valid_widget_id("../config"));
		assert!(valid_widget_id("widget_abc-123"));
	}
}
