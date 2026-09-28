import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(
	readFileSync(
		new URL(
			'../src/helpers/services/emotes/sevenTvLive.ts',
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
const exports = {};
vm.runInNewContext(source, {
	exports,
	AbortController,
	setTimeout,
	clearTimeout,
	console,
});
const { createSevenTvLive } = exports;
const emote = (id, name = id) => ({ id, name, data: { animated: true } });
const set = (id, names) => ({ id, emotes: names.map(name => emote(name)) });
const twitch = { id: 'local-twitch', service: 'twitch', serviceId: '123' };
const youtube = {
	id: 'local-youtube',
	service: 'youtube',
	serviceId: 'UC-test',
};
const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
async function flush() {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

function harness() {
	let now = 0;
	let nextTimer = 0;
	const timers = new Map();
	const sockets = [];
	const calls = [];
	const events = [];
	const warnings = [];
	const catalog = new Map([
		['global', set('global-id', ['Global'])],
		['set-1', set('set-1', ['First'])],
		['set-2', set('set-2', ['Second'])],
	]);
	const users = new Map([
		['twitch:123', { user: { id: 'user-1' }, emote_set_id: 'set-1' }],
		['youtube:UC-test', { user: { id: 'user-1' }, emote_set_id: 'set-1' }],
	]);
	const deps = {
		loadSet: async (id, signal) => {
			calls.push({ kind: 'set', id, signal });
			const value = catalog.get(id) ?? null;
			if (value instanceof Error) throw value;
			return value;
		},
		loadUser: async (platform, id, signal) => {
			calls.push({ kind: 'user', platform, id, signal });
			const value = users.get(`${platform}:${id}`) ?? null;
			if (value instanceof Error) throw value;
			return value;
		},
		normalize: ({ id, name }) => ({
			id,
			name,
			srcAnimated: `https://cdn.invalid/${id}.webp`,
			srcStatic: `https://cdn.invalid/${id}_static.webp`,
		}),
		now: () => now,
		random: () => 0.5,
		setTimeout: (fn, delay) => {
			const id = ++nextTimer;
			timers.set(id, { at: now + delay, fn });
			return id;
		},
		clearTimeout: id => timers.delete(id),
		warn: message => warnings.push(message),
		connect: url => {
			const socket = {
				url,
				readyState: 1,
				closed: false,
				sent: [],
				autoAck: true,
				send(value) {
					const message = JSON.parse(value);
					this.sent.push(message);
					if (this.autoAck && message.op === 35)
						queueMicrotask(() =>
							this.frame(5, {
								command: 'SUBSCRIBE',
								data: message.d,
							}),
						);
				},
				close() {
					this.closed = true;
					this.readyState = 3;
				},
				frame(op, d) {
					this.onmessage?.({ data: JSON.stringify({ op, d }) });
				},
				hello(limit = -1) {
					this.frame(1, {
						heartbeat_interval: 30_000,
						subscription_limit: limit,
					});
				},
				event(type, body) {
					this.frame(0, { type, body });
				},
			};
			sockets.push(socket);
			return socket;
		},
	};
	const service = createSevenTvLive(deps);
	service.subscribe(event => events.push(event));
	return {
		service,
		deps,
		timers,
		sockets,
		calls,
		events,
		warnings,
		catalog,
		users,
		async start(accounts = [twitch, youtube]) {
			service.setAccounts(accounts);
			await flush();
			sockets.at(-1).hello();
			await flush();
		},
		async advance(ms, heartbeat = true) {
			const end = now + ms;
			while (true) {
				const due = [...timers.entries()]
					.filter(([, t]) => t.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				now = due[1].at;
				if (heartbeat && sockets.at(-1)?.readyState === 1)
					sockets.at(-1).frame(2, {});
				if (!timers.has(due[0])) continue;
				timers.delete(due[0]);
				due[1].fn();
				await flush();
			}
			now = end;
		},
		async names(platform = 'twitch', id = '123') {
			return Array.from(
				(await service.getUser(platform, id))?.emotes ?? [],
				e => e.name,
			);
		},
	};
}

test('three layouts/accounts share one socket and shared-set snapshots/subscriptions', async () => {
	const h = harness();
	await h.start([twitch, youtube, { ...twitch, id: 'duplicate-local-id' }]);
	assert.equal(h.sockets.length, 1);
	assert.deepEqual(await h.names(), ['Global', 'First']);
	// One initial and one post-subscription snapshot, shared by both platforms.
	assert.equal(
		h.calls.filter(c => c.kind === 'set' && c.id === 'set-1').length,
		2,
	);
	assert.deepEqual(
		h.sockets[0].sent
			.map(x => x.d.type + ':' + x.d.condition.object_id)
			.sort(),
		['emote_set.*:global-id', 'emote_set.*:set-1', 'user.update:user-1'],
	);
	const calls = h.calls.length;
	await Promise.all(
		Array.from({ length: 3 }, () => h.service.getUser('twitch', '123')),
	);
	assert.equal(h.calls.length, calls);
	h.service.dispose();
	assert.equal(h.timers.size, 0);
});

test('add, rename, remove, and global updates immediately replace snapshots for both platforms', async () => {
	const h = harness();
	await h.start();
	const ws = h.sockets[0];
	const added = emote('Extra');
	ws.event('emote_set.update', {
		id: 'set-1',
		pushed: [{ key: 'emotes', value: added }],
	});
	assert.deepEqual(await h.names(), ['Global', 'First', 'Extra']);
	ws.event('emote_set.update', {
		id: 'set-1',
		updated: [
			{
				key: 'emotes',
				old_value: added,
				value: emote('Extra', 'Renamed'),
			},
		],
	});
	assert.deepEqual(await h.names('youtube', 'UC-test'), [
		'Global',
		'First',
		'Renamed',
	]);
	ws.event('emote_set.update', {
		id: 'set-1',
		pulled: [{ key: 'emotes', old_value: emote('Extra', 'Renamed') }],
	});
	ws.event('emote_set.update', {
		id: 'global-id',
		pushed: [{ key: 'emotes', value: emote('GlobalNew') }],
	});
	assert.deepEqual(await h.names(), ['Global', 'GlobalNew', 'First']);
	assert(
		h.events.every(
			(event, index) =>
				!index || event.revision > h.events[index - 1].revision,
		),
	);
	h.service.dispose();
});

test('duplicate emote IDs with different aliases remain independent', async () => {
	const h = harness();
	h.catalog.set('set-1', {
		id: 'set-1',
		emotes: [emote('same', 'AliasOne'), emote('same', 'AliasTwo')],
	});
	await h.start();
	h.sockets[0].event('emote_set.update', {
		id: 'set-1',
		pulled: [{ key: 'emotes', old_value: emote('same', 'AliasTwo') }],
	});
	assert.deepEqual(await h.names(), ['Global', 'AliasOne']);
	h.service.dispose();
});

test('nested active-set replacement updates subscriptions and keeps the old catalog through a transient set error', async () => {
	const h = harness();
	await h.start();
	h.catalog.set('set-2', new Error('offline'));
	const ws = h.sockets[0];
	ws.event('user.update', {
		id: 'user-1',
		updated: [
			{
				key: 'connections',
				index: 0,
				nested: true,
				value: [{ key: 'emote_set_id', value: 'set-2' }],
			},
		],
	});
	await flush();
	assert.deepEqual(await h.names(), ['Global', 'First']);
	assert(
		ws.sent.some(x => x.op === 36 && x.d.condition.object_id === 'set-1'),
	);
	assert(
		ws.sent.some(x => x.op === 35 && x.d.condition.object_id === 'set-2'),
	);
	h.catalog.set('set-2', set('set-2', ['Second']));
	h.users.set('twitch:123', {
		user: { id: 'user-1' },
		emote_set_id: 'set-2',
	});
	h.users.set('youtube:UC-test', {
		user: { id: 'user-1' },
		emote_set_id: 'set-2',
	});
	await h.advance(15 * 60_000);
	assert.deepEqual(await h.names(), ['Global', 'Second']);
	h.service.dispose();
});

test('periodic refresh is uncached, preserves snapshots on failure, and clears confirmed 404 absence', async () => {
	const h = harness();
	await h.start();
	await h.advance(500);
	h.catalog.set('set-1', set('set-1', ['Changed']));
	await h.advance(15 * 60_000);
	assert.deepEqual(await h.names(), ['Global', 'Changed']);
	h.catalog.set('set-1', new Error('transient'));
	h.catalog.set('global', new Error('transient'));
	await h.advance(15 * 60_000);
	assert.deepEqual(await h.names(), ['Global', 'Changed']);
	h.users.set('twitch:123', null);
	await h.advance(15 * 60_000);
	assert.deepEqual(await h.names(), ['Global']);
	h.service.dispose();
});

test('an EventAPI delta wins over a stale in-flight HTTP reconciliation', async () => {
	const h = harness();
	await h.start();
	await h.advance(500);
	const pending = deferred();
	const original = h.deps.loadSet;
	h.deps.loadSet = (id, signal) =>
		id === 'set-1' ? pending.promise : original(id, signal);
	await h.advance(15 * 60_000);
	h.sockets[0].event('emote_set.update', {
		id: 'set-1',
		pushed: [{ key: 'emotes', value: emote('Newer') }],
	});
	pending.resolve(set('set-1', ['OldSnapshot']));
	await flush();
	assert.deepEqual(await h.names(), ['Global', 'First', 'Newer']);
	h.service.dispose();
});

test('active-set switch wins over a delayed user lookup for the old set', async () => {
	const h = harness();
	await h.start();
	await h.advance(500);
	const pending = deferred();
	h.deps.loadUser = () => pending.promise;
	await h.advance(15 * 60_000);
	h.sockets[0].event('user.update', {
		id: 'user-1',
		updated: [
			{
				key: 'connections',
				value: [{ key: 'emote_set_id', value: 'set-2' }],
			},
		],
	});
	pending.resolve({ user: { id: 'user-1' }, emote_set_id: 'set-1' });
	await flush();
	assert.deepEqual(await h.names(), ['Global', 'Second']);
	h.service.dispose();
});

test('reconnect resubscribes and refetches missed changes without RESUME or client heartbeat frames', async () => {
	const h = harness();
	await h.start();
	await h.advance(500);
	const ws = h.sockets[0];
	h.catalog.set('set-1', set('set-1', ['MissedWhileDisconnected']));
	ws.onclose();
	await h.advance(1000, false);
	assert.equal(h.sockets.length, 2);
	h.sockets[1].hello();
	await flush();
	await h.advance(500);
	assert.deepEqual(await h.names(), ['Global', 'MissedWhileDisconnected']);
	assert.equal(h.sockets[1].sent.filter(x => x.op === 35).length, 3);
	assert(
		h.sockets.flatMap(x => x.sent).every(x => x.op === 35 || x.op === 36),
	);
	h.service.dispose();
});

test('quiet sockets stay connected through server heartbeats; missing HELLO, ACK or heartbeats recover', async () => {
	const h = harness();
	await h.start();
	await h.advance(10 * 60_000);
	assert.equal(h.sockets.length, 1);
	await h.advance(76_000, false);
	assert(h.sockets[0].closed);
	h.service.dispose();
	const hello = harness();
	hello.service.setAccounts([twitch]);
	await flush();
	await hello.advance(16_000, false);
	assert(hello.sockets[0].closed);
	hello.service.dispose();
	const ack = harness();
	ack.service.setAccounts([twitch]);
	await flush();
	ack.sockets[0].autoAck = false;
	ack.sockets[0].hello();
	await flush();
	await ack.advance(15_001, false);
	assert(ack.sockets[0].closed);
	ack.service.dispose();
});

test('cleanup aborts requests, drops stale callbacks and responses, and can restart cleanly', async () => {
	const h = harness();
	const pending = deferred();
	h.deps.loadUser = (platform, id, signal) => {
		h.calls.push({ signal });
		return pending.promise;
	};
	h.service.setAccounts([twitch]);
	await flush();
	const old = h.sockets[0];
	const callback = old.onmessage;
	h.service.setAccounts([]);
	assert(old.closed);
	assert.equal(h.timers.size, 0);
	assert(h.calls.every(c => c.signal.aborted));
	const delivered = h.events.length;
	pending.resolve({ user: { id: 'stale' }, emote_set_id: 'set-1' });
	await flush();
	callback({
		data: JSON.stringify({ op: 1, d: { heartbeat_interval: 30_000 } }),
	});
	assert.equal(h.events.length, delivered);
	assert.equal(h.timers.size, 0);
	h.service.setAccounts([youtube]);
	await flush();
	h.sockets[1].hello();
	await flush();
	assert.equal(h.sockets.length, 2);
	assert(h.events.at(-1).revision > (h.events[delivered - 1]?.revision ?? 0));
	h.service.dispose();
});

test('removing one account never publishes its pending response or closes remaining accounts', async () => {
	const h = harness();
	const pending = deferred();
	const original = h.deps.loadUser;
	h.deps.loadUser = (platform, id, signal) =>
		platform === 'twitch'
			? pending.promise
			: original(platform, id, signal);
	h.service.setAccounts([twitch, youtube]);
	await flush();
	h.service.setAccounts([youtube]);
	const count = h.events.filter(e => e.platform === 'twitch').length;
	pending.resolve({ user: { id: 'late' }, emote_set_id: 'set-2' });
	await flush();
	assert.equal(h.events.filter(e => e.platform === 'twitch').length, count);
	assert.equal(h.sockets.length, 1);
	assert.equal(h.sockets[0].closed, false);
	h.service.dispose();
});

test('server subscription limit bounds subscriptions while periodic snapshots still cover all accounts', async () => {
	const h = harness();
	h.service.setAccounts([twitch, youtube]);
	await flush();
	h.sockets[0].hello(1);
	await flush();
	assert.equal(h.sockets[0].sent.filter(x => x.op === 35).length, 1);
	assert.deepEqual(await h.names('youtube', 'UC-test'), ['Global', 'First']);
	h.service.dispose();
});

test('initial lookup failures publish no empty replacement and return null, then recover', async () => {
	const h = harness();
	h.catalog.set('global', new Error('offline'));
	h.users.set('twitch:123', new Error('offline'));
	await h.start([twitch]);
	assert.equal(await h.service.getUser('twitch', '123'), null);
	assert.equal(h.events.length, 0);
	h.catalog.set('global', set('global-id', ['Global']));
	await h.advance(500);
	assert.equal(await h.service.getUser('twitch', '123'), null);
	assert.equal(
		h.events.length,
		0,
		'global-only partial data cannot replace an unknown channel catalog',
	);
	h.users.set('twitch:123', {
		user: { id: 'user-1' },
		emote_set_id: 'set-1',
	});
	await h.advance(15 * 60_000);
	assert.deepEqual(await h.names(), ['Global', 'First']);
	h.service.dispose();
});

test('a pending getUser returns null after its watched account is removed', async () => {
	const h = harness();
	const pending = deferred();
	h.deps.loadUser = () => pending.promise;
	h.service.setAccounts([twitch]);
	await flush();
	const lookup = h.service.getUser('twitch', '123');
	h.service.setAccounts([]);
	pending.resolve({ user: { id: 'user-1' }, emote_set_id: 'set-1' });
	assert.equal(await lookup, null);
	h.service.dispose();
});

test('reconnect cannot reuse a pre-disconnect snapshot after subscription ACK', async () => {
	const h = harness();
	await h.start();
	await h.advance(500);
	const pending = deferred();
	const original = h.deps.loadSet;
	let calls = 0;
	h.deps.loadSet = (id, signal) =>
		id === 'set-1' && ++calls === 1
			? pending.promise
			: original(id, signal);
	await h.advance(15 * 60_000);
	h.catalog.set('set-1', set('set-1', ['MissedEvent']));
	h.sockets[0].onclose();
	await h.advance(1000, false);
	h.sockets[1].hello();
	await flush();
	pending.resolve(set('set-1', ['StaleBeforeDisconnect']));
	await flush();
	assert.deepEqual(await h.names(), ['Global', 'MissedEvent']);
	assert(
		!h.events.some(e =>
			e.emotes.some(emote => emote.name === 'StaleBeforeDisconnect'),
		),
	);
	h.service.dispose();
});

test('rate limits and maintenance wait five minutes; fatal protocol errors use only reconciliation', async () => {
	for (const code of [4005, 4007]) {
		const h = harness();
		await h.start();
		h.sockets[0].frame(6, {
			message: 'upstream details must not be logged',
		});
		h.sockets[0].frame(7, { code });
		h.service.setAccounts([twitch, youtube]);
		await h.advance(299_999, false);
		assert.equal(h.sockets.length, 1);
		await h.advance(1, false);
		assert.equal(h.sockets.length, 2);
		h.service.dispose();
	}
	const h = harness();
	await h.start();
	h.sockets[0].frame(7, { code: 4002 });
	h.service.setAccounts([twitch, youtube]);
	h.catalog.set('set-1', set('set-1', ['PeriodicStillWorks']));
	await h.advance(15 * 60_000, false);
	assert.equal(h.sockets.length, 1);
	assert.deepEqual(await h.names(), ['Global', 'PeriodicStillWorks']);
	h.service.dispose();
});

test('account rerenders cannot bypass ordinary reconnect backoff', async () => {
	const h = harness();
	await h.start();
	h.sockets[0].onclose();
	h.service.setAccounts([twitch]);
	h.service.setAccounts([twitch, youtube]);
	assert.equal(h.sockets.length, 1);
	await h.advance(999, false);
	assert.equal(h.sockets.length, 1);
	await h.advance(1, false);
	assert.equal(h.sockets.length, 2);
	h.service.dispose();
});

test('deleting the entire active set removes its emotes immediately and defeats stale HTTP', async () => {
	const h = harness();
	await h.start();
	await h.advance(500);
	const pending = deferred();
	const original = h.deps.loadSet;
	h.deps.loadSet = (id, signal) =>
		id === 'set-1' ? pending.promise : original(id, signal);
	await h.advance(15 * 60_000);
	h.sockets[0].event('emote_set.delete', { id: 'set-1' });
	pending.resolve(set('set-1', ['DeletedButStale']));
	await flush();
	assert.deepEqual(await h.names(), ['Global']);
	await h.advance(500);
	assert.deepEqual(await h.names(), ['Global']);
	assert.deepEqual(await h.names('youtube', 'UC-test'), ['Global']);
	h.service.dispose();
});

function httpHarness() {
	const calls = [];
	let handler = async () => ({ data: set('set-http', ['Emote']) });
	const client = {
		get(path, config) {
			calls.push({ path, config });
			return handler(path, config);
		},
	};
	const axios = {
		create: () => client,
		isAxiosError: error => error?.isAxiosError === true,
	};
	const code = ts.transpileModule(
		readFileSync(
			new URL(
				'../src/helpers/services/emotes/sevenTV.ts',
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
	const exports = {};
	vm.runInNewContext(code, {
		exports,
		AbortController,
		require(name) {
			if (name === 'axios') return { __esModule: true, default: axios };
			if (name === './sevenTvLive')
				return { createSevenTvLive: dependencies => dependencies };
			assert.fail(`Unexpected import ${name}`);
		},
	});
	return {
		api: exports.default,
		calls,
		setHandler(next) {
			handler = next;
		},
	};
}

test('HTTP lookups share in-flight work, bypass TTL caches, and distinguish 404 from transient failures', async () => {
	const h = httpHarness();
	const signal = new AbortController().signal;
	const pending = deferred();
	h.setHandler(() => pending.promise);
	const first = h.api.loadSet('set-1', signal);
	const second = h.api.loadSet('set-1', signal);
	assert.equal(h.calls.length, 1);
	pending.resolve({ data: set('set-1', ['Now']) });
	await Promise.all([first, second]);
	h.setHandler(async () => ({ data: set('set-1', ['Fresh']) }));
	assert.equal(
		(await h.api.loadSet('set-1', signal)).emotes[0].name,
		'Fresh',
	);
	assert.equal(h.calls.length, 2);
	h.setHandler(async () => {
		throw { isAxiosError: true, response: { status: 404 } };
	});
	assert.equal(await h.api.loadUser('youtube', 'UC-test', signal), null);
	assert.equal(h.calls.at(-1).path, '/users/google/UC-test');
	assert.equal(
		h.calls.at(-1).config.headers['X-7tv-Missing-EmoteSet-Aware'],
		'1',
	);
	h.setHandler(async () => {
		throw {
			isAxiosError: true,
			response: { status: 500 },
			headers: { secret: 'never-log-this' },
		};
	});
	await assert.rejects(
		h.api.loadSet('set-1', signal),
		/temporarily unavailable/,
	);
});

test('HTTP cleanup cannot attach a restarted session to its aborted request or delete its replacement', async () => {
	const h = httpHarness();
	const old = new AbortController();
	const active = new AbortController();
	const first = deferred();
	const second = deferred();
	let count = 0;
	h.setHandler(() => (++count === 1 ? first.promise : second.promise));
	const oldLookup = h.api.loadSet('set-1', old.signal);
	old.abort();
	const newLookup = h.api.loadSet('set-1', active.signal);
	assert.equal(h.calls.length, 2);
	first.resolve({ data: set('set-1', ['Stale']) });
	await oldLookup;
	const sharedNew = h.api.loadSet('set-1', active.signal);
	assert.equal(h.calls.length, 2);
	second.resolve({ data: set('set-1', ['New']) });
	assert.equal((await newLookup).emotes[0].name, 'New');
	assert.equal((await sharedNew).emotes[0].name, 'New');
});

test('normalization preserves channel aliases and the largest animated/static WEBP pair', () => {
	const h = httpHarness();
	const value = h.api.normalize({
		id: 'emote',
		name: 'CustomAlias',
		data: {
			animated: true,
			host: {
				url: '//cdn.invalid/emote/',
				files: [
					{ name: '1x.webp', width: 32, format: 'WEBP' },
					{
						name: '4x.webp',
						static_name: '4x_static.webp',
						width: 128,
						format: 'WEBP',
					},
				],
			},
		},
	});
	assert.equal(value.name, 'CustomAlias');
	assert.equal(value.srcAnimated, 'https://cdn.invalid/emote/4x.webp');
	assert.equal(value.srcStatic, 'https://cdn.invalid/emote/4x_static.webp');
});

test('a confirmed deleted set cannot reappear through a scheduled stale HTTP refresh', async () => {
	const h = harness();
	await h.start();
	// HELLO still has a scheduled snapshot refresh; upstream HTTP is stale.
	h.sockets[0].event('emote_set.delete', { id: 'set-1' });
	await h.advance(500);
	assert.deepEqual(await h.names(), ['Global']);
	assert.deepEqual(await h.names('youtube', 'UC-test'), ['Global']);
	h.service.dispose();
});
