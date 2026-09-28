import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
	new URL(
		'../resources/widgets/slime2_overlay_chat_box/script.js',
		import.meta.url,
	),
	'utf8',
);

function emote(name, id = name) {
	return {
		id,
		name,
		srcAnimated: `https://images.example.invalid/${id}.gif`,
		srcStatic: `https://images.example.invalid/${id}.png`,
	};
}

function account(platform, id = platform) {
	return { id, service: platform, serviceId: `${id}-provider` };
}

function harness() {
	const listeners = new Map(),
		requests = [];
	const api = vm.runInNewContext(source + '\n({ Widget, Twitch, YouTube })', {
		window: {
			slime2: {
				request(type, data) {
					return new Promise((resolve, reject) => {
						requests.push({
							type,
							data,
							resolve,
							reject,
							done: false,
						});
					});
				},
			},
		},
		addEventListener(type, handler) {
			listeners.set(type, handler);
		},
	});
	return {
		...api,
		requests,
		emit(type, detail) {
			return listeners.get(`slime2:${type}`)({ detail });
		},
		assign(...accounts) {
			return this.emit('widget-accounts', { accounts });
		},
		update(platform, accountId, revision, emotes, extra = {}) {
			return this.emit('emote-catalog-update', {
				provider: 'seventv',
				platform,
				account_id: accountId,
				revision,
				emotes,
				...extra,
			});
		},
		resolveFor(accountId, responses = {}) {
			for (const request of requests) {
				if (request.done || request.data.account_id !== accountId)
					continue;
				request.done = true;
				const value = responses[request.type] ?? null;
				if (value instanceof Error) request.reject(value);
				else request.resolve(value);
			}
		},
	};
}

test('built-in Twitch catalog replaces additions, removals and aliases without erasing lower providers', async () => {
	const h = harness(),
		pending = h.assign(account('twitch'));
	h.resolveFor('twitch', {
		'get-betterttv-user': {
			emotes: [
				{ id: 'bttv', code: 'Shared' },
				{ id: 'bttv-only', code: 'Base' },
			],
		},
		'get-frankerfacez-room': { emotes: [{ id: 'ffz', name: 'Shared' }] },
		'get-seventv-user': {
			emotes: [emote('Shared'), emote('OldAlias', 'renamed')],
			revision: 1,
		},
	});
	await pending;
	const original = h.Twitch.thirdPartyEmotes;
	assert.equal(original.get('Shared').type, 'seventv');
	h.update('twitch', 'twitch', 2, [
		emote('NewAlias', 'renamed'),
		emote('Added'),
	]);
	assert.equal(h.Twitch.thirdPartyEmotes.has('OldAlias'), false);
	assert.equal(h.Twitch.thirdPartyEmotes.get('Shared').type, 'ffz');
	assert.equal(h.Twitch.thirdPartyEmotes.get('Base').type, 'bttv');
	assert.equal(h.Twitch.thirdPartyEmotes.get('NewAlias').data.id, 'renamed');
	assert.equal(h.Twitch.thirdPartyEmotes.has('Added'), true);
	// Existing render work retains its captured lookup; no old message is rebuilt.
	assert.equal(original.has('OldAlias'), true);
	h.update('twitch', 'twitch', 3, []);
	assert.deepEqual([...h.Twitch.thirdPartyEmotes.keys()].sort(), [
		'Base',
		'Shared',
	]);
	assert.equal(h.Twitch.emoteLayers.seventv.size, 0);
});

test('built-in YouTube catalog restores native, BTTV and FFZ entries in their existing priority order', async () => {
	const h = harness(),
		pending = h.assign(account('youtube'));
	h.resolveFor('youtube', {
		'get-youtube-global-emotes': ['All', 'Bttv', 'Native'].map(name =>
			emote(name, `youtube-${name}`),
		),
		'get-betterttv-user': {
			emotes: ['All', 'Bttv'].map(code => ({ code, id: `bttv-${code}` })),
		},
		'get-frankerfacez-room': { emotes: [{ name: 'All', id: 'ffz-All' }] },
		'get-seventv-user': {
			emotes: ['All', 'Bttv', 'Native'].map(name => emote(name)),
			revision: 4,
		},
	});
	await pending;
	assert(
		[...h.YouTube.thirdPartyEmotes.values()].every(
			entry => entry.type === 'seventv',
		),
	);
	h.update('youtube', 'youtube', 5, []);
	assert.equal(h.YouTube.thirdPartyEmotes.get('All').type, 'ffz');
	assert.equal(h.YouTube.thirdPartyEmotes.get('Bttv').type, 'bttv');
	assert.equal(h.YouTube.thirdPartyEmotes.get('Native').type, 'youtube');
	assert.equal(h.Twitch.thirdPartyEmotes.size, 0);
});

