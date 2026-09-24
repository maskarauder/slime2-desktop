import assert from 'node:assert/strict';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	configureUpdater,
	validatePublicKey,
} from '../scripts/updater-config.mjs';

function publicKey(fill = 7) {
	const bytes = Buffer.alloc(42, fill);
	bytes.write('Ed');
	return Buffer.from(
		`untrusted comment: minisign public key: synthetic test key\n${bytes.toString('base64')}\n`,
	).toString('base64');
}

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
