import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

const FORK_URL = 'https://github.com/maskarauder/slime2-desktop';
const update = {
	tag: 'v1.6.0',
	url: `${FORK_URL}/releases/tag/v1.6.0`,
	channel: 'stable',
	hasManifest: true,
};
const settings = {
	checkUpdatesOnStart: false,
	autoInstallUpdates: false,
	updateChannel: 'stable',
};
function release(tag = update.tag, changes = {}) {
	return {
		tag_name: tag,
		html_url: `${FORK_URL}/releases/tag/${tag}`,
		draft: false,
		prerelease: tag.includes('-'),
		assets: [
			{ name: 'Slime2-Windows-X64.msi', state: 'uploaded', size: 100 },
			{ name: 'latest.json', state: 'uploaded', size: 100 },
		],
		...changes,
	};
}
function response(data = [release()], status = 200) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => data,
	};
}
function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function updater(fetch) {
	return loadTs('src/helpers/updates.ts', {}, { fetch, AbortSignal });
}
function installation(overrides = {}) {
	const calls = [],
		logs = [];
	const api = loadTs(
		'src/helpers/updateInstallation.ts',
		{
			'./commands': {
				getUpdateSupport: async () => {
					calls.push('support');
					return { supported: true };
				},
				prepareReleaseUpdate: async (tag, progress) => {
					calls.push(['prepare', tag]);
					progress({
						stage: 'downloading',
						downloaded: 50,
						total: 100,
					});
					return { token: 'synthetic-prepared-update' };
				},
				installPreparedUpdate: async token => {
					calls.push(['install', token]);
				},
				discardPreparedUpdate: async token => {
					calls.push(['discard', token]);
				},
				...overrides.commands,
			},
			'./json/queueSaveJson': {
				flushQueuedSaves:
					overrides.flush ??
					(async () => {
						calls.push('flush');
					}),
			},
		},
		{
			AbortSignal,
			fetch:
				overrides.fetch ??
				(async () => {
					calls.push('fetch');
					return response();
				}),
			console: {
				info: (...values) => logs.push(values),
				warn: (...values) => logs.push(values),
			},
		},
	);
	return { api, calls, logs };
}

test('existing settings default to automatic installation off and persist an explicit opt-in', async () => {
	let saved = { checkUpdatesOnStart: true, updateChannel: 'test' };
	const api = loadTs('src/helpers/json/settings.ts', {
		'../commands': { loadJson: async () => saved },
		'./jsonPaths': {
			mainConfigPath: async () => 'synthetic/settings.json',
		},
		'./queueSaveJson': {
			queueSaveJson: value => {
				saved = structuredClone(value);
			},
		},
	});
	const oldSettings = await api.loadSettings();
	assert.equal(oldSettings.autoInstallUpdates, false);
	assert.equal(oldSettings.checkUpdatesOnStart, true);
	assert.equal(oldSettings.updateChannel, 'test');
	await api.saveSettings({ ...oldSettings, autoInstallUpdates: true });
	assert.equal((await api.loadSettings()).autoInstallUpdates, true);
});

test('update readiness requires an uploaded nonempty latest.json on the selected release', async () => {
	for (const manifest of [
		undefined,
		{ name: 'latest.json', state: 'new', size: 100 },
		{ name: 'latest.json', state: 'uploaded', size: 0 },
		{ name: 'latest.json.sig', state: 'uploaded', size: 100 },
		{ name: 'latest.json', state: 'uploaded', size: 100 },
	]) {
		const assets = [
			{ name: 'Slime2-Windows-X64.msi', state: 'uploaded', size: 100 },
		];
		if (manifest) assets.push(manifest);
		const api = updater(async () =>
			response([
				release('v1.5.3'),
				release('v1.6.0', { assets }),
				release('v1.7.0-test.1'),
			]),
		);
		const result = await api.checkForUpdate('1.5.2', 'stable');
		assert.equal(result.newer, true);
		assert.equal(api.getAvailableUpdate().tag, 'v1.6.0');
		assert.equal(
			api.getAvailableUpdate().hasManifest,
			manifest?.name === 'latest.json' &&
				manifest.state === 'uploaded' &&
				manifest.size > 0,
		);
	}
});

