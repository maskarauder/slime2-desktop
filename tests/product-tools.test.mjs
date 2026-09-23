import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

test('stale connection owners cannot change a replacement and reconnect is account-scoped', () => {
	const api = loadTs('src/helpers/connectionStatus.ts'),
		old = api.beginConnection('youtube'),
		twitch = api.beginConnection('twitch');
	twitch.update({ state: 'connected' });
	const current = api.beginConnection('youtube');
	current.update({ state: 'waiting', retryAt: 123 });
	old.update({ state: 'error' });
	old.dispose();
	assert.equal(api.getConnections().youtube.state, 'waiting');
	const restarted = [],
		unsubscribe = api.subscribeReconnect(id => restarted.push(id));
	api.reconnectNow('youtube');
	api.reconnectNow('youtube');
	assert.deepEqual(restarted, ['youtube']);
	assert.equal(api.getConnections().twitch.state, 'connected');
	unsubscribe();
	current.dispose();
	twitch.dispose();
	assert.equal(Object.keys(api.getConnections()).length, 0);
});
test('diagnostics redact credentials and overlay capabilities and bound the log tail', () => {
	const api = loadTs('src/helpers/diagnostics.ts'),
		secret = 'not-a-real-secret';
	const log = [
		`Authorization: Bearer ${secret}`,
		`{"client_secret":"${secret}","apiKey":"${secret}"}`,
		`http://127.0.0.1:57143/w/widget_1#token=${secret}`,
		`https://service.example/api?code=${secret}`,
		'YouTube stream failed (HTTP 403)',
	].join('\n');
	const report = api.buildDiagnostics(
		'1.5.0',
		{
			a: {
				service: 'youtube',
				type: 'read',
				reauthorize: true,
				accessToken: secret,
			},
		},
		{
			w: {
				name: 'Sample widget',
				version: '2',
				type: ['overlay'],
				values: { key: secret },
			},
		},
		log,
	);
	assert(!JSON.stringify(report).includes(secret));
	assert(report.logs.includes('HTTP 403'));
	assert.equal(report.accounts[0].connection.state, 'reauthorize');
	assert(
		api.redactDiagnosticLog(Array(5000).fill('line').join('\n')).split('\n')
			.length <= 2000,
	);
});
test('update selection handles release channels and rejects drafts, debug and invalid releases', () => {
	const api = loadTs('src/helpers/updates.ts'),
		release = (tag, extra = {}) => ({
			tag_name: tag,
			html_url: `${api.FORK_URL}/releases/tag/${tag}`,
			draft: false,
			prerelease: tag.includes('-'),
			assets: [{ state: 'uploaded', size: 50 }],
			...extra,
		});
	const list = [
		null,
		{ tag_name: 'v9.0.0', assets: 'invalid' },
		release('v1.9.0'),
		release('v1.10.0-test.2'),
		release('v2.0.0', { draft: true }),
		release('v1.11.0-debug'),
		release('v2.0.0', { assets: [] }),
		release('v1.12.0', { html_url: 'https://example.invalid' }),
	];
	assert.equal(api.selectRelease(list, 'stable').tag_name, 'v1.9.0');
	assert.equal(api.selectRelease(list, 'test').tag_name, 'v1.10.0-test.2');
	assert(api.compareVersions('1.10.0', '1.9.0') > 0);
	assert(api.compareVersions('1.5.0-test.10', '1.5.0-test.2') > 0);
	assert(api.compareVersions('1.5.0', '1.5.0-test') > 0);
	assert.equal(api.compareVersions('1.5.0+build', 'v1.5.0'), 0);
});
test('generic mapping preserves widget fields and rejects ownership conflicts', () => {
	const api = loadTs('src/helpers/accountLinkEditor.ts'),
		fields = {
			idField: 'viewer',
			accountsField: 'identities',
			platformField: 'site',
			accountField: 'uid',
		};
	const rows = api.readLinkedIdentities(
		[
			{
				viewer: 'sample',
				identities: [{ site: 'tiktok', uid: '9000000000000000001' }],
				extra: 'keep',
			},
		],
		fields,
	);
	assert.equal(rows[0].accounts[0].account, '9000000000000000001');
	assert.equal(api.writeLinkedIdentities(rows, fields)[0].extra, 'keep');
	assert.throws(
		() =>
			api.writeLinkedIdentities(
				[
					...rows,
					{ id: 'other', accounts: rows[0].accounts, original: {} },
				],
				fields,
			),
		/already linked/,
	);
	assert.throws(
		() =>
			api.readLinkedIdentities(
				[{ viewer: 'sample', identities: null }],
				fields,
			),
		/Invalid/,
	);
});
test('backup flush waits for in-flight saves and serializes the newest value', async () => {
	let release,
		active = 0,
		peak = 0;
	const values = [],
		gate = new Promise(resolve => {
			release = resolve;
		});
	const api = loadTs('src/helpers/json/queueSaveJson.ts', {
		'../commands': {
			saveJsonAtomic: async value => {
				active++;
				peak = Math.max(active, peak);
				values.push(value);
				if (values.length === 1) await gate;
				active--;
			},
		},
	});
	api.queueSaveJson({ value: 1 }, '/config');
	await Promise.resolve();
	api.queueSaveJson({ value: 2 }, '/config');
	let done = false;
	const flush = api.flushQueuedSaves().then(() => {
		done = true;
	});
	await Promise.resolve();
	assert.equal(done, false);
	release();
	await flush;
	assert.equal(peak, 1);
	assert.equal(values.at(-1).value, 2);
});
test('failed saves retain the newest configuration for retry', async () => {
	let fail = true;
	const values = [],
		api = loadTs(
			'src/helpers/json/queueSaveJson.ts',
			{
				'../commands': {
					saveJsonAtomic: async value => {
						if (fail) throw Error('Disk unavailable');
						values.push(value);
					},
				},
			},
			{ console: { error() {} } },
		);
	api.queueSaveJson({ keep: true }, '/config');
	await assert.rejects(api.flushQueuedSaves());
	fail = false;
	await api.flushQueuedSaves();
	assert.equal(values.at(-1).keep, true);
});
test('simulation bursts are bounded, have fresh IDs and never dispatch to bots', async () => {
	const sent = [],
		delays = [],
		api = loadTs('src/helpers/simulator.ts', {
			'./widgetMessage': {
				sendYouTubeEvent: async (...args) => sent.push(args),
			},
			'./services/youtube/youtubeChatReader': {
				abortableDelay: async ms => delays.push(ms),
			},
		});
	await api.simulateBurst({
		platform: 'youtube',
		kind: 'superChat',
		name: 'Viewer',
		text: 'Hi',
		widgetIds: ['one', 'two', 'three'],
		count: 500,
		interval: 1,
		signal: new AbortController().signal,
		onProgress() {},
	});
	assert.equal(sent.length, 300);
	assert.equal(new Set(sent.map(args => args[2])).size, 100);
	assert.equal(sent[0][5].snippet.superChatDetails.amountMicros, '5000000');
	assert(sent.every(args => args.at(-1) === false && args.at(-2) === true));
	assert(delays.every(ms => ms >= 100));
	assert(
		api
			.makeSimulation('youtube', 'emote', 'Viewer', 'Hi')
			.data.simulationFragments[1].emote.url.startsWith('https://'),
	);
});
test('cancelled simulations stop dispatch immediately', async () => {
	const controller = new AbortController();
	let count = 0;
	const api = loadTs('src/helpers/simulator.ts', {
		'./widgetMessage': {
			sendYouTubeEvent: async () => {
				count++;
				controller.abort();
			},
		},
	});
	await api.simulateBurst({
		platform: 'youtube',
		kind: 'chat',
		name: 'Viewer',
		text: 'Hi',
		widgetIds: ['one', 'two'],
		count: 100,
		interval: 100,
		signal: controller.signal,
		onProgress() {},
	});
	assert.equal(count, 1);
});
test('TikTok final gift streaks retain string IDs and suppress intermediate updates', () => {
	const { normalizeChatEvent } = loadTs(
		'src/helpers/services/tiktok/tiktokEvents.ts',
	);
	const data = {
		user: {
			userId: '9000000000000000001',
			uniqueId: 'viewer',
			nickname: 'Viewer',
		},
		common: { msgId: 'gift1' },
		giftDetails: { id: 'gift', name: 'Rose', giftType: 1 },
		repeatCount: 3,
		repeatEnd: 0,
	};
	assert.equal(
		normalizeChatEvent({ type: 'WebcastGiftMessage', data }),
		null,
	);
	const event = normalizeChatEvent({
		type: 'WebcastGiftMessage',
		data: { ...data, repeatEnd: 1 },
	});
	assert.equal(event.data.chatter_user_id, '9000000000000000001');
	assert.equal(event.data.gift.count, 3);
	assert.equal(event.data.message.text, 'Sent 3 × Rose');
});
