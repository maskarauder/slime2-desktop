mod build_metadata;

fn main() {
	let manifest = std::path::PathBuf::from(
		std::env::var_os("CARGO_MANIFEST_DIR").unwrap(),
	);
	build_metadata::emit(manifest.parent().unwrap());
	tauri_build::build()
}