test('a late check cannot overwrite the result from a newer channel check', async () => {
	const first = deferred(),
		second = deferred();
	let count = 0;
	const api = updater(() => (++count === 1 ? first.promise : second.promise));
	const notifications = [];
	api.subscribeUpdates(() =>
		notifications.push(api.getAvailableUpdate()?.channel),
	);
	const oldCheck = api.checkForUpdate('1.5.2', 'stable');
	const newCheck = api.checkForUpdate('1.5.2', 'test');
	second.resolve(response([release('v1.7.0-test.1')]));
	await newCheck;
	first.resolve(response());
	await oldCheck;
	assert.equal(api.getAvailableUpdate().tag, 'v1.7.0-test.1');
	assert.equal(api.getAvailableUpdate().channel, 'test');
	assert.deepEqual(notifications, ['test']);
});

test('GitHub rate limits and invalid responses stay visible and never publish an update', async () => {
	for (const [result, pattern] of [
		[response([], 403), /rate limit/],
		[response([], 429), /rate limit/],
		[response([], 503), /HTTP 503/],
		[response({ error: 'synthetic response' }), /invalid release list/],
	]) {
		const api = updater(async () => result);
		await assert.rejects(api.checkForUpdate('1.5.2', 'stable'), pattern);
		assert.equal(api.getAvailableUpdate(), null);
	}
});

test('an aborted check cannot publish even when its fetch resolves late', async () => {
	const pending = deferred(),
		controller = new AbortController();
	let requestSignal;
	const api = updater((_url, options) => {
		requestSignal = options.signal;
		return pending.promise;
	});
	const work = api.checkForUpdate('1.5.2', 'stable', controller.signal);
	controller.abort();
	assert.equal(requestSignal.aborted, true);
	pending.resolve(response());
	await work;
	assert.equal(api.getAvailableUpdate(), null);
});

test('startup remains opt-in, with check-only and automatic installation kept separate', async () => {
	for (const checkUpdatesOnStart of [false, true]) {
		for (const autoInstallUpdates of [false, true]) {
			const { api, calls } = installation();
			await api.runStartupUpdate(
				'1.5.2',
				{
					...settings,
					checkUpdatesOnStart,
					autoInstallUpdates,
				},
				new AbortController().signal,
			);
			assert.equal(
				calls.includes('fetch'),
				checkUpdatesOnStart || autoInstallUpdates,
			);
			assert.equal(
				calls.some(value => value[0] === 'install'),
				autoInstallUpdates,
			);
		}
	}
});

test('startup cancellation and an up-to-date app never prepare or install', async () => {
	const { api, calls } = installation();
	const controller = new AbortController();
	controller.abort();
	await api.runStartupUpdate(
		'1.5.2',
		{ ...settings, autoInstallUpdates: true },
		controller.signal,
	);
	assert.deepEqual(calls, []);
	await api.runStartupUpdate(
		'1.6.0',
		{ ...settings, autoInstallUpdates: true },
		new AbortController().signal,
	);
	assert.deepEqual(calls, ['fetch']);
});

test('manual update checks only discover releases and do not invoke the native installer', async () => {
	let nativeCalls = 0;
	const api = loadTs(
		'src/helpers/updates.ts',
		{
			'./commands': new Proxy(
				{},
				{
					get() {
						nativeCalls++;
						throw Error('Unexpected native call');
					},
				},
			),
		},
		{ fetch: async () => response(), AbortSignal },
	);
	await api.checkForUpdate('1.5.2', 'stable');
	assert.equal(api.getAvailableUpdate().hasManifest, true);
	assert.equal(nativeCalls, 0);
});

