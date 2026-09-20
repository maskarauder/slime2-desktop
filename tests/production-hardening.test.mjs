import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';
import { fixture } from './helpers/fixtures.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
	let resolve, reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
};
const quiet = { info() {}, warn() {}, error() {} };

test('logs redact credentials in objects, serialized JSON, URLs and HTTP errors', () => {
	const { safeLogText } = loadTs('src/helpers/safeLog.ts');
	const inputs = [
		{
			access_token: 'secret-one',
			'X-API-Key': 'secret-two',
			nested: { clientSecret: 'secret-three' },
		},
		JSON.stringify({ refreshToken: 'secret-four' }),
		'https://local/#token=secret-five&name=ok Authorization: Bearer secret-six',
		Object.assign(new Error('Request failed'), {
			response: { status: 403 },
			config: { headers: { Authorization: 'secret-seven' } },
		}),
	];
	const output = safeLogText(...inputs);
	for (const word of ['one', 'two', 'three', 'four', 'five', 'six', 'seven'])
		assert(!output.includes(`secret-${word}`));
	assert(output.includes('403'));
	assert(output.includes('REDACTED'));
});
test('logs handle cycles, getters, custom serialization and oversized data', () => {
	const { safeLogText } = loadTs('src/helpers/safeLog.ts');
	const cyclic = {
		count: 42n,
		toJSON() {
			return 'bad-secret';
		},
	};
	cyclic.self = cyclic;
	assert(!safeLogText(cyclic).includes('bad-secret'));
	assert(safeLogText(cyclic).includes('Circular'));
	assert.doesNotThrow(() =>
		safeLogText({
			get bad() {
				throw Error('secret');
			},
		}),
	);
	assert(safeLogText('a'.repeat(100_000)).length <= 8192);
});
function authHarness() {
	let saved = { accessToken: 'old', refreshToken: 'refresh', validatedAt: 0 };
	const calls = { validate: 0, refresh: 0, writes: 0, deleted: 0 };
	const http = {
		async get() {
			calls.validate++;
			return { data: {} };
		},
		async post() {
			calls.refresh++;
			return {
				data: { access_token: 'new', refresh_token: 'new-refresh' },
			};
		},
	};
	const module = loadTs('src/helpers/services/twitch/twitchAuth.ts', {
		axios: {
			__esModule: true,
			default: {
				create: () => http,
				isAxiosError: e => e?.isAxiosError === true,
			},
		},
		'../../json/accounts': {
			getTokens: async () => saved,
			setTokens: async (_, accessToken, refreshToken, extra) => {
				calls.writes++;
				saved = {
					...extra,
					accessToken,
					refreshToken,
					validatedAt: Date.now(),
				};
				return saved;
			},
			deleteTokens: () => {
				calls.deleted++;
			},
		},
	});
	return {
		...module,
		http,
		calls,
		get saved() {
			return saved;
		},
	};
}
const httpError = (status, error) =>
	Object.assign(new Error('HTTP failure'), {
		isAxiosError: true,
		response: { status, data: { error } },
	});
