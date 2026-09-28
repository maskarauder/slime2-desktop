import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

function harness() {
	let accounts = {};
	let metas = {};
	let effects = [];
	let callback;
	let refIndex = 0;
	let disposed = 0;
	let nextTimer = 0;
	const refs = [];
	const timers = new Map();
	const watched = [];
	const sent = [];
	const hook = loadTs(
		'src/hooks/useSevenTvEmotes.ts',
		{
			'@/contexts/accounts/useAccounts': {
				__esModule: true,
				default: () => accounts,
			},
			'@/contexts/widget_metas/useWidgetMetas': {
				__esModule: true,
				default: () => metas,
			},
			'@/helpers/services/emotes/sevenTV': {
				__esModule: true,
				default: {
					subscribe: fn => {
						callback = fn;
						return () => {
							callback = undefined;
						};
					},
					setAccounts: value => watched.push(value),
					dispose: () => disposed++,
				},
			},
			'@/helpers/widgetMessage': {
				sendEmoteCatalogUpdate: async (id, data) =>
					sent.push({ id, data }),
			},
			react: {
				useRef: value => (refs[refIndex++] ??= { current: value }),
				useEffect: fn => effects.push(fn),
			},
		},
		{
			setTimeout: fn => {
				timers.set(++nextTimer, fn);
				return nextTimer;
			},
			clearTimeout: id => timers.delete(id),
		},
	).default;
	return {
		watched,
		sent,
		timers,
		get disposed() {
			return disposed;
		},
		render(nextAccounts, nextMetas = metas) {
			accounts = nextAccounts;
			metas = nextMetas;
			effects = [];
			refIndex = 0;
			hook();
			return effects;
		},
		emit: update => callback?.(update),
		flush() {
			const batch = [...timers.values()];
			timers.clear();
			batch.forEach(fn => fn());
		},
	};
}

const account = (id, service = 'twitch', overrides = {}) => ({
	id,
	service,
	serviceId: `${id}-channel`,
	type: 'read',
	default: true,
	reauthorize: false,
	widgets: {},
	...overrides,
});
const meta = (...services) => ({
	accounts: services.map(service => ({ service, type: 'read' })),
});
const update = (revision, overrides = {}) => ({
	platform: 'twitch',
	serviceId: 'a-channel',
	revision,
	emotes: [
		{
			id: 'emote-a',
			name: `Emote${revision}`,
			srcAnimated: 'https://cdn.invalid/a.webp',
			srcStatic: 'https://cdn.invalid/s.webp',
		},
	],
	...overrides,
});

test('7TV watches each assigned read account once and fans out a burst to three layouts', () => {
	const h = harness();
	const effects = h.render(
		{
			a: account('a'),
			y: account('y', 'youtube'),
			t: account('t', 'tiktok'),
			bot: account('bot', 'twitch', { type: 'bot' }),
		},
		{
			left: meta('twitch', 'youtube'),
			right: meta('twitch'),
			vertical: meta('twitch'),
		},
	);
	const cleanup = effects[0]();
	effects[1]();
	assert.deepEqual(Array.from(h.watched[0], x => x.id).sort(), ['a', 'y']);
	h.emit(update(1));
	h.emit(update(2));
	assert.equal(h.timers.size, 1);
	h.flush();
	assert.deepEqual(h.sent.map(x => x.id).sort(), [
		'left',
		'right',
		'vertical',
	]);
	assert.ok(
		h.sent.every(
			x =>
				x.data.revision === 2 &&
				x.data.account_id === 'a' &&
				x.data.provider === 'seventv',
		),
	);
	h.emit(update(3, { platform: 'youtube', serviceId: 'y-channel' }));
	h.flush();
	assert.equal(h.sent.length, 4);
	assert.equal(h.sent[3].id, 'left');
	cleanup();
	assert.equal(h.disposed, 1);
	assert.equal(h.timers.size, 0);
});

test('7TV updates follow current assignments, ignore removed/reauthorizing accounts, and clear pending work on teardown', () => {
	const h = harness();
	let effects = h.render(
		{ a: account('a'), b: account('b', 'twitch', { default: false }) },
		{ left: meta('twitch') },
	);
	const cleanup = effects[0]();
	effects[1]();
	h.emit(update(1));
	effects = h.render({
		a: account('a'),
		b: account('b', 'twitch', { default: false, widgets: { left: 0 } }),
	});
	effects[1]();
	h.flush();
	assert.equal(h.sent.length, 0);
	assert.deepEqual(
		Array.from(h.watched.at(-1), x => x.id),
		['b'],
	);
	h.emit(update(2, { serviceId: 'b-channel' }));
	h.flush();
	assert.equal(h.sent[0].data.account_id, 'b');
	effects = h.render({
		a: account('a'),
		b: account('b', 'twitch', {
			default: false,
			widgets: { left: 0 },
			reauthorize: true,
		}),
	});
	effects[1]();
	assert.equal(h.watched.at(-1).length, 0);
	h.emit(update(3, { serviceId: 'b-channel' }));
	h.flush();
	assert.equal(h.sent.length, 1);
	h.emit(update(4));
	cleanup();
	h.flush();
	assert.equal(h.sent.length, 1);
});

test('generic emote snapshots reach overlays and bots without changing their envelope', async () => {
	const websocket = [],
		bot = [];
	const { sendEmoteCatalogUpdate } = loadTs(
		'src/helpers/widgetMessage.ts',
		{
			'./commands': {
				sendWebsocketMessage: async (...args) => websocket.push(args),
			},
			'@/contexts/widget_setting_parent/useWidgetValueKey': {
				getWidgetValueChildKey() {},
			},
			'./json/widgetValues': { DEFAULT_VOLUME: 50 },
			'./media': { getWidgetMediaSrc() {} },
		},
		{ CustomEvent, dispatchEvent: event => bot.push(event) },
	);
	const payload = { provider: 'seventv', account_id: 'a', ...update(1) };
	await sendEmoteCatalogUpdate('left', payload);
	assert.deepEqual(JSON.parse(websocket[0][0]), {
		widgetId: 'left',
		type: 'emote-catalog-update',
		data: payload,
	});
	assert.equal(websocket[0][1], 'widget_left');
	assert.equal(bot[0].type, 'emote-catalog-update');
	assert.equal(bot[0].detail.widgetId, 'left');
	const config = JSON.parse(
		readFileSync(
			new URL('../src-tauri/tauri.conf.json', import.meta.url),
			'utf8',
		),
	);
	assert.ok(
		config.app.security.csp['connect-src'].includes('wss://events.7tv.io'),
	);
});

test('7TV routing survives React effect replay without duplicate listeners or pending sends', () => {
	const h = harness();
	const effects = h.render({ a: account('a') }, { left: meta('twitch') });
	const firstCleanup = effects[0]();
	effects[1]();
	h.emit(update(1));
	firstCleanup();
	const cleanup = effects[0]();
	effects[1]();
	h.emit(update(2));
	h.flush();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].data.revision, 2);
	assert.equal(h.watched.length, 2);
	cleanup();
	assert.equal(h.timers.size, 0);
	assert.equal(h.disposed, 2);
});
