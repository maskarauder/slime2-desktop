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
import { test } from 'node:test';
import { planVersion, writeVersion } from '../scripts/version.mjs';

const files = [
	'package.json',
	'package-lock.json',
	'src-overlay/package.json',
	'src-overlay/package-lock.json',
	'src-tauri/Cargo.toml',
	'src-tauri/Cargo.lock',
	'src-tauri/tauri.conf.json',
	'pkgbuild/PKGBUILD',
	'src-tauri/youtube-stream/Cargo.toml',
	'src-tauri/native-tests/Cargo.toml',
];
function project(t, crlf = false) {
	const root = mkdtempSync(path.join(os.tmpdir(), 'slime2-version-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const file of files) {
		const text = readFileSync(
			new URL(`../${file}`, import.meta.url),
			'utf8',
		).replace(/\r\n/g, '\n');
		// Each case controls its line endings, independent of the Git checkout.
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(
			path.join(root, file),
			crlf ? text.replace(/\n/g, '\r\n') : text,
		);
	}
	const read = file => readFileSync(path.join(root, file), 'utf8');
	const before = Object.fromEntries(files.map(file => [file, read(file)]));
	return { root, read, before };
}

test('version CLI validates and detects drift through a symlinked project directory', t => {
	const p = project(t);
	mkdirSync(path.join(p.root, 'scripts'));
	cpSync(
		new URL('../scripts/version.mjs', import.meta.url),
		path.join(p.root, 'scripts/version.mjs'),
	);
	const temporary = mkdtempSync(
		path.join(os.tmpdir(), 'slime2-version-link-'),
	);
	t.after(() => rmSync(temporary, { recursive: true, force: true }));
	const alias = path.join(temporary, 'linked project');
	symlinkSync(
		realpathSync(p.root),
		alias,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
	const script = path.join(alias, 'scripts/version.mjs');
	const passed = spawnSync(process.execPath, [script, '--check'], {
		encoding: 'utf8',
	});
	assert.equal(passed.status, 0, passed.stderr);
	assert.match(passed.stdout, /Verified app version/);
	const file = 'src-overlay/package.json';
	const config = JSON.parse(p.read(file));
	config.version = '0.0.1';
	writeFileSync(
		path.join(p.root, file),
		JSON.stringify(config, null, '\t') + '\n',
	);
	const failed = spawnSync(process.execPath, [script, '--check'], {
		encoding: 'utf8',
	});
	assert.equal(failed.status, 1);
	assert.match(failed.stderr, /Version drift/);
	assert.equal(JSON.parse(p.read(file)).version, '0.0.1');
});

for (const crlf of [false, true])
	test(`version bump preserves dependencies, independent crate versions and ${crlf ? 'CRLF' : 'LF'} formatting`, t => {
		const p = project(t, crlf);
		assert.equal(p.read('package.json').includes('\r\n'), crlf);
		const current = JSON.parse(p.read('package.json')).version;
		assert.equal(planVersion(p.root).changes.length, 0);
		const next = current === '1.5.9' ? '1.5.8' : '1.5.9';
		const { changes } = planVersion(p.root, next);
		assert.equal(changes.length, 7);
		// Planning/dry runs must not change files.
		for (const file of files) assert.equal(p.read(file), p.before[file]);
		writeVersion(p.root, changes);
		assert.equal(planVersion(p.root).changes.length, 0);
		assert.equal(JSON.parse(p.read('package.json')).version, next);
		// Returning to the old version restores every byte, including lockfile dependency entries.
		writeVersion(p.root, planVersion(p.root, current).changes);
		for (const file of files)
			assert.equal(p.read(file), p.before[file], file);
	});

test('rejects invalid/MSI-incompatible versions without changing files', t => {
	const p = project(t);
	for (const value of [
		'1',
		'v1.5.0',
		'01.5.0',
		'1.5.0-beta',
		'256.0.0',
		'1.256.0',
		'1.0.65536',
		'1.2.3\n',
	])
		assert.throws(() => planVersion(p.root, value));
	for (const file of files) assert.equal(p.read(file), p.before[file]);
});

for (const crlf of [false, true])
	test(`detects nested lockfile version drift and preserves dependencies and ${crlf ? 'CRLF' : 'LF'} formatting`, t => {
		const p = project(t, crlf);
		const file = 'src-overlay/package-lock.json';
		const lock = JSON.parse(p.read(file));
		lock.packages[''].version = '0.0.1';
		const modified = JSON.stringify(lock, null, '\t') + '\n';
		writeFileSync(
			path.join(p.root, file),
			crlf ? modified.replace(/\n/g, '\r\n') : modified,
		);
		assert.deepEqual(
			planVersion(p.root).changes.map(change => change.file),
			[file],
		);
		writeVersion(p.root, planVersion(p.root).changes);
		assert.equal(p.read(file), p.before[file]);
	});

test('preflights malformed manifests and a missing app Cargo lock entry before writing', t => {
	const p = project(t);
	const lock = 'src-tauri/Cargo.lock';
	writeFileSync(
		path.join(p.root, lock),
		p.read(lock).replace('name = "slime2"', 'name = "different-app"'),
	);
	assert.throws(() => planVersion(p.root, '1.5.9'), /exactly one slime2/);
	assert.equal(p.read('package.json'), p.before['package.json']);
	writeFileSync(path.join(p.root, lock), p.before[lock]);
	writeFileSync(path.join(p.root, 'src-overlay/package-lock.json'), '{');
	assert.throws(() => planVersion(p.root, '1.5.9'));
	assert.equal(p.read('package.json'), p.before['package.json']);
});

test('refuses to overwrite an edit made after version planning', t => {
	const p = project(t);
	const plan = planVersion(p.root, '1.5.9');
	writeFileSync(
		path.join(p.root, 'pkgbuild/PKGBUILD'),
		p.read('pkgbuild/PKGBUILD') + '\n# concurrent edit\n',
	);
	assert.throws(
		() => writeVersion(p.root, plan.changes),
		/changed while preparing/,
	);
	assert.equal(p.read('package.json'), p.before['package.json']);
	assert(p.read('pkgbuild/PKGBUILD').endsWith('# concurrent edit\n'));
});

test('requires Tauri to reference the canonical app version', t => {
	const p = project(t);
	const file = 'src-tauri/tauri.conf.json';
	const config = JSON.parse(p.read(file));
	config.version = '1.0.0';
	writeFileSync(path.join(p.root, file), JSON.stringify(config));
	assert.throws(() => planVersion(p.root), /must read version from/);
});
