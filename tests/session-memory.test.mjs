import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

const contextMocks = { react: { createContext: () => ({}) } };
const event = index => ({
	type: 'channel.follow',
	timestamp: '2026-01-01T00:00:00Z',
	data: { index },
});

function eventsHarness() {
	let saved;
	const { eventsLogReducer } = loadTs(
		'src/contexts/events_log/useEventsLogDispatch.ts',
		{
			...contextMocks,
			'@@/json/eventsLog': {
				saveEventsLog: (id, log) => {
					saved = { id, log };
				},
			},
		},
	);
	return { reduce: eventsLogReducer, saved: () => saved };
}

test('activity histories retain and save only the newest 1,000 entries per account', () => {
	const h = eventsHarness();
	const other = Object.freeze([event('other')]);
	let state = { other };
	for (let index = 0; index < 1100; index++) {
		state = h.reduce(state, {
			type: 'add',
			id: 'account',
			event: event(index),
		});
		assert(state.account.length <= 1000);
		assert.equal(h.saved().log.length, state.account.length);
	}
	assert.equal(state.account.length, 1000);
	assert.equal(state.account[0].data.index, 100);
	assert.equal(state.account.at(-1).data.index, 1099);
	assert.equal(state.other, other);
	assert.equal(h.saved().id, 'account');
	assert.deepEqual(h.saved().log, state.account);

	const previous = state;
	const incoming = event(1100);
	state = h.reduce(state, { type: 'add', id: 'account', event: incoming });
	incoming.data.index = 'changed after dispatch';
	assert.equal(state.account.at(-1).data.index, 1100);
	assert.equal(previous.account[0].data.index, 100);
	assert.equal(previous.account.at(-1).data.index, 1099);
	assert.notEqual(state.account, previous.account);
	assert.equal(state.account[0], previous.account[1]);
});

test('setting an oversized activity history trims before snapshotting and preserves other accounts', () => {
	const h = eventsHarness();
	const log = Array.from({ length: 1020 }, (_, index) => event(index));
	const other = [event('other')];
	const before = Object.freeze({ other });
	const state = h.reduce(before, { type: 'set', id: 'account', log });
	assert.equal(state.account.length, 1000);
	assert.equal(state.account[0].data.index, 20);
	assert.equal(state.account.at(-1).data.index, 1019);
	assert.equal(state.other, other);
	assert.equal(log.length, 1020);
	log[20].data.index = 'changed after dispatch';
	assert.equal(state.account[0].data.index, 20);
	assert.equal(h.saved().log.length, 1000);
	assert.equal(h.saved().log[0].data.index, 20);
});

test('bot/error histories stay capped per widget without cloning retained payloads', () => {
	let nextId = 0;
	const { botLogsReducer: reduce } = loadTs(
		'src/contexts/bot_logs/useBotLogsDispatch.ts',
		{ ...contextMocks, nanoid: { nanoid: () => String(++nextId) } },
	);
	const other = Object.freeze([{ data: ['other widget'] }]);
	let state = { other };
	for (let index = 0; index < 600; index++) {
		state = reduce(state, {
			type: 'add',
			widgetId: 'widget',
			level: 'error',
			data: [{ index }],
		});
		assert(state.widget.length <= 500);
	}
	assert.equal(state.widget.length, 500);
	assert.equal(state.widget[0].data[0].index, 100);
	assert.equal(state.widget.at(-1).data[0].index, 599);
	assert.equal(state.other, other);
	assert.equal(new Set(state.widget.map(log => log.id)).size, 500);
	assert.equal(state.widget.at(-1).level, 'error');
	assert(state.widget.at(-1).date instanceof Date);

	const previous = state;
	const data = [{ index: 600 }];
	state = reduce(state, {
		type: 'add',
		widgetId: 'widget',
		level: 'info',
		data,
	});
	data[0].index = 'changed after dispatch';
	assert.equal(state.widget.at(-1).data[0].index, 600);
	assert.equal(state.widget.at(-1).level, 'info');
	assert.equal(previous.widget[0].data[0].index, 100);
	assert.equal(previous.widget.at(-1).data[0].index, 599);
	assert.notEqual(state.widget, previous.widget);
	assert.equal(state.widget[0], previous.widget[1]);

	const cleared = reduce(state, { type: 'clear', widgetId: 'widget' });
	assert.equal(cleared.widget.length, 0);
	assert.equal(cleared.other, other);
	assert.equal(state.widget.length, 500);
});

