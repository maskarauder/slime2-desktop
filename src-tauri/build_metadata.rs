use std::{path::Path, process::Command};

fn git(root: &Path, args: &[&str]) -> Option<String> {
	let output = Command::new("git")
		.current_dir(root)
		.args(args)
		.output()
		.ok()?;
	output
		.status
		.success()
		.then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn valid_commit(value: &str) -> bool {
	(value.len() == 40 || value.len() == 64)
		&& value.bytes().all(|c| c.is_ascii_hexdigit())
}

pub fn revision(root: &Path, fallback: Option<&str>) -> (String, &'static str) {
	if let Some(commit) =
		git(root, &["rev-parse", "HEAD"]).filter(|v| valid_commit(v))
	{
		let state = match git(
			root,
			&["status", "--porcelain", "--untracked-files=normal"],
		) {
			Some(status) if status.is_empty() => "clean",
			Some(_) => "modified",
			None => "unknown",
		};
		return (commit, state);
	}
	(
		fallback
			.filter(|v| valid_commit(v))
			.unwrap_or("unknown")
			.to_owned(),
		"unknown",
	)
}

pub fn emit(root: &Path) {
	println!("cargo:rerun-if-env-changed=GITHUB_SHA");
	let fallback = std::env::var("GITHUB_SHA").ok();
	let (commit, state) = revision(root, fallback.as_deref());
	println!("cargo:rustc-env=SLIME2_BUILD_COMMIT={commit}");
	println!("cargo:rustc-env=SLIME2_BUILD_STATE={state}");
	for key in ["TARGET", "PROFILE"] {
		println!(
			"cargo:rustc-env=SLIME2_BUILD_{key}={}",
			std::env::var(key).unwrap_or_else(|_| "unknown".into())
		);
	}
	// Follow the actual Git paths, including linked worktrees and packed refs.
	for name in ["HEAD", "index", "packed-refs"] {
		watch_git_path(root, name);
	}
	if let Some(reference) = git(root, &["symbolic-ref", "-q", "HEAD"]) {
		watch_git_path(root, &reference);
	}
	// Refresh provenance after tracked edits without watching target/node_modules.
	if let Some(files) = git(root, &["ls-files", "-z"]) {
		for file in files.split('\0').filter(|file| !file.is_empty()) {
			watch(&root.join(file));
		}
	}
	// Directory watches also notice new source files before they are added to Git.
	for directory in [
		"src",
		"src-tauri/src",
		"src-overlay/src",
		"scripts",
		"tests",
		"resources/widgets",
	] {
		watch(&root.join(directory));
	}
}

fn watch_git_path(root: &Path, name: &str) {
	if let Some(path) = git(root, &["rev-parse", "--git-path", name]) {
		watch(&root.join(path));
	}
}

fn watch(path: &Path) {
	// Missing paths make Cargo rebuild on every invocation; watch their parent.
	let target = if path.exists() {
		path
	} else {
		path.parent().unwrap_or(path)
	};
	if target.exists() {
		println!("cargo:rerun-if-changed={}", target.display());
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn accepts_only_complete_hex_commit_ids() {
		assert!(valid_commit(&"a".repeat(40)));
		assert!(valid_commit(&"f".repeat(64)));
		for value in ["main", "abc123", "unknown", "\ncargo:rustc-env=BAD=true"]
		{
			assert!(!valid_commit(value));
		}
	}

	#[test]
	fn source_archives_use_a_valid_ci_revision_or_explicit_unknown() {
		let missing = std::env::temp_dir()
			.join(format!("slime2-missing-source-{}", std::process::id()));
		let hash = "a".repeat(40);
		assert_eq!(revision(&missing, Some(&hash)), (hash, "unknown"));
		assert_eq!(
			revision(&missing, Some("unsafe\nvalue")),
			("unknown".into(), "unknown")
		);
		assert_eq!(revision(&missing, None), ("unknown".into(), "unknown"));
	}
}
