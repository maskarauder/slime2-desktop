import { loadTs } from './helpers/load-ts.mjs';
const routing = loadTs('src/helpers/accountRouting.ts');
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(
	readFileSync(
		new URL(
			'../src/helpers/services/platformUserLookup.ts',
			import.meta.url,
		),
		'utf8',
	),
	{
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	},
).outputText;
const youtubeId = 'UCabcdefghijkl0123456789';

function harness(options = {}) {
	const calls = [];
	let now = 1_000_000;
	const accounts = Object.fromEntries(
		['twitch', 'youtube', 'tiktok'].map(service => [
			service,
			{
				id: service,
				service,
				type: 'read',
				reauthorize: false,
				default: true,
				widgets: {},
			},
		]),
	);
	const slots = ['twitch', 'youtube', 'tiktok'].map(service => ({
		service,
		type: 'read',
	}));
	const exports = {};
	const record = async (platform, account, username, signal) => {
		calls.push({ platform, account, username, signal });
		if (options.lookup) return options.lookup(platform, username, signal);
		if (platform === 'twitch')
			return { data: { data: [{ id: '123', login: username }] } };
		if (platform === 'youtube')
			return {
				data: {
					items: [
						{
							id: youtubeId,
							snippet: { customUrl: `@${username}` },
						},
					],
				},
			};
		return '7312345678901234567';
	};
	vm.runInNewContext(compiled, {
		exports,
		AbortController,
		clearTimeout,
		setTimeout: (fn, ms) => setTimeout(fn, options.deadlineMs ?? ms),
		Date: class extends Date {
			static now() {
				return now;
			}
		},
		require: name =>
			({
				'../accountRouting': routing,
				'../commands': {
					lookupTikTokUserId: (...args) => record('tiktok', ...args),
				},
				'../json/widgetMeta': {
					loadWidgetMeta: async () => ({ accounts: slots }),
				},
				'./twitch/twitchApi': {
					__esModule: true,
					default: {
						getUserByLogin: (...args) => record('twitch', ...args),
					},
				},
				'./youtube/youtubeApi': {
					__esModule: true,
					default: {
						getChannelByHandle: (...args) =>
							record('youtube', ...args),
					},
				},
			})[name],
	});
	return {
		calls,
		accounts,
		slots,
		advance: ms => {
			now += ms;
		},
		resolve: (platform, username, widget = 'left', account = platform) =>
			exports.resolveWidgetPlatformUser(widget, accounts, {
				platform,
				username,
				account_id: account,
			}),
	};
}

test('resolves exact logins/handles on all platforms and preserves 64-bit IDs as strings', async () => {
	const h = harness();
	for (const [platform, id] of [
		['twitch', '123'],
		['youtube', youtubeId],
		['tiktok', '7312345678901234567'],
	]) {
		const result = await h.resolve(platform, '@Maskarauder');
		assert.equal(result.id, id);
		assert.equal(result.platform, platform);
		assert.equal(result.username, 'maskarauder');
	}
	assert.deepEqual(
		h.calls.map(({ platform, account, username }) => [
			platform,
			account,
			username,
		]),
		[
			['twitch', 'twitch', 'maskarauder'],
			['youtube', 'youtube', 'maskarauder'],
			['tiktok', 'tiktok', 'maskarauder'],
		],
	);
});

test('three layouts share one in-flight lookup and a bounded-lifetime success cache', async () => {
	const h = harness();
	await Promise.all(
		['left', 'right', 'vertical'].map(widget =>
			h.resolve('twitch', 'same', widget),
		),
	);
	assert.equal(h.calls.length, 1);
	await h.resolve('twitch', '@SAME');
	assert.equal(h.calls.length, 1);
	h.advance(60_001);
	await h.resolve('twitch', 'same');
	assert.equal(h.calls.length, 2);
});

test('explicit widget assignment takes precedence over a default, even for cached lookups', async () => {
	const h = harness();
	await h.resolve('twitch', 'test');
	h.accounts.override = {
		...h.accounts.twitch,
		id: 'override',
		default: false,
		widgets: { left: 0 },
	};
	await assert.rejects(h.resolve('twitch', 'test'), /Assign a connected/);
	await h.resolve('twitch', 'test', 'left', 'override');
	assert.equal(h.calls.length, 2);
	h.accounts.override.reauthorize = true;
	await assert.rejects(
		h.resolve('twitch', 'test', 'left', 'override'),
		/Assign a connected/,
	);
});

