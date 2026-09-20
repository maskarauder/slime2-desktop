import {
	readFileSync,
	writeFileSync,
	renameSync,
	unlinkSync,
	statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function validateVersion(version) {
	if (
		typeof version !== 'string' ||
		version !== version.trim() ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
	)
		throw new Error(
			'Use a stable version such as 1.5.1. Release channels add their own suffixes.',
		);
	const [major, minor, patch] = version.split('.').map(Number);
	if (major > 255 || minor > 255 || patch > 65535)
		throw new Error(
			'Windows MSI versions require major/minor <= 255 and patch <= 65535.',
		);
}

function replaceOnce(text, pattern, replacement, label) {
	const matches = [...text.matchAll(new RegExp(pattern.source, 'gm'))];
	if (matches.length !== 1)
		throw new Error(
			`Expected exactly one ${label}; found ${matches.length}.`,
		);
	return text.replace(pattern, replacement);
}

function packageBlock(text, version, lock) {
	const pattern = lock
		? /^\[\[package\]\][\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm
		: /^\[package\][\s\S]*?(?=^\[|$(?![\s\S]))/gm;
	let count = 0;
	const updated = text.replace(pattern, block => {
		if (!/^name = "slime2"\r?$/m.test(block)) return block;
		count++;
		return replaceOnce(
			block,
			/^(version = ")[^"]+("\r?)$/m,
			`$1${version}$2`,
			'slime2 package version',
		);
	});
	if (count !== 1)
		throw new Error(`Expected exactly one slime2 package; found ${count}.`);
	return updated;
}

// Read and validate every file before any writes. Never invoke a dependency resolver.
export function planVersion(projectRoot, requestedVersion) {
	const read = file => readFileSync(path.join(projectRoot, file), 'utf8');
	const current = JSON.parse(read('package.json')).version;
	const version = requestedVersion ?? current;
	validateVersion(version);
	const plan = [];
	function add(file, transform) {
		const before = read(file);
		try {
			plan.push({ file, before, after: transform(before) });
		} catch (error) {
			throw new Error(`${file}: ${error.message}`, { cause: error });
		}
	}
	for (const prefix of ['', 'src-overlay/']) {
		add(`${prefix}package.json`, text => {
			const data = JSON.parse(text);
			if (typeof data.version !== 'string')
				throw new Error('Missing version.');
			return replaceOnce(
				text,
				/^(\s*"version": ")[^"]+("[,]?\r?)$/m,
				`$1${version}$2`,
				'package version',
			);
		});
		add(`${prefix}package-lock.json`, text => {
			const data = JSON.parse(text);
			if (
				data.lockfileVersion !== 3 ||
				typeof data.version !== 'string' ||
				typeof data.packages?.['']?.version !== 'string'
			)
				throw new Error(
					'Expected lockfileVersion 3 with a root package version.',
				);
			// Only the top-level and root-package versions change; keep dependency bytes intact.
			let updated = replaceOnce(
				text,
				/^(\t|  )"version": "[^"]+"(,?\r?)$/m,
				`$1"version": "${version}"$2`,
				'lockfile version',
			);
			updated = replaceOnce(
				updated,
				/("packages": \{\r?\n\s*"": \{[\s\S]*?"version": ")[^"]+("[,]?)/,
				`$1${version}$2`,
				'root package version',
			);
			const result = JSON.parse(updated);
			if (
				result.version !== version ||
				result.packages[''].version !== version
			)
				throw new Error('Could not update both root versions.');
			return updated;
		});
	}
	add('src-tauri/Cargo.toml', text => packageBlock(text, version, false));
	add('src-tauri/Cargo.lock', text => packageBlock(text, version, true));
	add('pkgbuild/PKGBUILD', text =>
		replaceOnce(text, /^pkgver=[^\r\n]+/m, `pkgver=${version}`, 'pkgver'),
	);
	// Tauri must continue to read the canonical version instead of duplicating it.
	if (
		JSON.parse(read('src-tauri/tauri.conf.json')).version !==
		'../package.json'
	)
		throw new Error(
			'src-tauri/tauri.conf.json must read version from ../package.json.',
		);
	return {
		version,
		changes: plan.filter(item => item.before !== item.after),
	};
}

export function writeVersion(projectRoot, changes) {
	const staged = [];
	const written = [];
	try {
		for (const change of changes) {
			const destination = path.join(projectRoot, change.file);
			if (readFileSync(destination, 'utf8') !== change.before)
				throw new Error(
					`${change.file} changed while preparing the update; retry.`,
				);
			const temporary = `${destination}.version-${process.pid}.tmp`;
			writeFileSync(temporary, change.after, {
				flag: 'wx',
				mode: statSync(destination).mode,
			});
			staged.push({ ...change, destination, temporary });
		}
		for (const change of staged) {
			renameSync(change.temporary, change.destination);
			written.push(change);
		}
	} catch (error) {
		// Best-effort rollback if a later rename fails; this is not a filesystem transaction.
		for (const change of written.reverse()) {
			try {
				writeFileSync(change.destination, change.before);
			} catch {
				console.error(
					`Could not restore ${change.file}; restore it from Git.`,
				);
			}
		}
		throw error;
	} finally {
		for (const change of staged) {
			try {
				unlinkSync(change.temporary);
			} catch (error) {
				if (error.code !== 'ENOENT') console.error(error.message);
			}
		}
	}
}

function main(args) {
	if (args[0] === '--help') {
		console.log(
			'npm run version:check\nnpm run version:set -- 1.5.1 [--dry-run]',
		);
		return;
	}
	const check = args.length === 1 && args[0] === '--check';
	const dryRun = args.length === 2 && args[1] === '--dry-run';
	if (!check && !(args.length === 1 || dryRun))
		throw new Error('Use npm run version:set -- 1.5.1 [--dry-run].');
	const { version, changes } = planVersion(root, check ? undefined : args[0]);
	if (check && changes.length)
		throw new Error(
			`Version drift from ${version}: ${changes.map(c => c.file).join(', ')}. Run npm run version:set -- ${version}.`,
		);
	if (!check && !dryRun) writeVersion(root, changes);
	console.log(
		`${check ? 'Verified' : dryRun ? 'Would set' : 'Set'} app version ${version}; ${changes.length} files ${dryRun ? 'would change' : 'changed'}.`,
	);
	for (const change of changes) console.log(`  ${change.file}`);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
