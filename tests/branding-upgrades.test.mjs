import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = file =>
	readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));

test('the renamed product retains the previous installation and account identity', () => {
	assert.equal(config.identifier, 'stream.slime2.desktop');
	assert.equal(config.mainBinaryName, 'Slime2');
	// Tauri's original UUIDv5(DNS, "Slime2.exe.app.x64"), for both MSI architectures.
	assert.equal(
		config.bundle.windows.wix.upgradeCode,
		'f8922db7-c2f9-5ee4-9fa1-206acc0a85bf',
	);
	assert.match(
		read('src-tauri/src/secret.rs'),
		/KEYRING_SERVICE_NAME: &str = "slime2\.stream"/,
	);
});

test('renamed Linux packages replace the package that owns the existing executable', () => {
	const { deb, rpm } = config.bundle.linux;
	assert(deb.provides.includes('slime2'));
	assert(deb.replaces.includes('slime2'));
	assert(deb.conflicts.includes('slime2'));
	assert(rpm.provides.includes('slime2'));
	assert(rpm.obsoletes.includes('slime2'));
});
