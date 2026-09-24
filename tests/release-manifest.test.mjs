import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishSignedRelease } from '../scripts/publish-release.mjs';

const targets = [
	['windows-x86_64-msi', 'windows-x86_64', 'Windows-X64.msi'],
	['windows-aarch64-msi', 'windows-aarch64', 'Windows-ARM64.msi'],
	['darwin-x86_64-app', 'darwin-x86_64', 'macOS-X64.app.tar.gz'],
	['darwin-aarch64-app', 'darwin-aarch64', 'macOS-ARM64.app.tar.gz'],
	['linux-x86_64-appimage', 'linux-x86_64', 'Linux-X64.AppImage'],
	['linux-aarch64-appimage', 'linux-aarch64', 'Linux-ARM64.AppImage'],
];

// Synthetic metadata only; these packets do not cryptographically sign files.
function publicKey() {
	const packet = Buffer.alloc(42, 7);
	packet.write('Ed');
	return Buffer.from(
		`untrusted comment: minisign public key: test fixture\n${packet.toString('base64')}\n`,
	).toString('base64');
}

function signature(fill = 7) {
	const packet = Buffer.alloc(74, fill);
	packet.write('ED');
	return Buffer.from(
		`untrusted comment: signature from minisign secret key\n${packet.toString('base64')}\ntrusted comment: synthetic fixture\n${Buffer.alloc(64, 7).toString('base64')}\n`,
	).toString('base64');
}

function fixture(versionSuffix = '-test') {
	const version = '1.5.3';
	const context = {
		repo: { owner: 'maskarauder', repo: 'slime2-desktop' },
		sha: 'a'.repeat(40),
	};
	const tag = `v${version}${versionSuffix}`;
	const release = {
		id: 12,
		draft: true,
		tag_name: tag,
		target_commitish: context.sha,
		body: 'Synthetic release notes.',
	};
	const assets = [];
	const bodies = new Map();
	for (const [, , suffix] of targets) {
		const id = assets.length + 100;
		const name = `Slime2-${tag}_${suffix}`;
		assets.push({
			id,
			name,
			size: 42,
			state: 'uploaded',
			url: `https://api.github.com/repos/maskarauder/slime2-desktop/releases/assets/${id}`,
		});
		const body = Buffer.from(signature());
		assets.push({
			id: id + 1,
			name: `${name}.sig`,
			size: body.length,
			state: 'uploaded',
		});
		bodies.set(id + 1, body);
	}
	const calls = [];
	let uploadError;
	const github = {
		rest: {
			repos: {
				async getRelease(args) {
					calls.push(['getRelease', args]);
					return { data: release };
				},
				listReleaseAssets() {},
				async deleteReleaseAsset(args) {
					calls.push(['delete', args]);
				},
				async uploadReleaseAsset(args) {
					calls.push(['upload', args]);
					if (uploadError) throw uploadError;
					return { data: { id: 999, state: 'uploaded' } };
				},
				async updateRelease(args) {
					calls.push(['publish', args]);
					return { data: {} };
				},
			},
		},
		async paginate(method, args) {
			assert.equal(method, github.rest.repos.listReleaseAssets);
			assert.equal(args.per_page, 100);
			calls.push(['list', args]);
			return assets;
		},
		async request(route, args) {
			assert.equal(
				route,
				'GET /repos/{owner}/{repo}/releases/assets/{asset_id}',
			);
			assert.equal(args.headers.accept, 'application/octet-stream');
			assert(
				bodies.has(args.asset_id),
				'Must only download the six signatures.',
			);
			calls.push(['download', args]);
			return { data: bodies.get(args.asset_id) };
		},
	};
	return {
		args: {
			github,
			context,
			version,
			versionSuffix,
			releaseId: '12',
			publicKey: publicKey(),
		},
		assets,
		bodies,
		calls,
		release,
		failUpload(error) {
			uploadError = error;
		},
	};
}

function mutations(f) {
	return f.calls.filter(([name]) =>
		['delete', 'upload', 'publish'].includes(name),
	);
}

for (const suffix of ['', '-test'])
	test(`publishes a complete manifest once for ${suffix || 'stable'}, including both macOS updater keys`, async () => {
		const f = fixture(suffix);
		const manifest = await publishSignedRelease(f.args);
		assert.equal(manifest.version, '1.5.3');
		assert.equal(manifest.notes, f.release.body);
		assert(Number.isFinite(Date.parse(manifest.pub_date)));
		assert.equal(Object.keys(manifest.platforms).length, 12);
		for (const [target, alias, installerSuffix] of targets) {
			const installer = f.assets.find(asset =>
				asset.name.endsWith(installerSuffix),
			);
			assert.equal(manifest.platforms[target].url, installer.url);
			assert.equal(manifest.platforms[target].signature, signature());
			assert.deepEqual(
				manifest.platforms[alias],
				manifest.platforms[target],
			);
		}
		assert.deepEqual(
			f.calls.map(([name]) => name),
			[
				'getRelease',
				'list',
				...Array(6).fill('download'),
				'upload',
				'publish',
			],
		);
		const upload = f.calls.find(([name]) => name === 'upload')[1];
		assert.equal(upload.name, 'latest.json');
		assert.equal(upload.headers['content-type'], 'application/json');
		assert.equal(upload.headers['content-length'], upload.data.length);
		assert.deepEqual(JSON.parse(upload.data), manifest);
		assert.deepEqual(f.calls.at(-1)[1], {
			...f.args.context.repo,
			release_id: 12,
			draft: false,
			prerelease: suffix !== '',
			make_latest: suffix === '' ? 'true' : 'false',
		});
	});

