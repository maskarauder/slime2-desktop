import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers/fixtures.mjs';
import { loadTs } from './helpers/load-ts.mjs';

function widgetHarness() {
	const sent = [],
		bot = [];
	const api = loadTs(
		'src/helpers/widgetMessage.ts',
		{
			'@/contexts/widget_setting_parent/useWidgetValueKey': {},
			'./commands': {
				sendWebsocketMessage: async (message, channel) =>
					sent.push({ message: JSON.parse(message), channel }),
			},
			'./json/widgetValues': { DEFAULT_VOLUME: 0.2 },
			'./media': {},
		},
		{
			dispatchEvent: event => bot.push(event),
			CustomEvent: class {
				constructor(type, options) {
					this.type = type;
					this.detail = options.detail;
				}
			},
		},
	);
	return { api, sent, bot };
}

test('Twitch fixtures preserve emotes, GIF URLs, memberships, gifts and deletion targets through widget and bot routing', async () => {
	const h = widgetHarness();
	const events = fixture('twitch').notifications;
	for (const { metadata, payload } of events) {
		await h.api.sendTwitchEvent(
			'fixture-account',
			'fixture-widget',
			metadata.message_id,
			metadata.subscription_type,
			metadata.subscription_version,
			metadata.message_timestamp,
			payload.event,
		);
	}
	assert.equal(h.sent.length, events.length);
	assert.equal(h.bot.length, events.length);
	for (let i = 0; i < events.length; i++) {
		const { message, channel } = h.sent[i];
		assert.equal(channel, 'widget_fixture-widget');
		assert.equal(message.type, 'twitch-event');
		assert.equal(message.data.account_id, 'fixture-account');
		assert.equal(message.data.type, events[i].metadata.subscription_type);
		assert.deepEqual(message.data.data, events[i].payload.event);
		assert.deepEqual(
			JSON.parse(JSON.stringify(h.bot[i].detail.data)),
			message.data,
		);
	}
	const gifEvents = h.sent
		.map(({ message }) => message.data.data)
		.filter(event => event.message?.fragments.some(f => f.type === 'gif'));
	assert.equal(gifEvents.length, 2);
	assert.equal(gifEvents[0].message.fragments.length, 1);
	assert.equal(gifEvents[1].message.fragments[1].type, 'emote');
	for (const event of gifEvents) {
		const fragment = event.message.fragments.find(f => f.type === 'gif');
		assert.equal(event.message_type, 'text');
		assert.equal(fragment.gif.id, 'fixture-gif-1');
		assert.equal(
			fragment.gif.url,
			'https://media.example.invalid/gifs/fixture.gif?provider=fixture%2Bonly&width=320&repeat=0',
		);
	}
});

test('YouTube fixtures retain shortcode text, paid events, membership metadata and deletions for every layout', async () => {
	const h = widgetHarness();
	const messages = fixture('youtube').messages;
	for (const widget of ['left', 'right', 'vertical']) {
		for (const message of messages) {
			await h.api.sendYouTubeEvent(
				'fixture-account',
				widget,
				message.id,
				message.snippet.type,
				message.snippet.publishedAt,
				message,
			);
		}
	}
	assert.equal(h.sent.length, messages.length * 3);
	for (const [i, { message, channel }] of h.sent.entries()) {
		assert.equal(message.type, 'youtube-event');
		assert.equal(channel, `widget_${message.widgetId}`);
		assert.deepEqual(message.data.data, messages[i % messages.length]);
	}
	const { getYouTubeGlobalEmotes } = loadTs(
		'src/helpers/services/emotes/YouTube.ts',
	);
	const emote = getYouTubeGlobalEmotes().find(
		e => e.name === ':face-red-droopy-eyes:',
	);
	assert(emote?.srcAnimated.startsWith('https://'));
	assert(
		messages[0].snippet.textMessageDetails.messageText.includes(emote.name),
	);
});

test('Euler fixtures preserve 64-bit string IDs and Unicode emote positions without forwarding unsupported events', async () => {
	const { parseEulerStreamMessage, normalizeChatEvent } = loadTs(
		'src/helpers/services/tiktok/tiktokEvents.ts',
	);
	const bundle = fixture('tiktok');
	const normalized = parseEulerStreamMessage(JSON.stringify(bundle))
		.map(normalizeChatEvent)
		.filter(Boolean);
	assert.equal(normalized.length, 1);
	const chat = normalized[0];
	assert.equal(chat.id, '9000000000000000001');
	assert.equal(chat.data.chatter_user_id, '9000000000000000002');
	assert.equal(chat.timestamp, '2026-01-01T00:00:00.000Z');
	assert.deepEqual(JSON.parse(JSON.stringify(chat.data.message.fragments)), [
		{ type: 'text', text: 'Hi 😀 ' },
		{
			type: 'emote',
			text: ':fixture-wave:',
			emote: {
				id: 'fixture-wave',
				url: 'https://example.invalid/wave.gif',
			},
		},
		{ type: 'text', text: '!' },
	]);
	const h = widgetHarness();
	await h.api.sendTikTokEvent(
		'fixture-account',
		'left',
		chat.id,
		chat.type,
		chat.timestamp,
		chat.data,
	);
	assert.deepEqual(
		h.sent[0].message.data.data,
		JSON.parse(JSON.stringify(chat.data)),
	);
	// Euler can send an array or a single envelope with serialized data as well.
	const event = bundle.messages[0];
	assert.equal(parseEulerStreamMessage(JSON.stringify([event])).length, 1);
	assert.equal(
		normalizeChatEvent(
			parseEulerStreamMessage(
				JSON.stringify({ ...event, data: JSON.stringify(event.data) }),
			)[0],
		).id,
		chat.id,
	);
});
