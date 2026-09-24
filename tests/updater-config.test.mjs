import assert from 'node:assert/strict';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
	cpSync,
	realpathSync,
	symlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
	configureUpdater,
	validatePublicKey,
	validateReleaseBundles,
} from '../scripts/updater-config.mjs';

function publicKey(fill = 7) {
	const bytes = Buffer.alloc(42, fill);
	bytes.write('Ed');
	return Buffer.from(
		`untrusted comment: minisign public key: synthetic test key\n${bytes.toString('base64')}\n`,
	).toString('base64');
}

test('release configuration includes the updater bundle for each desktop OS', () => {
	const config = JSON.parse(
		readFileSync(
			new URL('../src-tauri/tauri.conf.json', import.meta.url),
			'utf8',
		),
	);
	assert.doesNotThrow(() => validateReleaseBundles(config));
	for (const targets of ['all', undefined, ['app', 'dmg', 'msi', 'appimage']])
		assert.doesNotThrow(() =>
			validateReleaseBundles({ bundle: { active: true, targets } }),
		);
});

test('release configuration rejects missing updater targets and disabled bundling', () => {
	for (const missing of ['app', 'msi', 'appimage']) {
		const targets = ['app', 'dmg', 'msi', 'appimage'].filter(
			target => target !== missing,
		);
		assert.throws(
			() => validateReleaseBundles({ bundle: { active: true, targets } }),
			new RegExp(`Missing .* updater bundle target "${missing}"`),
		);
	}
	for (const config of [{}, { bundle: { active: false, targets: 'all' } }])
		assert.throws(
			() => validateReleaseBundles(config),
			/bundle.active=true/,
		);
});

for (const linked of [false, true])
	test(`release preparation rejects DMG-only and accepts app through a ${linked ? 'symlinked' : 'direct'} path`, t => {
		const temporary = mkdtempSync(
			path.join(os.tmpdir(), 'slime2-release-bundles-'),
		);
		t.after(() => rmSync(temporary, { recursive: true, force: true }));
		let root = path.join(temporary, 'project');
		mkdirSync(root);
		if (linked) {
			const alias = path.join(temporary, 'linked project');
			symlinkSync(
				realpathSync(root),
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			root = alias;
		}
		mkdirSync(path.join(root, 'scripts'));
		mkdirSync(path.join(root, 'src-tauri'));
		const script = path.join(root, 'scripts/updater-config.mjs');
		cpSync(
			new URL('../scripts/updater-config.mjs', import.meta.url),
			script,
		);
		const config = {
			bundle: {
				active: true,
				targets: ['appimage', 'deb', 'rpm', 'msi', 'dmg'],
			},
			plugins: { updater: { pubkey: publicKey() } },
		};
		const file = path.join(root, 'src-tauri/tauri.conf.json');
		writeFileSync(file, JSON.stringify(config));
		const before = readFileSync(file, 'utf8');
		const failed = spawnSync(process.execPath, [script, '--check'], {
			encoding: 'utf8',
		});
		assert.equal(failed.status, 1);
		assert.match(
			failed.stderr,
			/Missing macOS updater bundle target "app"/,
		);
		assert.equal(readFileSync(file, 'utf8'), before);
		config.bundle.targets.push('app');
		writeFileSync(file, JSON.stringify(config));
		const passed = spawnSync(process.execPath, [script, '--check'], {
			encoding: 'utf8',
		});
		assert.equal(passed.status, 0, passed.stderr);
		assert.match(passed.stdout, /release bundle targets are configured/);
	});

for (const helper of ['updater-config', 'version'])
	test(`${helper} imports do not execute the CLI, including stdin entry points`, () => {
		const url = new URL(`../scripts/${helper}.mjs`, import.meta.url).href;
		for (const entry of [
			undefined,
			'-',
			'./missing-entry-file.mjs',
			fileURLToPath(import.meta.url),
		]) {
			const source = `process.argv[1] = ${JSON.stringify(entry) ?? 'undefined'}; await import(${JSON.stringify(url)}); console.log('Imported without running CLI.');`;
			const result = spawnSync(
				process.execPath,
				['--input-type=module', '-'],
				{
					input: source,
					encoding: 'utf8',
				},
			);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout.trim(), 'Imported without running CLI.');
		}
	});

test('accepts Tauri public-key exports and rejects private, truncated and malformed inputs', () => {
	const key = publicKey();
	assert.equal(validatePublicKey(` ${key}\n`), key);
	for (const invalid of [
		'',
		'not a key',
		key.slice(1),
		Buffer.from(
			'untrusted comment: minisign encrypted secret key\n' +
				'A'.repeat(56),
		).toString('base64'),
		Buffer.from(
			'untrusted comment: minisign public key\n' +
				Buffer.alloc(41).toString('base64'),
		).toString('base64'),
		Buffer.from(
			'untrusted comment: minisign public key\n' +
				Buffer.alloc(42).toString('base64'),
		).toString('base64'),
	])
		assert.throws(() => validatePublicKey(invalid));
});

for (const newline of ['\n', '\r\n'])
	test(`configuration preserves formatting and refuses accidental key rotation (${JSON.stringify(newline)})`, t => {
		const root = mkdtempSync(path.join(os.tmpdir(), 'slime2-updater-'));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(path.join(root, 'src-tauri'));
		const file = path.join(root, 'src-tauri/tauri.conf.json');
		const before =
			'{\n\t"bundle": { "targets": ["msi"] },\n\t"plugins": { "updater": { "pubkey": "", "windows": {"installMode":"passive"} } }\n}\n'.replace(
				/\n/g,
				newline,
			);
		writeFileSync(file, before);
		assert.throws(() => configureUpdater(root, 'private-key'), /public/);
		assert.equal(readFileSync(file, 'utf8'), before);
		assert.equal(configureUpdater(root, publicKey()), true);
		const after = readFileSync(file, 'utf8');
		assert.equal(
			after,
			before.replace('"pubkey": ""', `"pubkey": "${publicKey()}"`),
		);
		assert.equal(configureUpdater(root, publicKey()), false);
		assert.throws(() => configureUpdater(root, publicKey(8)), /rotation/);
		assert.equal(readFileSync(file, 'utf8'), after);
	});
