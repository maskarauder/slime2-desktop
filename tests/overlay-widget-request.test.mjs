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

function harness() {
	const effects = [];
	const refs = [];
	const timers = new Map();
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
		console: { info() {}, error() {} },
		setTimeout(fn, delay) {
			const id = ++nextId;
			timers.set(id, { fn, delay });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		require(name) {
			return dependencies[name];
		},
	});
	exports.default();
	const cleanup = effects.map(fn => fn());
	return {
		slime2,
		refs,
		timers,
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
	const timer = [...h.timers.values()].find(item => item.delay === 10000);
	assert(timer);
	timer.fn();
	await assertion;
	assert.equal(h.sockets[0].listeners.get('open').size, 0);
	assert.equal(h.sockets[0].listeners.get('close').size, 0);
	assert.equal(h.refs[1].current.size, 0);
	h.cleanup();
});