test('a live snapshot wins over an older pending request and rejected providers do not discard it', async () => {
	const h = harness(),
		pending = h.assign(account('twitch'));
	h.update('twitch', 'twitch', 8, [emote('Newest')]);
	h.resolveFor('twitch', {
		'get-betterttv-user': { emotes: [{ code: 'Newest', id: 'bttv' }] },
		'get-frankerfacez-room': new Error('Offline'),
		'get-seventv-user': { emotes: [emote('Old')], revision: 7 },
	});
	await pending;
	assert.equal(h.Twitch.sevenTvRevision, 8);
	assert.equal(h.Twitch.thirdPartyEmotes.get('Newest').type, 'seventv');
	assert.equal(h.Twitch.thirdPartyEmotes.has('Old'), false);
	for (const revision of [
		8,
		7,
		-1,
		undefined,
		NaN,
		8.5,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		h.update('twitch', 'twitch', revision, []);
	}
	h.update('twitch', 'other-account', 100, []);
	h.update('youtube', 'twitch', 100, []);
	h.update('twitch', 'twitch', 100, [], { provider: 'bttv' });
	h.update('twitch', 'twitch', 100, null);
	assert.equal(h.Twitch.sevenTvRevision, 8);
	assert.equal(h.Twitch.thirdPartyEmotes.has('Newest'), true);
});

test('account changes ignore old asset responses and events, including an account removed and then reused', async () => {
	const h = harness(),
		first = h.assign(account('twitch', 'old'));
	const second = h.assign(account('twitch', 'new'));
	h.update('twitch', 'old', 100, [emote('WrongAccount')]);
	h.resolveFor('new', {
		'get-seventv-user': { emotes: [emote('NewAccount')], revision: 0 },
	});
	await second;
	h.resolveFor('old', {
		'get-seventv-user': { emotes: [emote('OldAccount')], revision: 100 },
		'get-betterttv-user': { emotes: [{ code: 'OldBttv', id: 'old-bttv' }] },
		'get-twitch-global-badges': [{ set_id: 'old-badge', versions: [] }],
	});
	await first;
	assert.deepEqual([...h.Twitch.thirdPartyEmotes.keys()], ['NewAccount']);
	assert.equal(h.Twitch.badges.size, 0);
	await h.assign();
	assert.equal(h.Twitch.thirdPartyEmotes.size, 0);
	const reused = h.assign(account('twitch', 'old'));
	h.resolveFor('old', { 'get-seventv-user': { emotes: [], revision: 0 } });
	await reused;
	assert.equal(h.Twitch.thirdPartyEmotes.size, 0);
});

test('disconnect and reconnect invalidate pending responses and reset app-session revisions', async () => {
	const h = harness(),
		first = h.assign(account('youtube'));
	h.update('youtube', 'youtube', 90, [emote('BeforeDisconnect')]);
	h.emit('disconnected');
	h.update('youtube', 'youtube', 100, [emote('WhileDisconnected')]);
	h.resolveFor('youtube', {
		'get-seventv-user': { emotes: [emote('LateResponse')], revision: 101 },
	});
	await first;
	assert.deepEqual(
		[...h.YouTube.thirdPartyEmotes.keys()],
		['BeforeDisconnect'],
	);
	const reconnect = h.emit('connected');
	h.update('youtube', 'youtube', 1, [emote('AfterReconnect')]);
	h.resolveFor('youtube', {
		'get-seventv-user': {
			emotes: [emote('NewSessionRequest')],
			revision: 0,
		},
	});
	await reconnect;
	assert.equal(h.YouTube.sevenTvRevision, 1);
	assert.deepEqual(
		[...h.YouTube.thirdPartyEmotes.keys()],
		['AfterReconnect'],
	);
	assert.equal(
		h.requests.filter(request => request.type === 'get-seventv-user')
			.length,
		2,
	);
	await h.assign(account('youtube'));
	assert.equal(
		h.requests.filter(request => request.type === 'get-seventv-user')
			.length,
		2,
	);
});

test('same-account disconnect and failed refresh preserve provider layers until a valid empty snapshot', async () => {
	for (const platform of ['twitch', 'youtube']) {
		const h = harness(),
			pending = h.assign(account(platform));
		h.resolveFor(platform, {
			'get-youtube-global-emotes': [emote('Native')],
			'get-betterttv-user': { emotes: [{ code: 'Bttv', id: 'bttv' }] },
			'get-frankerfacez-room': {
				emotes: [{ name: 'Shared', id: 'ffz' }],
			},
			'get-seventv-user': {
				emotes: [emote('Shared'), emote('SevenTv')],
				revision: 50,
			},
		});
		await pending;
		const catalog = platform === 'twitch' ? h.Twitch : h.YouTube;
		const cached = [...catalog.thirdPartyEmotes];
		h.emit('disconnected');
		assert.deepEqual([...catalog.thirdPartyEmotes], cached);
		assert.equal(catalog.sevenTvRevision, -1);
		const reconnect = h.emit('connected');
		assert.deepEqual([...catalog.thirdPartyEmotes], cached);
		h.resolveFor(platform, {
			'get-betterttv-user': new Error('Offline'),
			'get-frankerfacez-room': null,
			'get-seventv-user': null,
		});
		await reconnect;
		assert.deepEqual([...catalog.thirdPartyEmotes], cached);
		assert.equal(catalog.sevenTvRevision, -1);
		h.update(platform, platform, 0, []);
		assert.equal(catalog.thirdPartyEmotes.has('SevenTv'), false);
		assert.equal(catalog.thirdPartyEmotes.get('Shared').type, 'ffz');
		assert.equal(catalog.thirdPartyEmotes.get('Bttv').type, 'bttv');
		if (platform === 'youtube')
			assert.equal(
				catalog.thirdPartyEmotes.get('Native').type,
				'youtube',
			);
	}
});

test('malformed normalized snapshots neither remove cached entries nor advance revision', async () => {
	const h = harness(),
		pending = h.assign(account('twitch'));
	h.resolveFor('twitch', {
		'get-seventv-user': { emotes: [emote('Keep')], revision: 5 },
	});
	await pending;
	for (const malformed of [
		null,
		{},
		{ ...emote('Bad'), name: '' },
		{ ...emote('Bad'), srcAnimated: undefined },
		{ ...emote('Bad'), srcAnimated: 1 },
		{ ...emote('Bad'), srcStatic: null },
	]) {
		h.update('twitch', 'twitch', 100, [emote('Partial'), malformed]);
		assert.equal(h.Twitch.sevenTvRevision, 5);
		assert.deepEqual([...h.Twitch.thirdPartyEmotes.keys()], ['Keep']);
	}
	h.update('twitch', 'twitch', 6, []);
	assert.equal(h.Twitch.sevenTvRevision, 6);
	assert.equal(h.Twitch.thirdPartyEmotes.size, 0);
});

test('returning to the same account does not revive requests from its previous assignment', async () => {
	const h = harness(),
		first = h.assign(account('twitch'));
	const obsolete = [...h.requests];
	await h.assign();
	const current = h.assign(account('twitch'));
	// Resolve the new assignment first, then release the old same-account load.
	for (const request of obsolete) request.done = true;
	h.resolveFor('twitch', {
		'get-seventv-user': { emotes: [emote('Current')], revision: 1 },
	});
	await current;
	for (const request of obsolete)
		request.resolve(
			request.type === 'get-seventv-user'
				? { emotes: [emote('Obsolete')], revision: 100 }
				: null,
		);
	await first;
	assert.deepEqual([...h.Twitch.thirdPartyEmotes.keys()], ['Current']);
	assert.equal(h.Twitch.sevenTvRevision, 1);
});

test('legacy initial responses remain usable but cannot overwrite an accepted live revision', async () => {
	const h = harness(),
		first = h.assign(account('twitch'));
	h.resolveFor('twitch', {
		'get-seventv-user': { emotes: [emote('Legacy')] },
	});
	await first;
	assert.equal(h.Twitch.thirdPartyEmotes.has('Legacy'), true);
	const pending = h.assign({
		...account('twitch'),
		serviceId: 'changed-provider-id',
	});
	h.update('twitch', 'twitch', 1, [emote('Current')]);
	h.resolveFor('twitch', {
		'get-seventv-user': { emotes: [emote('OutdatedLegacy')] },
	});
	await pending;
	assert.equal(h.Twitch.thirdPartyEmotes.has('Current'), true);
	assert.equal(h.Twitch.thirdPartyEmotes.has('OutdatedLegacy'), false);
});
