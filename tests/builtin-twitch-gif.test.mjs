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

function harness() {
	class Element extends EventTarget {
		constructor(tagName) {
			super();
			this.tagName = tagName;
			this.children = [];
			this.attributes = new Map();
			this.dataset = {};
			this.className = '';
			this.textContent = '';
			this.complete = false;
			this.listeners = new Map();
			this.classList = {
				contains: name => this.className.split(' ').includes(name),
			};
		}
		addEventListener(name, listener) {
			const listeners = this.listeners.get(name) ?? new Set();
			listeners.add(listener);
			this.listeners.set(name, listeners);
			super.addEventListener(name, listener);
		}
		removeEventListener(name, listener) {
			this.listeners.get(name)?.delete(listener);
			super.removeEventListener(name, listener);
		}
		append(...children) {
			for (const child of children) {
				if (child.tagName === '#fragment')
					this.append(...child.children);
				else {
					child.remove();
					this.children.push(child);
					child.parentElement = this;
				}
			}
		}
		remove() {
			if (this.parentElement) {
				const siblings = this.parentElement.children;
				siblings.splice(siblings.indexOf(this), 1);
				this.parentElement = null;
			}
		}
		querySelectorAll(selector) {
			return this.children.flatMap(child => [
				...(child.classList.contains(selector.slice(1)) ? [child] : []),
				...child.querySelectorAll(selector),
			]);
		}
		querySelector(selector) {
			return this.querySelectorAll(selector)[0] ?? null;
		}
		set src(value) {
			this.attributes.set('src', value);
		}
		get src() {
			return this.attributes.get('src');
		}
		removeAttribute(name) {
			this.attributes.delete(name);
		}
	}
	const timers = new Map();
	let sequence = 0;
	const document = {
		createElement: tag => new Element(tag),
		createDocumentFragment: () => new Element('#fragment'),
		getElementById(id) {
			assert.equal(id, 'text-fragment-template');
			return { tagName: 'TEMPLATE', content: {} };
		},
		importNode() {
			const fragment = this.createDocumentFragment();
			const text = this.createElement('span');
			text.className = 'text';
			fragment.append(text);
			return fragment;
		},
	};
	const api = vm.runInNewContext(
		source +
			'\n({ buildMessageFragments, activateMessageGifs, releaseMessageGifs, waitForMessageImage, Widget })',
		{
			window: { slime2: {} },
			document,
			URL,
			addEventListener() {},
			setTimeout(fn, delay) {
				const id = ++sequence;
				timers.set(id, { fn, delay });
				return id;
			},
			clearTimeout(id) {
				timers.delete(id);
			},
		},
	);
	return { ...api, document, Element, timers };
}

function gif(
	url = 'https://images.example.invalid/a.gif?sig=test%2Bvalue&size=small#frame',
) {
	return {
		type: 'gif',
		text: '[<img src=x onerror=alert(1)>]',
		gif: { id: 'invented-gif-id', url },
	};
}

function build(h, fragment = gif(), platform = 'twitch', budget) {
	const message = h.document.createElement('div');
	message.append(...h.buildMessageFragments(fragment, platform, budget));
	return message;
}

test('built-in Twitch GIF waits for display and preserves the complete provider URL and safe text', () => {
	const h = harness();
	const fragment = gif();
	const message = build(h, fragment);
	const image = message.querySelector('.chat-gif');
	assert(image);
	assert.equal(image.src, undefined);
	assert.equal(image.width, 280);
	assert.equal(image.height, 160);
	assert.equal(image.alt, fragment.text);
	assert.equal(image.referrerPolicy, 'no-referrer');
	assert.equal(message.querySelector('.text').textContent, fragment.text);
	assert.equal(message.querySelector('.text').children.length, 0);
	h.activateMessageGifs(message);
	assert.equal(image.src, fragment.gif.url);
	assert.equal(h.timers.size, 1);
	image.dispatchEvent(new Event('load'));
	assert.equal(h.timers.size, 0);
	assert.equal(image.listeners.get('error').size, 0);
});

test('unsafe or missing GIF URLs, other platforms, and static mode remain text', () => {
	const h = harness();
	for (const url of [
		undefined,
		'',
		'broken',
		'http://example.invalid/x.gif',
		'javascript:alert(1)',
		'data:image/gif;base64,AAAA',
		'https://user:secret@example.invalid/x.gif',
		'https://example.invalid/' + 'x'.repeat(8192),
	]) {
		const fragment = gif();
		fragment.gif.url = url;
		const message = build(h, fragment);
		assert.equal(message.querySelector('.chat-gif'), null);
		assert.equal(message.querySelector('.text').textContent, fragment.text);
	}
	assert.equal(build(h, gif(), 'youtube').querySelector('.chat-gif'), null);
	assert.equal(build(h, gif(), 'tiktok').querySelector('.chat-gif'), null);
	h.Widget.values.set('use-static-emotes', true);
	assert.equal(build(h).querySelector('.chat-gif'), null);
	assert.equal(h.timers.size, 0);
});

test('GIF fragments share a one-image message budget and ordinary text URLs are not embedded', () => {
	const h = harness();
	const message = h.document.createElement('div');
	const budget = { remaining: 1 };
	message.append(...h.buildMessageFragments(gif(), 'twitch', budget));
	message.append(...h.buildMessageFragments(gif(), 'twitch', budget));
	message.append(
		...h.buildMessageFragments({
			type: 'text',
			text: 'https://example.invalid/image.gif',
		}),
	);
	assert.equal(message.querySelectorAll('.chat-gif').length, 1);
	assert.equal(message.querySelectorAll('.text').length, 3);
});

test('failed and stalled GIF downloads reveal text and release their source, timer and listeners', () => {
	for (const outcome of ['error', 'timeout']) {
		const h = harness();
		const message = build(h);
		const image = message.querySelector('.chat-gif');
		h.activateMessageGifs(message);
		if (outcome === 'error') image.dispatchEvent(new Event('error'));
		else {
			const timer = [...h.timers.values()][0];
			assert.equal(timer.delay, 5000);
			timer.fn();
		}
		assert.equal(message.querySelector('.chat-gif'), null);
		assert.equal(image.src, undefined);
		assert.equal(message.querySelector('.text').hidden, false);
		assert.equal(h.timers.size, 0);
		assert.equal(image.listeners.get('load').size, 0);
		assert.equal(image.listeners.get('error').size, 0);
	}
});

test('message removal releases an active GIF and static mode prevents deferred loads', () => {
	const h = harness();
	const message = build(h);
	const image = message.querySelector('.chat-gif');
	h.activateMessageGifs(message);
	h.releaseMessageGifs(message);
	h.releaseMessageGifs(message);
	assert.equal(image.src, undefined);
	assert.equal(h.timers.size, 0);
	assert.equal(message.querySelector('.chat-gif'), null);

	const pending = build(h);
	h.Widget.values.set('use-static-emotes', true);
	h.activateMessageGifs(pending);
	assert.equal(pending.querySelector('.chat-gif'), null);
	assert.equal(h.timers.size, 0);
});

test('the built-in image wait settles on error or timeout without leaking listeners', async () => {
	for (const outcome of ['error', 'timeout', 'load']) {
		const h = harness();
		const image = new h.Element('img');
		const settled = h.waitForMessageImage(image);
		if (outcome === 'timeout') [...h.timers.values()][0].fn();
		else image.dispatchEvent(new Event(outcome));
		await settled;
		assert.equal(h.timers.size, 0);
		assert.equal(image.listeners.get('load').size, 0);
		assert.equal(image.listeners.get('error').size, 0);
	}
});
