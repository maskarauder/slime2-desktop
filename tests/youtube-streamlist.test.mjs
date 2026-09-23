import { fixture } from './helpers/fixtures.mjs';
import axios from 'axios';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = new Map();
function module(name, imports, console) {
	if (!compiled.has(name))
		compiled.set(
			name,
			ts.transpileModule(
				readFileSync(
					new URL(
						`../src/helpers/services/youtube/${name}.ts`,
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
			).outputText,
		);
	const exports = {};
	vm.runInNewContext(compiled.get(name), {
		exports,
		Error,
		console,
		crypto,
		setTimeout,
		clearTimeout,
		require(name) {
			assert(name in imports, `Unexpected import: ${name}`);
			return imports[name];
		},
	});
	return exports;
}

function harness({ invoke, getValidTokens } = {}) {
	const logs = [];
	const console = {
		info: (...args) => logs.push(args),
		warn: (...args) => logs.push(args),
	};
	class YouTubeReauthorizationError extends Error {}
	const auth = {
		__esModule: true,
		YouTubeReauthorizationError,
		default: {
			getValidTokens:
				getValidTokens ?? (async () => ({ accessToken: 'test-token' })),
		},
	};
	const error = module(
		'youtubeError',
		{ axios: { default: axios, ...axios } },
		console,
	);
	const stream = module(
		'youtubeStream',
		{ './youtubeAuth': auth, '@tauri-apps/api/core': { invoke } },
		console,
	);
	const reader = module(
		'youtubeChatReader',
		{
			'./youtubeApi': { default: {} },
			'./youtubeAuth': auth,
			'./youtubeError': error,
			'./youtubeStream': stream,
		},
		console,
	);
	const controller = new AbortController();
	const delivered = [];
	let clock = 0;
	const delays = [];
	const dependencies = {
		broadcast: async () => ({
			data: {
				items: [
					{
						id: 'broadcast',
						status: { lifeCycleStatus: 'live' },
						snippet: { title: 'Test', liveChatId: 'chat' },
					},
				],
			},
		}),
		poll: async () =>
			assert.fail('REST must not run while streaming works'),
		stream: stream.streamYouTubeChat,
		delay: async ms => {
			assert(delays.length < 100, 'Retry loop did not terminate');
			delays.push(ms);
			clock += ms;
		},
		now: () => clock,
	};
	const options = {
		accountId: 'account',
		signal: controller.signal,
		accountName: () => 'Test',
		onMessage: async message => {
			delivered.push(message.id);
		},
	};
	return {
		...stream,
		...reader,
		controller,
		dependencies,
		options,
		delivered,
		delays,
		logs,
		YouTubeReauthorizationError,
		run: () => reader.readYouTubeChat(options, dependencies),
	};
}

const message = id => ({
	id,
	snippet: {
		type: 'textMessageEvent',
		publishedAt: '2026-09-18T00:00:00Z',
		liveChatId: 'chat',
	},
});
const batch = (ids, nextPageToken) => ({
	items: ids.map(message),
	nextPageToken,
});

test('gRPC reconnect resumes at committed page and suppresses replay without REST requests', async () => {
	const h = harness();
	const tokens = [];
	h.dependencies.stream = async function* (_, __, token) {
		tokens.push(token);
		if (tokens.length === 1) {
			yield batch(['one'], 'page-1');
			throw new h.YouTubeStreamError(14, 'network');
		}
		yield batch(['one', 'two'], 'page-2');
		h.controller.abort();
	};
	await h.run();
	assert.deepEqual(h.delivered, ['one', 'two']);
	assert.deepEqual(tokens, [undefined, 'page-1']);
	assert.deepEqual(h.delays, [5000]);
});

test('three transport failures switch to REST and honor the 30s floor and larger Google interval', async () => {
	const h = harness();
	let streams = 0;
	const times = [];
	const transitions = [];
	h.options.onStatus = status => {
		if (status.detail === 'Switching to REST fallback')
			transitions.push([h.dependencies.now(), status.retryAt]);
	};
	h.dependencies.stream = async function* () {
		streams++;
		throw new h.YouTubeStreamError(14, 'network');
	};
	h.dependencies.poll = async () => {
		times.push(h.dependencies.now());
		if (times.length === 3) h.controller.abort();
		return {
			data: {
				...batch([], `rest-${times.length}`),
				pollingIntervalMillis: times.length === 1 ? 1000 : 45_000,
			},
		};
	};
	await h.run();
	assert.equal(streams, 3);
	assert.deepEqual(times, [45_000, 75_000, 120_000]);
	assert.deepEqual(transitions, [[15_000, 45_000]]);
	assert(h.logs.some(args => args[0].includes('REST fallback')));
});

test('REST fallback retries streaming after ten minutes with its most recent continuation', async () => {
	const h = harness();
	const tokens = [];
	let polls = 0;
	h.dependencies.stream = async function* (_, __, token) {
		tokens.push(token);
		if (tokens.length === 1)
			throw new h.YouTubeStreamError(12, 'not implemented');
		yield batch(['last-rest', 'stream-new'], 'stream-resumed');
		h.controller.abort();
	};
	h.dependencies.poll = async () => ({
		data: batch(['last-rest'], `rest-${++polls}`),
	});
	await h.run();
	assert.equal(polls, 20);
	assert.deepEqual(tokens, [undefined, 'rest-20']);
	assert.deepEqual(h.delivered, ['last-rest', 'stream-new']);
});

test('failed REST requests also wait at least thirty seconds and retain the page token', async () => {
	const h = harness();
	const times = [];
	const tokens = [];
	h.dependencies.stream = async function* () {
		yield batch(['before-fallback'], 'committed');
		throw new h.YouTubeStreamError(12, 'unsupported');
	};
	h.dependencies.poll = async (_, __, token) => {
		times.push(h.dependencies.now());
		tokens.push(token);
		if (times.length === 1)
			throw new axios.AxiosError('Network error', 'ERR_NETWORK');
		h.controller.abort();
		return { data: batch([], 'ignored') };
	};
	await h.run();
	assert.equal(times[1] - times[0], 30_000);
	assert.deepEqual(tokens, ['committed', 'committed']);
});

test('quota and permission failures pause instead of switching to REST or discarding OAuth', async () => {
	for (const code of [7, 8]) {
		const h = harness();
		let attempts = 0;
		h.dependencies.stream = async function* () {
			if (++attempts === 2) h.controller.abort();
			throw new h.YouTubeStreamError(code, 'quota/permission');
		};
		await h.run();
		assert.deepEqual(h.delays, [900_000]);
	}
});

test('stream ending rediscovers a broadcast and resets deduplication for a different live chat', async () => {
	const h = harness();
	let lookups = 0;
	const chatIds = [];
	h.dependencies.broadcast = async () => ({
		data: {
			items: [
				{
					id: `broadcast-${++lookups}`,
					status: { lifeCycleStatus: 'live' },
					snippet: { title: 'Test', liveChatId: `chat-${lookups}` },
				},
			],
		},
	});
	h.dependencies.stream = async function* (_, chatId, token) {
		chatIds.push(chatId);
		assert.equal(token, undefined);
		yield {
			...batch(['same-id'], 'old-token'),
			offlineAt: '2026-09-18T00:00:00Z',
		};
	};
	h.options.onMessage = async m => {
		h.delivered.push(m.id);
		if (h.delivered.length === 2) h.controller.abort();
	};
	await h.run();
	assert.deepEqual(chatIds, ['chat-1', 'chat-2']);
	assert.equal(h.delivered.length, 2);
});

test('dispatch failure does not commit a partially delivered page or redeliver successful messages', async () => {
	const h = harness();
	const tokens = [];
	let failed = false;
	h.dependencies.stream = async function* (_, __, token) {
		tokens.push(token);
		yield batch(['one', 'two'], 'complete-page');
		h.controller.abort();
	};
	h.options.onMessage = async m => {
		if (m.id === 'two' && !failed) {
			failed = true;
			throw new Error('widget send failed');
		}
		h.delivered.push(m.id);
	};
	await h.run();
	assert.deepEqual(tokens, [undefined, undefined]);
	assert.deepEqual(h.delivered, ['one', 'two']);
});

test('native adapter closes a pending read when aborted', async () => {
	let rejectRead;
	let ready;
	const waiting = new Promise(resolve => {
		ready = resolve;
	});
	const calls = [];
	const h = harness({
		invoke: async (command, args) => {
			calls.push([command, args.sessionId]);
			if (command === 'next_youtube_chat_batch')
				return new Promise((_, reject) => {
					rejectRead = reject;
					ready();
				});
			if (command === 'close_youtube_chat_stream')
				rejectRead?.({ code: 1, message: 'cancelled' });
		},
	});
	const run = h.run();
	await waiting;
	h.controller.abort();
	await run;
	assert(calls.some(([command]) => command === 'close_youtube_chat_stream'));
	assert.equal(new Set(calls.map(([, session]) => session)).size, 1);
	assert.equal(getEventListeners(h.controller.signal, 'abort').length, 0);
});

test('abort while native open is pending repeats cleanup after open settles', async () => {
	let completeOpen;
	let ready;
	const waiting = new Promise(resolve => {
		ready = resolve;
	});
	let closed = 0;
	const h = harness({
		invoke: async command => {
			if (command === 'open_youtube_chat_stream')
				return new Promise(resolve => {
					completeOpen = resolve;
					ready();
				});
			if (command === 'close_youtube_chat_stream') closed++;
			if (command === 'next_youtube_chat_batch')
				assert.fail('Aborted stream must not read');
		},
	});
	const run = h.run();
	await waiting;
	h.controller.abort();
	completeOpen();
	await run;
	assert.equal(closed, 2);
});

test('native adapter refreshes once after a rejected token and resumes after the consumed batch', async () => {
	const validation = [];
	const opens = [];
	let reads = 0;
	const h = harness({
		getValidTokens: async (_, rejected) => {
			validation.push(rejected);
			return {
				accessToken: rejected ? 'refreshed-token' : 'first-token',
			};
		},
		invoke: async (command, args) => {
			if (command === 'open_youtube_chat_stream') opens.push(args);
			if (command === 'next_youtube_chat_batch') {
				if (++reads === 1) return batch(['one'], 'page-one');
				if (reads === 2) throw { code: 16, message: 'Token expired' };
				return batch(['two'], 'page-two');
			}
		},
	});
	h.options.onMessage = async m => {
		h.delivered.push(m.id);
		if (m.id === 'two') h.controller.abort();
	};
	await h.run();
	assert.deepEqual(validation, [undefined, 'first-token']);
	assert.equal(opens[1].pageToken, 'page-one');
	assert.equal(opens[1].accessToken, 'refreshed-token');
	assert(!JSON.stringify(h.logs).includes('refreshed-token'));
});

test('two consecutive authentication rejections request reauthorization without a REST fallback', async () => {
	let validations = 0;
	const h = harness({
		getValidTokens: async () => {
			validations++;
			return { accessToken: 'test-token' };
		},
		invoke: async command => {
			if (command === 'open_youtube_chat_stream')
				throw { code: 16, message: 'rejected' };
		},
	});
	await assert.rejects(h.run(), h.YouTubeReauthorizationError);
	assert.equal(validations, 2);
	assert.deepEqual(h.delays, []);
});

test('poll delays release their abort listeners on both normal completion and cancellation', async () => {
	const h = harness();
	await h.abortableDelay(1, h.controller.signal);
	assert.equal(getEventListeners(h.controller.signal, 'abort').length, 0);
	const delay = h.abortableDelay(30_000, h.controller.signal);
	h.controller.abort();
	await delay;
	assert.equal(getEventListeners(h.controller.signal, 'abort').length, 0);
});

test('gift combos and polls update, tombstones remove, and replay stays suppressed', async () => {
	const h = harness();
	const forwarded = [];
	h.options.onMessage = async value => forwarded.push(value);
	const gift = count => ({
		...message('gift'),
		snippet: {
			...message('gift').snippet,
			type: 'giftEvent',
			giftEventDetails: {
				giftMetadata: { giftName: 'Rose', comboCount: count },
			},
		},
	});
	const poll = count => ({
		...message('poll'),
		snippet: {
			...message('poll').snippet,
			type: 'pollEvent',
			pollDetails: {
				metadata: {
					questionText: 'Choose',
					options: [{ optionText: 'A', tally: count }],
					status: 'active',
				},
			},
		},
	});
	const tombstone = {
		...message('text'),
		snippet: { ...message('text').snippet, type: 'tombstone' },
	};
	h.dependencies.stream = async function* () {
		yield {
			items: [message('text'), gift(1)],
			activePollItem: poll(1),
			nextPageToken: 'one',
		};
		yield {
			items: [gift(1), gift(2), tombstone],
			activePollItem: poll(2),
			nextPageToken: 'two',
		};
		yield {
			items: [message('text'), gift(2), tombstone],
			activePollItem: poll(2),
			nextPageToken: 'three',
		};
		h.controller.abort();
	};
	await h.run();
	assert.deepEqual(
		forwarded.map(m => [m.id, m.snippet.type]),
		[
			['text', 'textMessageEvent'],
			['gift', 'giftEvent'],
			['poll', 'pollEvent'],
			['gift', 'giftEvent'],
			['text', 'tombstone'],
			['poll', 'pollEvent'],
		],
	);
	assert.equal(
		forwarded[3].snippet.giftEventDetails.giftMetadata.comboCount,
		2,
	);
});

test('YouTube fixture batches preserve message details and suppress complete replay after reconnect', async () => {
	const h = harness();
	const messages = fixture('youtube').messages;
	const forwarded = [];
	h.options.onMessage = async message => forwarded.push(message);
	let attempt = 0;
	const tokens = [];
	h.dependencies.stream = async function* (_, __, token) {
		tokens.push(token);
		attempt++;
		if (attempt === 1) {
			yield { items: messages, nextPageToken: 'fixture-next-page' };
			throw new Error('simulated network disconnect');
		}
		yield { items: messages, nextPageToken: 'fixture-after-replay' };
		h.controller.abort();
	};
	await h.run();
	assert.equal(attempt, 2);
	assert.deepEqual(tokens, [undefined, 'fixture-next-page']);
	assert.deepEqual(forwarded, messages);
});