const account = { id: 'account-a', serviceId: '100' };
const followedAt = '2026-01-01T00:00:00Z';
const response = date => ({
	data: { data: date ? [{ followed_at: date }] : [] },
});

function followHarness(lookup = async () => response(followedAt)) {
	let now = 1_000_000;
	let cache;
	const calls = [];
	const { getTwitchFollowDate } = loadTs(
		'src/helpers/services/twitch/twitchFollowDate.ts',
		{
			'./twitchApi': {
				__esModule: true,
				default: {
					getChannelFollower: (...args) => {
						calls.push(args);
						return lookup(...args);
					},
				},
			},
		},
		{
			Date: class extends Date {
				static now() {
					return now;
				}
			},
			// Observe retained entries without adding a production debug API.
			Map: class extends Map {
				constructor(...args) {
					super(...args);
					cache = this;
				}
			},
		},
	);
	return {
		get: (userId, owner = account) => getTwitchFollowDate(owner, userId),
		advance: ms => {
			now += ms;
		},
		cache: () => cache,
		calls,
	};
}

test('follower cache stays bounded during a burst and evicted users are fetched again', async () => {
	const h = followHarness();
	for (let index = 0; index < 2050; index++) {
		assert.equal(await h.get(String(10_000 + index)), followedAt);
		assert(h.cache().size <= 2000);
	}
	assert.equal(h.cache().size, 2000);
	await h.get('12049');
	assert.equal(h.calls.length, 2050);
	await h.get('10000');
	assert.equal(h.calls.length, 2051);
	assert.equal(h.cache().size, 2000);
});

test('a lookup releases expired followers and non-followers even if they never return', async () => {
	const h = followHarness(async (_account, _channel, user) =>
		response(user === '200' ? null : followedAt),
	);
	assert.equal(await h.get('200'), null);
	assert.equal(await h.get('201'), followedAt);
	h.advance(5 * 60 * 1000 - 1);
	assert.equal(await h.get('200'), null);
	assert.equal(await h.get('201'), followedAt);
	assert.equal(h.calls.length, 2);
	assert.equal(h.cache().size, 2);
	h.advance(1);
	await h.get('202');
	assert.equal(h.cache().size, 1);
	await h.get('200');
	assert.equal(h.calls.length, 4);
});

test('follower cache keeps accounts separate and bypasses API calls for broadcaster/mock users', async () => {
	const h = followHarness();
	assert.equal(await h.get(account.serviceId), new Date(0).toISOString());
	assert.equal(await h.get('mock_viewer'), new Date(0).toISOString());
	assert.equal(h.calls.length, 0);
	assert.equal(h.cache().size, 0);
	const other = { id: 'account-b', serviceId: '101' };
	await h.get('200');
	await h.get('200', other);
	await h.get('200');
	await h.get('200', other);
	assert.deepEqual(h.calls, [
		['account-a', '100', '200'],
		['account-b', '101', '200'],
	]);
	assert.equal(h.cache().size, 2);
});

test('failed follower lookups remain retryable and do not retain a cache entry', async () => {
	let attempts = 0;
	const h = followHarness(async () => {
		if (++attempts === 1) throw new Error('Temporary failure');
		return response(followedAt);
	});
	await assert.rejects(h.get('200'), /Temporary failure/);
	assert.equal(h.cache().size, 0);
	assert.equal(await h.get('200'), followedAt);
	assert.equal(h.calls.length, 2);
	assert.equal(h.cache().size, 1);
});