test('transient Twitch validation failure preserves credentials without refreshing', async () => {
	const h = authHarness();
	h.http.get = async () => {
		throw httpError(503);
	};
	await assert.rejects(h.default.getValidTokens('account'));
	assert.equal(h.calls.refresh, 0);
	assert.equal(h.calls.deleted, 0);
	assert.equal(h.saved.refreshToken, 'refresh');
});
test('Twitch refreshes only after 401 and coalesces concurrent validation', async () => {
	const h = authHarness();
	const waiting = deferred();
	h.http.get = async () => {
		h.calls.validate++;
		await waiting.promise;
		throw httpError(401);
	};
	const pending = Array.from({ length: 3 }, () =>
		h.default.getValidTokens('account'),
	);
	waiting.resolve();
	const results = await Promise.all(pending);
	assert.equal(h.calls.validate, 1);
	assert.equal(h.calls.refresh, 1);
	assert(results.every(t => t.accessToken === 'new'));
	assert.equal(h.calls.deleted, 0);
});
test('Twitch distinguishes invalid refresh from a temporary refresh outage', async () => {
	for (const permanent of [false, true]) {
		const h = authHarness();
		h.http.get = async () => {
			throw httpError(401);
		};
		h.http.post = async () => {
			throw httpError(
				permanent ? 400 : 503,
				permanent ? 'invalid_grant' : undefined,
			);
		};
		await assert.rejects(
			h.default.getValidTokens('account'),
			e => e instanceof h.TwitchReauthorizationError === permanent,
		);
		assert.equal(h.calls.deleted, 0);
		assert.equal(h.saved.refreshToken, 'refresh');
	}
});
test('an API rejection racing periodic validation forces one shared refresh', async () => {
	const h = authHarness();
	const waiting = deferred();
	h.http.get = () => waiting.promise;
	const periodic = h.default.getValidTokens('account');
	await tick();
	const rejections = [
		h.default.getValidTokens('account', 'old'),
		h.default.getValidTokens('account', 'old'),
	];
	waiting.resolve({ data: {} });
	await periodic;
	const tokens = await Promise.all(rejections);
	assert(tokens.every(token => token.accessToken === 'new'));
	assert.equal(h.calls.refresh, 1);
});
test('explicit widget accounts take precedence and never fall back during reauthorization', () => {
	const { resolveWidgetAccounts, relatedWidgetIds } = loadTs(
		'src/helpers/accountRouting.ts',
	);
	const account = (id, extra = {}) => ({
		id,
		service: 'youtube',
		type: 'read',
		widgets: {},
		default: false,
		reauthorize: false,
		...extra,
	});
	const accounts = {
		a: account('a', { default: true }),
		b: account('b', { widgets: { w: 0 } }),
	};
	const meta = { accounts: [{ service: 'youtube', type: 'read' }] };
	assert.equal(resolveWidgetAccounts('w', meta, accounts)[0].id, 'b');
	assert.equal(relatedWidgetIds(accounts.a, accounts, { w: meta }).length, 0);
	accounts.b.reauthorize = true;
	assert.equal(resolveWidgetAccounts('w', meta, accounts)[0], null);
	delete accounts.b;
	assert.equal(resolveWidgetAccounts('w', meta, accounts)[0].id, 'a');
});
test('three layouts share catalog requests and failures have a short negative cache', async () => {
	const { createCachedJsonGet } = loadTs(
		'src/helpers/services/requestCache.ts',
	);
	let calls = 0;
	const wait = deferred();
	const get = createCachedJsonGet({
		get: async () => {
			calls++;
			await wait.promise;
			return { data: ['emote'] };
		},
	});
	const promises = [get('/set'), get('/set'), get('/set')];
	wait.resolve();
	await Promise.all(promises);
	await get('/set');
	assert.equal(calls, 1);
	let failures = 0;
	const fail = createCachedJsonGet({
		get: async () => {
			failures++;
			throw Error('secret');
		},
	});
	await assert.rejects(fail('/bad'), /temporarily unavailable/);
	await assert.rejects(fail('/bad'));
	assert.equal(failures, 1);
});
function sessionHarness() {
	const timers = new Map();
	let next = 0;
	const sockets = [];
	const delivered = [];
	const subscriptions = [];
	class Socket {
		constructor(url) {
			this.url = url;
			this.closed = false;
			sockets.push(this);
		}
		close() {
			this.closed = true;
			this.onclose?.();
		}
		frame(frame) {
			this.onmessage?.({ data: JSON.stringify(frame) });
		}
		message(type, payload = {}, id = type) {
			this.onmessage?.({
				data: JSON.stringify({
					metadata: { message_type: type, message_id: id },
					payload,
				}),
			});
		}
	}
	const module = loadTs(
		'src/helpers/services/twitch/twitchSession.ts',
		{
			'./twitchApi': {
				default: {},
				createEventSubParamsList: () => [{ type: 'chat' }],
			},
			'./twitchAuth': {
				default: {},
				TwitchReauthorizationError: class extends Error {},
			},
		},
		{
			console: quiet,
			setTimeout: (fn, ms) => {
				const id = ++next;
				timers.set(id, { fn, ms });
				return id;
			},
			clearTimeout: id => timers.delete(id),
		},
	);
	const session = module.startTwitchSession(
		{
			account: { id: 'a', serviceId: '1' },
			onNotification: async m => delivered.push(m.metadata.message_id),
			onReauthorize: () => assert.fail('unexpected reauthorization'),
		},
		{
			open: url => new Socket(url),
			validate: async () => {},
			subscribe: async (...args) => subscriptions.push(args),
		},
	);
	return { timers, sockets, delivered, subscriptions, session };
}
test('Twitch reconnect keeps old socket until replacement welcome and cleans up everything', async () => {
	const h = sessionHarness();
	await tick();
	const frames = fixture('twitch');
	h.sockets[0].frame(frames.welcome);
	await tick();
	h.sockets[0].frame(frames.reconnect);
	await tick();
	assert.equal(h.sockets.length, 2);
	assert.equal(h.sockets[0].closed, false);
	h.sockets[1].frame(frames.resumed);
	await tick();
	assert.equal(h.sockets[0].closed, true);
	assert.equal(h.subscriptions.length, 1);
	h.session.stop();
	assert(h.sockets.every(socket => socket.closed));
	assert.equal(h.timers.size, 0);
});
test('Twitch suppresses replay and recovers when welcome never arrives', async () => {
	const h = sessionHarness();
	await tick();
	h.sockets[0].message('session_welcome', { session: { id: 'first' } });
	await tick();
	const notification = fixture('twitch').notifications[0];
	h.sockets[0].frame(notification);
	h.sockets[0].frame(notification);
	await tick();
	assert.deepEqual(h.delivered, [notification.metadata.message_id]);
	h.session.stop();
	const missing = sessionHarness();
	await tick();
	const [id, timer] = [...missing.timers].find(([, t]) => t.ms === 20_000);
	missing.timers.delete(id);
	timer.fn();
	assert.equal(missing.sockets[0].closed, true);
	assert.equal(missing.timers.size, 1);
	missing.session.stop();
	assert.equal(missing.timers.size, 0);
});
test('widget scripts load once, in order, before registration even under effect replay', async () => {
	const effects = [];
	const ready = [];
	const nodes = [];
	const useMetaLoader = loadTs(
		'src-overlay/src/hooks/useMetaLoader.ts',
		{
			react: {
				useRef: value => ({ current: value }),
				useState: value => [value, v => ready.push(v)],
				useEffect: fn => effects.push(fn),
			},
			'@tanstack/react-router': {
				useLoaderData: () => ({
					widgetId: 'w',
					meta: { import: { js: ['a.js', 'b.js'] } },
				}),
			},
			'../helpers/serverUrl': {
				cacheBust: x => x,
				createDataUrl: (_, file) => file,
			},
		},
		{
			document: {
				createElement: () => ({ setAttribute() {}, remove() {} }),
				head: { appendChild: node => nodes.push(node) },
			},
			console: quiet,
		},
	).default;
	useMetaLoader();
	const firstCleanup = effects[0]();
	firstCleanup();
	const cleanup = effects[0]();
	assert.equal(nodes.length, 1);
	assert.equal(ready.length, 0);
	nodes[0].onload();
	await tick();
	assert.equal(nodes.length, 2);
	assert.equal(ready.length, 0);
	nodes[1].onload();
	await tick();
	assert.deepEqual(ready, [true]);
	cleanup();
});
test('three simultaneous registrations retain all widgets and their initial account data', async () => {
	const effects = [];
	let listener, state;
	const sent = [];
	const logs = [];
	const accounts = {
		a: {
			id: 'a',
			type: 'read',
			service: 'twitch',
			serviceId: '123',
			default: true,
			widgets: {},
		},
	};
	const mod = {
		accounts: [{ type: 'read', service: 'twitch' }],
		name: 'Widget',
		version: '1',
	};
	const routing = loadTs('src/helpers/accountRouting.ts');
	const hook = loadTs(
		'src/hooks/useWidgetRegistration.ts',
		{
			react: {
				useRef: value => ({ current: value }),
				useState: value => {
					state = value;
					return [
						state,
						update => {
							state =
								typeof update === 'function'
									? update(state)
									: update;
						},
					];
				},
				useEffect: fn => effects.push(fn),
			},
			'@/contexts/accounts/useAccounts': {
				__esModule: true,
				default: () => accounts,
			},
			'@/contexts/settings/useSettings': {
				useSettings: () => ({ settings: {} }),
			},
			'@/contexts/widget_metas/useWidgetMetas': {
				__esModule: true,
				default: () => ({}),
			},
			'@/helpers/accountRouting': routing,
			'@/helpers/json/widgetSettings': {
				loadWidgetSettings: async () => ({}),
			},
			'@/helpers/json/widgetValues': {
				loadWidgetValues: async () => ({}),
			},
			'@/helpers/widgetMessage': {
				sendLogEvents: async () => {},
				sendWidgetValues: async () => {},
				sendWidgetAccounts: async (id, value) => {
					sent.push([id, value]);
				},
			},
			'@/helpers/zodError': {
				__esModule: true,
				default: error => {
					throw error;
				},
			},
			'@@/json/tileMeta': {
				loadTileMeta: async () => ({ name: 'Widget' }),
			},
			'@@/json/widgetMeta': { loadWidgetMeta: async () => mod },
			'@tauri-apps/api/webviewWindow': {
				getCurrentWebviewWindow: () => ({
					listen: async (_, fn) => {
						listener = fn;
						return () => {};
					},
				}),
			},
		},
		{
			console: { ...quiet, info: value => logs.push(value) },
			addEventListener() {},
			removeEventListener() {},
		},
	).default;
	hook();
	const cleanup = effects[0]();
	await Promise.all(
		['left', 'right', 'vertical'].map(id => listener({ payload: { id } })),
	);
	assert.deepEqual([...state].sort(), ['left', 'right', 'vertical']);
	assert.equal(sent.length, 3);
	assert.equal(logs.length, 3);
	assert(logs.every(log => log.includes('widget="Widget" version="1"')));
	for (const id of ['left', 'right', 'vertical'])
		assert(logs.some(log => log.includes(`id=${id}`)));
	assert(sent.every(([, a]) => a[0].serviceId === '123'));
	cleanup();
});