test('concurrent installation requests share a job and await saved configuration before installing', async () => {
	const saved = deferred(),
		savingStarted = deferred();
	const { api, calls } = installation({
		flush: () => {
			calls.push('flush-start');
			savingStarted.resolve();
			return saved.promise;
		},
	});
	const phases = [];
	api.subscribeInstallation(() =>
		phases.push(api.getUpdateInstallation().phase),
	);
	const first = api.installUpdate(update),
		second = api.installUpdate(update);
	assert.equal(first, second);
	await savingStarted.promise;
	assert.equal(api.getUpdateInstallation().phase, 'saving');
	assert.equal(calls.filter(value => value[0] === 'prepare').length, 1);
	assert.equal(
		calls.some(value => value[0] === 'install'),
		false,
	);
	saved.resolve();
	await first;
	assert.deepEqual(calls, [
		'support',
		['prepare', update.tag],
		'flush-start',
		['install', 'synthetic-prepared-update'],
	]);
	assert.deepEqual(phases, [
		'checking',
		'downloading',
		'saving',
		'installing',
	]);
});

test('unsigned, unsupported and failed-signature preparations never install or flush saves', async () => {
	for (const scenario of ['manifest', 'unsupported', 'signature']) {
		const { api, calls } = installation({
			commands: {
				getUpdateSupport: async () => ({
					supported: scenario !== 'unsupported',
					reason: 'Unsupported build',
				}),
				prepareReleaseUpdate: async () => {
					throw Error('Installer signature is invalid');
				},
			},
		});
		await api.installUpdate({
			...update,
			hasManifest: scenario !== 'manifest',
		});
		assert.equal(api.getUpdateInstallation().phase, 'error');
		assert.deepEqual(calls, []);
	}
});

test('failed configuration saves discard prepared bytes and preserve the running app', async () => {
	const { api, calls } = installation({
		flush: async () => {
			throw Error('Disk is full');
		},
	});
	await api.installUpdate(update);
	assert.equal(api.getUpdateInstallation().phase, 'error');
	assert.match(api.getUpdateInstallation().message, /Disk is full/);
	assert.deepEqual(calls, [
		'support',
		['prepare', update.tag],
		['discard', 'synthetic-prepared-update'],
	]);
	assert.equal(api.installationBusy(), false);
});

test('installer failures remain stopped until an explicit retry and release the prepared token', async () => {
	let attempts = 0;
	const { api, calls } = installation({
		commands: {
			installPreparedUpdate: async () => {
				attempts++;
				if (attempts === 1) throw Error('Installer could not start');
			},
		},
	});
	await api.installUpdate(update);
	assert.equal(attempts, 1);
	assert.equal(api.getUpdateInstallation().phase, 'error');
	assert.deepEqual(calls.at(-1), ['discard', 'synthetic-prepared-update']);
	await Promise.resolve();
	assert.equal(attempts, 1);
	await api.installUpdate(update);
	assert.equal(attempts, 2);
	assert.equal(api.getUpdateInstallation().phase, 'installing');
	assert.equal(calls.filter(value => value[0] === 'prepare').length, 2);
});

test('late download progress cannot replace saving or installation status', async () => {
	let report;
	const saved = deferred(),
		savingStarted = deferred();
	const { api } = installation({
		commands: {
			prepareReleaseUpdate: async (_tag, onProgress) => {
				report = onProgress;
				return { token: 'synthetic-prepared-update', version: '1.6.0' };
			},
		},
		flush: () => {
			savingStarted.resolve();
			return saved.promise;
		},
	});
	const job = api.installUpdate(update);
	await savingStarted.promise;
	report({ stage: 'downloading', downloaded: 40, total: 50 });
	assert.equal(api.getUpdateInstallation().phase, 'saving');
	saved.resolve();
	await job;
	report({ stage: 'downloading', downloaded: 50, total: 50 });
	assert.equal(api.getUpdateInstallation().phase, 'installing');
});
