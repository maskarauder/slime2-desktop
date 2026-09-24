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
const configFile = 'src-tauri/tauri.conf.json';

function decodeBase64(value) {
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	)
		throw new Error(
			'Expected the public .pub file produced by the Tauri signer.',
		);
	return Buffer.from(value, 'base64');
}

// Tauri exports a base64-encoded minisign public-key document. Reject private
// keys and arbitrary base64 before copying anything into the tracked config.
export function validatePublicKey(input) {
	const encoded = input.trim();
	if (!encoded || encoded.length > 4096)
		throw new Error('Expected a nonempty Tauri public .pub key.');
	const document = decodeBase64(encoded).toString('utf8').trim();
	const lines = document.split(/\r?\n/);
	if (
		lines.length !== 2 ||
		!/^untrusted comment: minisign public key(?:[:\s]|$)/.test(lines[0])
	)
		throw new Error(
			'Use the PUBLIC .pub file, never the private signing key.',
		);
	const key = decodeBase64(lines[1]);
	if (key.length !== 42 || key.subarray(0, 2).toString('ascii') !== 'Ed')
		throw new Error('Invalid minisign public key.');
	return encoded;
}

// The release workflow publishes updater installers for all three desktop OSes.
// A DMG's intermediate .app does not enable Tauri's .app.tar.gz generation.
export function validateReleaseBundles(config) {
	if (config.bundle?.active !== true)
		throw new Error(
			'Release builds require bundle.active=true in tauri.conf.json.',
		);
	const targets = config.bundle.targets ?? 'all';
	if (targets === 'all') return;
	for (const [target, platform] of [
		['app', 'macOS'],
		['msi', 'Windows'],
		['appimage', 'Linux'],
	]) {
		if (!Array.isArray(targets) || !targets.includes(target))
			throw new Error(
				`Missing ${platform} updater bundle target "${target}" in src-tauri/tauri.conf.json. ` +
					(target === 'app'
						? 'Include "app" alongside "dmg" to generate .app.tar.gz and its signature.'
						: `Include "${target}" before building the release.`),
			);
	}
}

export function configureUpdater(projectRoot, input) {
	const pubkey = validatePublicKey(input);
	const destination = path.join(projectRoot, configFile);
	const before = readFileSync(destination, 'utf8');
	const config = JSON.parse(before);
	if (
		!config.plugins?.updater ||
		typeof config.plugins.updater.pubkey !== 'string'
	)
		throw new Error(
			'Updater configuration is missing from src-tauri/tauri.conf.json.',
		);
	const previous = config.plugins.updater.pubkey;
	if (previous && previous !== pubkey)
		throw new Error(
			'A different public key is already configured. Key rotation needs a migration release; do not replace it casually.',
		);
	const matches = [...before.matchAll(/("pubkey"\s*:\s*)"(?:[^"\\]|\\.)*"/g)];
	if (matches.length !== 1)
		throw new Error(
			'Expected exactly one updater pubkey in src-tauri/tauri.conf.json.',
		);
	const after = before.replace(
		/("pubkey"\s*:\s*)"(?:[^"\\]|\\.)*"/,
		(_, prefix) => prefix + JSON.stringify(pubkey),
	);
	if (before === after) return false;
	const temporary = `${destination}.updater-${process.pid}.tmp`;
	try {
		writeFileSync(temporary, after, {
			flag: 'wx',
			mode: statSync(destination).mode,
		});
		if (readFileSync(destination, 'utf8') !== before)
			throw new Error(
				'Tauri configuration changed while preparing the update; retry.',
			);
		renameSync(temporary, destination);
	} finally {
		try {
			unlinkSync(temporary);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	return true;
}

function main(args) {
	if (args.length !== 1 || args[0] === '--help') {
		console.log(
			'npm run updater:configure -- /path/to/slime2-updater.key.pub\nnode scripts/updater-config.mjs --check',
		);
		if (args[0] !== '--help') process.exitCode = 1;
		return;
	}
	if (args[0] === '--check') {
		const config = JSON.parse(
			readFileSync(path.join(root, configFile), 'utf8'),
		);
		validatePublicKey(config.plugins?.updater?.pubkey ?? '');
		validateReleaseBundles(config);
		console.log(
			'Updater public key and release bundle targets are configured.',
		);
		return;
	}
	const changed = configureUpdater(
		root,
		readFileSync(path.resolve(args[0]), 'utf8'),
	);
	console.log(
		`${changed ? 'Saved' : 'Already configured'} public update key in ${configFile}. Commit this file; keep the private key outside the repository.`,
	);
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
