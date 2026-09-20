import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(
	readFileSync(
		new URL(
			'../src-overlay/src/hooks/useSlime2Websocket.ts',
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

function harness({ ready = true, token = true, autoRegister = true } = {}) {
	const target = new EventTarget();
	const effects = [];
	const refs = [];
	const timers = new Map();
	const intervals = new Map();
	const sockets = [];
	let nextId = 0;
	class Socket {
		static CONNECTING = 0;
		static OPEN = 1;
		readyState = 0;
		listeners = new Map();
		sent = [];
		constructor() {
			sockets.push(this);
		}
		addEventListener(type, fn) {
			const list = this.listeners.get(type) ?? new Set();
			list.add(fn);
			this.listeners.set(type, list);
		}
		removeEventListener(type, fn) {
			this.listeners.get(type)?.delete(fn);
		}
		open() {
			this.readyState = 1;
			this.listeners.get('open')?.forEach(fn => fn());
			this.onopen?.();
			if (autoRegister)
				this.message({
					widgetId: 'widget_test',
					type: 'registered',
					data: {},
				});
		}
		send(message) {
			if (this.readyState !== 1) throw new Error('Closed socket');
			this.sent.push(JSON.parse(message));
		}
		close(code = 1006) {
			this.readyState = 3;
			this.listeners.get('close')?.forEach(fn => fn());
			this.onclose?.({ code });
		}
		message(payload) {
			this.onmessage?.({ data: JSON.stringify(payload) });
		}
	}
	const exports = {};
	const slime2 = {};
	const dependencies = {
		'@tanstack/react-router': {
			useLoaderData() {
				return { widgetId: 'widget_test' };
			},
		},
		nanoid: {
			nanoid() {
				return `${++nextId}`;
			},
		},
		react: {
			useRef(value) {
				const ref = { current: value };
				refs.push(ref);
				return ref;
			},
			useCallback(fn) {
				return fn;
			},
			useEffect(fn) {
				effects.push(fn);
			},
		},
		'zod/mini': require('zod/mini'),
		'../helpers/serverUrl': { WEBSOCKET_BASE_URL: 'ws://localhost/test' },
		'../helpers/zodError': {
			default(error) {
				throw error;
			},
		},
	};
	vm.runInNewContext(compiled, {
		exports,
		slime2,
		WebSocket: Socket,
		URLSearchParams,
		location: { hash: token ? '#token=' + 'x'.repeat(48) : '' },
		CustomEvent,
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target),
		dispatchEvent: target.dispatchEvent.bind(target),
		console: { info() {}, warn() {}, error() {} },
		setTimeout(fn, delay) {
			const id = ++nextId;
			timers.set(id, { fn, delay });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		setInterval(fn, delay) {
			const id = ++nextId;
			intervals.set(id, { fn, delay });
			return id;
		},
		clearInterval(id) {
			intervals.delete(id);
		},
		require(name) {
			return dependencies[name];
		},
	});
	exports.default(ready);
	const cleanup = effects.map(fn => fn());
	return {
		slime2,
		refs,
		timers,
		intervals,
		sockets,
		cleanup: () => cleanup.forEach(fn => fn?.()),
	};
}

test('disconnect rejects a pending storage request and frees its timer and resolver', async () => {
	const h = harness();
	h.sockets[0].open();
	const pending = h.slime2.request('get-shared-widget-storage', {
		key: 'key',
		scope: 'persistent',
	});
	const assertion = assert.rejects(pending, /disconnected/);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.refs[1].current.size, 1);
	h.sockets[0].close();
	await assertion;
	assert.equal(h.refs[1].current.size, 0);
	assert.equal(
		[...h.timers.values()].some(timer => timer.delay === 30000),
		false,
	);
	h.cleanup();
});

test('a request with no response times out and removes its resolver', async () => {
	const h = harness();
	h.sockets[0].open();
	const pending = h.slime2.request('get-shared-widget-storage', {});
	const assertion = assert.rejects(pending, /timed out/);
	await new Promise(resolve => setImmediate(resolve));
	const timer = [...h.timers.values()].find(item => item.delay === 30000);
	assert(timer);
	timer.fn();
	await assertion;
	assert.equal(h.refs[1].current.size, 0);
	h.cleanup();
});

test('a request waiting for connection removes both listeners when it times out', async () => {
	const h = harness();
	const pending = h.slime2.request('get-shared-widget-storage', {});
	const assertion = assert.rejects(pending, /Timed out connecting/);
	const timer = [...h.timers.values()].findLast(item => item.delay === 10000);
	assert(timer);
	timer.fn();
	await assertion;
	assert.equal(h.sockets[0].listeners.get('open')?.size ?? 0, 0);
	assert.equal(h.sockets[0].listeners.get('close')?.size ?? 0, 0);
	assert.equal(h.refs[1].current.size, 0);
	h.cleanup();
});

test('the widget heartbeat is acknowledged without dispatching a widget event', () => {
	const h = harness();
	h.sockets[0].open();
	assert.equal(h.sockets[0].sent.at(-1).type, 'heartbeat');
	const heartbeatTimeout = [...h.timers.values()].find(
		item => item.delay === 10000,
	);
	assert(heartbeatTimeout);
	h.sockets[0].message({
		widgetId: 'widget_test',
		type: 'heartbeat',
		data: { timestamp: Date.now() },
	});
	assert.equal(
		[...h.timers.values()].some(item => item.delay === 10000),
		false,
	);
	assert.equal(h.intervals.size, 1);
	h.cleanup();
});

test('a missing widget heartbeat acknowledgement closes the socket', () => {
	const h = harness();
	h.sockets[0].open();
	const heartbeatTimeout = [...h.timers.values()].find(
		item => item.delay === 10000,
	);
	assert(heartbeatTimeout);
	heartbeatTimeout.fn();
	assert.equal(h.sockets[0].readyState, 3);
	assert.equal(h.intervals.size, 0);
	h.cleanup();
});

test('widget waits for scripts and requires an authenticated overlay URL', () => {
	const h = harness({ ready: false });
	assert.equal(h.sockets.length, 0);
	h.cleanup();
	const noToken = harness({ token: false });
	assert.equal(noToken.sockets.length, 0);
	noToken.cleanup();
});
test('opening a socket does not release requests before registration acknowledgement', async () => {
	const h = harness({ autoRegister: false });
	h.sockets[0].open();
	const pending = h.slime2.request('test', {});
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.sockets[0].sent.length, 1);
	assert.equal(h.sockets[0].sent[0].data.token.length, 48);
	h.sockets[0].message({
		widgetId: 'widget_test',
		type: 'registered',
		data: {},
	});
	await new Promise(resolve => setImmediate(resolve));
	const request = h.sockets[0].sent.find(
		message => message.type === 'request',
	);
	assert(request);
	h.sockets[0].message({
		widgetId: 'widget_test',
		type: 'widget-response',
		data: {
			type: 'test',
			request_id: request.data.request_id,
			response: 'ok',
		},
	});
	assert.equal(await pending, 'ok');
	h.cleanup();
	assert.equal(h.timers.size, 0);
	assert.equal(h.intervals.size, 0);
});
