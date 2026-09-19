fn main() -> Result<(), Box<dyn std::error::Error>> {
	println!("cargo:rerun-if-changed=proto/stream_list.proto");
	let mut config = prost_build::Config::new();
	// Bundle protoc so Windows developers do not need another system install.
	config.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
	tonic_prost_build::configure()
		.server_mod_attribute(".", "#[cfg(test)]")
		.compile_with_config(
			config,
			&[std::path::PathBuf::from("proto/stream_list.proto")],
			&[
				std::path::PathBuf::from("proto"),
				protoc_bin_vendored::include_path()?,
			],
		)?;
	Ok(())
}
