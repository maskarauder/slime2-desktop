//! Choose a process-wide provider before any native TLS client is created.
//! Reqwest enables AWS-LC and tonic enables ring, so rustls cannot infer one
//! from Cargo features when tokio-tungstenite builds its default TLS config.
pub fn initialize() {
	// A previously installed provider is valid too. Calling this again must not
	// panic or replace the provider underneath an existing connection.
	let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg(test)]
mod tests {
	#[test]
	fn mixed_provider_features_can_build_tls_after_initialization() {
		// native-tests deliberately enables BOTH ring and aws_lc_rs, reproducing
		// the application's dependency graph without needing a live TikTok room.
		super::initialize();
		let provider = rustls::crypto::CryptoProvider::get_default().unwrap();
		super::initialize();
		assert!(std::sync::Arc::ptr_eq(
			provider,
			rustls::crypto::CryptoProvider::get_default().unwrap()
		));
		let _ = rustls::ClientConfig::builder()
			.with_root_certificates(rustls::RootCertStore::empty())
			.with_no_client_auth();
	}
}