test('replaces a stale, missing-platform or unreadable manifest without downloading or merging it', async () => {
	const f = fixture();
	f.assets.push({
		id: 900,
		name: 'latest.json',
		state: 'uploaded',
		size: 99,
	});
	await publishSignedRelease(f.args);
	assert.deepEqual(
		f.calls.map(([name]) => name),
		[
			'getRelease',
			'list',
			...Array(6).fill('download'),
			'delete',
			'upload',
			'publish',
		],
	);
	assert.equal(f.calls.find(([name]) => name === 'delete')[1].asset_id, 900);
});

for (const [label, change, message] of [
	[
		'a published release',
		f => {
			f.release.draft = false;
		},
		/unpublished draft/,
	],
	[
		'a different tag',
		f => {
			f.release.tag_name = 'v1.5.2-test';
		},
		/exact commit/,
	],
	[
		'a different source commit',
		f => {
			f.release.target_commitish = 'b'.repeat(40);
		},
		/exact commit/,
	],
	[
		'a branch in place of an exact commit',
		f => {
			f.release.target_commitish = 'main';
		},
		/exact commit/,
	],
	[
		'a different release ID',
		f => {
			f.release.id = 13;
		},
		/unpublished draft/,
	],
	[
		'an invalid version',
		f => {
			f.args.version = '1.5.3-test';
		},
		/numeric app version/,
	],
	[
		'an unexpected suffix',
		f => {
			f.args.versionSuffix = '-other';
		},
		/release suffix/,
	],
	[
		'an invalid public key',
		f => {
			f.args.publicKey = 'invalid';
		},
		/public/,
	],
	[
		'a missing macOS installer',
		f => {
			f.assets.splice(4, 1);
		},
		/Missing installer for darwin-x86_64-app: expected Slime2-v1\.5\.3-test_macOS-X64\.app\.tar\.gz/,
	],
	[
		'a missing macOS signature',
		f => {
			f.assets.splice(5, 1);
		},
		/Missing signature for darwin-x86_64-app: expected Slime2-v1\.5\.3-test_macOS-X64\.app\.tar\.gz\.sig/,
	],
	[
		'a duplicate installer',
		f => {
			f.assets.push({ ...f.assets[4] });
		},
		/Duplicate installer for darwin-x86_64-app/,
	],
	[
		'an incomplete installer',
		f => {
			f.assets[4].state = 'starter';
		},
		/incomplete installer for darwin-x86_64-app/,
	],
	[
		'an empty installer',
		f => {
			f.assets[4].size = 0;
		},
		/incomplete installer for darwin-x86_64-app/,
	],
	[
		'an unrelated asset URL',
		f => {
			f.assets[4].url = 'https://example.invalid/installer';
		},
		/Unexpected installer URL for darwin-x86_64-app/,
	],
	[
		'an incomplete signature',
		f => {
			f.assets[5].state = 'starter';
		},
		/incomplete signature for darwin-x86_64-app/,
	],
	[
		'an oversized signature',
		f => {
			f.assets[5].size = 1024 * 1024 + 1;
		},
		/incomplete signature for darwin-x86_64-app/,
	],
	[
		'a truncated signature download',
		f => {
			f.bodies.set(f.assets[5].id, Buffer.from('broken'));
		},
		/Incomplete signature for darwin-x86_64-app/,
	],
	[
		'a malformed signature',
		f => {
			const body = Buffer.from('invalid-base64');
			f.assets[5].size = body.length;
			f.bodies.set(f.assets[5].id, body);
		},
		/Malformed signature for darwin-x86_64-app/,
	],
	[
		'a different signing key',
		f => {
			f.bodies.set(f.assets[5].id, Buffer.from(signature(8)));
		},
		/Signature for darwin-x86_64-app uses a different updater key: Slime2-v1\.5\.3-test_macOS-X64\.app\.tar\.gz\.sig/,
	],
])
	test(`rejects ${label} before changing the draft or its assets`, async () => {
		const f = fixture();
		f.assets.push({ id: 900, name: 'latest.json', size: 99 });
		change(f);
		await assert.rejects(publishSignedRelease(f.args), message);
		assert.deepEqual(mutations(f), []);
	});

test('a manifest upload failure leaves the release unpublished', async () => {
	const f = fixture();
	f.failUpload(new Error('simulated upload interruption'));
	await assert.rejects(
		publishSignedRelease(f.args),
		/simulated upload interruption/,
	);
	assert.deepEqual(
		mutations(f).map(([name]) => name),
		['upload'],
	);
});