test('rejects accounts not in widget slots and malformed names before spending API requests', async () => {
	const h = harness();
	h.slots.length = 0;
	await assert.rejects(h.resolve('youtube', 'someone'), /Assign a connected/);
	for (const [platform, input] of [
		['twitch', 'https://twitch.tv/user'],
		['youtube', 'Some Display Name'],
		['tiktok', '../name'],
		['tiktok', '@@name'],
	]) {
		await assert.rejects(h.resolve(platform, input), /username or @handle/);
	}
	assert.equal(h.calls.length, 0);
});

test('supports Unicode YouTube handles and numeric usernames as exact names', async () => {
	const h = harness();
	await h.resolve('youtube', '@日本語');
	await h.resolve('twitch', '@12345');
	assert.deepEqual(
		h.calls.map(call => call.username),
		['日本語', '12345'],
	);
});

test('never accepts a mismatched, missing, ambiguous or numeric-in-JSON result as an ID', async () => {
	for (const [platform, result] of [
		['twitch', { data: { data: [{ id: '123', login: 'someone_else' }] } }],
		[
			'twitch',
			{
				data: {
					data: [
						{ id: '123', login: 'name' },
						{ id: '456', login: 'name' },
					],
				},
			},
		],
		['youtube', { data: { items: [] } }],
		[
			'youtube',
			{
				data: {
					items: [
						{ id: youtubeId, snippet: { customUrl: '@other' } },
					],
				},
			},
		],
		['youtube', { data: { items: [{ id: 'name', snippet: {} }] } }],
		['tiktok', 7312345678901234567],
		['tiktok', 'nickname'],
	]) {
		const h = harness({ lookup: async () => result });
		await assert.rejects(h.resolve(platform, 'name'), /No unique/);
	}
});

test('failure coalescing prevents three layouts from repeating a denied request; no secrets are returned', async () => {
	const h = harness({
		lookup: async () => {
			throw {
				response: { status: 403, data: { secret: 'do-not-log' } },
				config: { headers: { Authorization: 'do-not-log' } },
			};
		},
	});
	const results = await Promise.allSettled(
		['left', 'right', 'vertical'].map(widget =>
			h.resolve('youtube', 'name', widget),
		),
	);
	assert.equal(h.calls.length, 1);
	for (const result of results) {
		assert.equal(result.status, 'rejected');
		assert.match(result.reason.message, /denied/);
		assert.doesNotMatch(result.reason.message, /do-not-log/);
	}
	h.advance(5_001);
	await assert.rejects(h.resolve('youtube', 'name'), /denied/);
	assert.equal(h.calls.length, 2);
});

test('Euler access errors explain the numeric-ID alternative without provider response bodies', async () => {
	const h = harness({
		lookup: async () => {
			throw 'TIKTOK_LOOKUP_HTTP_403';
		},
	});
	await assert.rejects(h.resolve('tiktok', 'name'), /numeric TikTok ID/);
});

test('deadline aborts lookup and ignores a late provider result', async () => {
	let complete;
	const h = harness({
		deadlineMs: 5,
		lookup: () =>
			new Promise(resolve => {
				complete = resolve;
			}),
	});
	await assert.rejects(h.resolve('twitch', 'name'), /timed out/);
	assert.equal(h.calls[0].signal.aborted, true);
	complete({ data: { data: [{ id: '123', login: 'name' }] } });
	await assert.rejects(h.resolve('twitch', 'name'), /timed out/);
	assert.equal(h.calls.length, 1);
});

test('bounds concurrent lookups and application-wide API requests per minute', async () => {
	const pending = [];
	const h = harness({
		lookup: (_, username) =>
			new Promise(resolve =>
				pending.push(() =>
					resolve({
						data: { data: [{ id: '123', login: username }] },
					}),
				),
			),
	});
	const requests = Array.from({ length: 16 }, (_, i) =>
		h.resolve('twitch', `user${i}`),
	);
	await assert.rejects(h.resolve('twitch', 'overflow'), /busy/);
	pending.forEach(complete => complete());
	await Promise.all(requests);
	const rate = harness();
	for (let i = 0; i < 60; i += 1) await rate.resolve('twitch', `user${i}`);
	await assert.rejects(rate.resolve('twitch', 'overflow'), /busy/);
	rate.advance(60_001);
	await rate.resolve('twitch', 'overflow');
});
