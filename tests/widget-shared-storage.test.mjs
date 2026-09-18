import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real storage module; only Tauri disk access, metadata, and
// delivery are mocked so these regressions also run outside a desktop app.
const source = readFileSync(
	new URL('../src/helpers/json/widgetSharedStorage.ts', import.meta.url),
	'utf8',
);
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText;

function harness(files = new Map()) {
	const namespaces = new Map([
		['widget_left', 'tester:chat'],
		['widget_right', 'tester:chat'],
		['widget_vertical', 'tester:chat'],
		['widget_other', 'tester:other'],
	]);
	const writes = [];
	const notifications = [];
	let failSave = false;
	let activeSaves = 0;
	let maximumActiveSaves = 0;
	const dependencies = {
		'../commands': {
			async loadJson(path) {
				return structuredClone(files.get(path) ?? {});
			},
			async saveJsonAtomic(value, path) {
				activeSaves += 1;
				maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
				try {
					await new Promise(resolve => setImmediate(resolve));
					if (failSave) throw new Error('Disk unavailable');
					files.set(path, structuredClone(value));
					writes.push(path);
				} finally {
					activeSaves -= 1;
				}
			},
		},
		'../widgetMessage': {
			async sendSharedWidgetStorageChange(widgetId, data) {
				notifications.push({ widgetId, data: structuredClone(data) });
			},
		},
		'./jsonPaths': {
			async mainConfigPath(name) {
				return `/app/config/${name}`;
			},
		},
		'./widgetMeta': {
			async loadWidgetMeta(id) {
				return { storageNamespace: namespaces.get(id) };
			},
		},
	};
	const exports = {};
	vm.runInNewContext(compiled, {
		exports,
		structuredClone,
		TextEncoder,
		require(name) {
			if (!(name in dependencies))
				throw new Error(`Unexpected import: ${name}`);
			return dependencies[name];
		},
	});
	return {
		api: exports,
		files,
		writes,
		notifications,
		namespaces,
		failSaves(value) {
			failSave = value;
		},
		get maximumActiveSaves() {
			return maximumActiveSaves;
		},
	};
}

test('three copies converge on one initial choice and duplicate commands write once', async () => {
	const h = harness();
	const results = await Promise.all(
		['left', 'right', 'vertical'].map((name, i) =>
			h.api.setSharedWidgetStorage(
				`widget_${name}`,
				'persistent',
				'person:a',
				JSON.stringify({ choice: i }),
				'set-if-absent',
			),
		),
	);
	assert.equal(results.filter(result => result.updated).length, 1);
	assert.equal(new Set(results.map(result => result.value.choice)).size, 1);
	assert.equal(h.writes.length, 1);

	const commands = await Promise.all(
		['left', 'right', 'vertical'].map((name, i) =>
			h.api.setSharedWidgetStorage(
				`widget_${name}`,
				'persistent',
				'person:a',
				JSON.stringify({ choice: i + 10 }),
				'set',
				'event:reroll',
			),
		),
	);
	assert.equal(commands.filter(result => result.updated).length, 1);
	assert.equal(new Set(commands.map(result => result.value.choice)).size, 1);
	assert.equal(h.writes.length, 2);
	await assert.rejects(
		h.api.setSharedWidgetStorage(
			'widget_left',
			'persistent',
			'person:b',
			'1',
			'set',
			'event:reroll',
		),
		/reused/,
	);
});

test('parallel writes preserve distinct users, reload from disk, and isolate session data', async () => {
	const h = harness();
	await Promise.all(
		Array.from({ length: 25 }, (_, i) =>
			h.api.setSharedWidgetStorage(
				'widget_left',
				'persistent',
				`user:${i}`,
				`${i}`,
				'set',
			),
		),
	);
	assert.equal(h.maximumActiveSaves, 1);
	const restarted = harness(h.files);
	for (let i = 0; i < 25; i += 1) {
		assert.equal(
			(
				await restarted.api.getSharedWidgetStorage(
					'widget_right',
					'persistent',
					`user:${i}`,
				)
			).value,
			i,
		);
	}
	await h.api.setSharedWidgetStorage(
		'widget_left',
		'session',
		'user:0',
		'999',
		'set',
	);
	assert.equal(
		(
			await h.api.getSharedWidgetStorage(
				'widget_right',
				'session',
				'user:0',
			)
		).value,
		999,
	);
	assert.equal(
		(
			await h.api.getSharedWidgetStorage(
				'widget_right',
				'persistent',
				'user:0',
			)
		).value,
		0,
	);
	assert.equal(
		(
			await restarted.api.getSharedWidgetStorage(
				'widget_right',
				'session',
				'user:0',
			)
		).found,
		false,
	);
	assert.equal(h.writes.length, 25);
});

test('failed persistence keeps the previous value and permits retry', async () => {
	const h = harness();
	await h.api.setSharedWidgetStorage(
		'widget_left',
		'persistent',
		'key',
		'1',
		'set',
	);
	h.failSaves(true);
	await assert.rejects(
		h.api.setSharedWidgetStorage(
			'widget_left',
			'persistent',
			'key',
			'2',
			'set',
			'event:2',
		),
		/Disk unavailable/,
	);
	assert.equal(
		(
			await h.api.getSharedWidgetStorage(
				'widget_right',
				'persistent',
				'key',
			)
		).value,
		1,
	);
	h.failSaves(false);
	await h.api.setSharedWidgetStorage(
		'widget_left',
		'persistent',
		'key',
		'2',
		'set',
		'event:2',
	);
	assert.equal(
		(
			await h.api.getSharedWidgetStorage(
				'widget_right',
				'persistent',
				'key',
			)
		).value,
		2,
	);
});

test('change events stay within a namespace and deletes distinguish missing from null', async () => {
	const h = harness();
	await h.api.getSharedWidgetStorage('widget_right', 'persistent', 'key');
	await h.api.getSharedWidgetStorage('widget_other', 'persistent', 'key');
	const saved = await h.api.setSharedWidgetStorage(
		'widget_left',
		'persistent',
		'key',
		'null',
		'set',
	);
	assert.equal(saved.found, true);
	assert.equal(saved.value, null);
	await h.api.broadcastSharedWidgetStorageChange(saved);
	assert.deepEqual(h.notifications.map(item => item.widgetId).sort(), [
		'widget_left',
		'widget_right',
	]);
	assert.equal(
		(
			await h.api.getSharedWidgetStorage(
				'widget_other',
				'persistent',
				'key',
			)
		).found,
		false,
	);
	h.api.forgetSharedWidgetStorageSubscriber('widget_right');
	const removed = await h.api.deleteSharedWidgetStorage(
		'widget_left',
		'persistent',
		'key',
		'remove:1',
	);
	await h.api.broadcastSharedWidgetStorageChange(removed);
	assert.equal(h.notifications.length, 3);
	assert.equal(removed.found, false);
	assert.equal(removed.deleted, true);
	assert.equal(
		(
			await h.api.deleteSharedWidgetStorage(
				'widget_vertical',
				'persistent',
				'key',
				'remove:1',
			)
		).updated,
		false,
	);
});

test('rejects unsafe inputs and corrupt files; namespace dots cannot become path traversal or extensions', async () => {
	const h = harness();
	await assert.rejects(
		h.api.getSharedWidgetStorage('../outside', 'persistent', 'key'),
		/widget ID/,
	);
	await assert.rejects(
		h.api.getSharedWidgetStorage('widget_missing', 'persistent', 'key'),
		/namespace/,
	);
	for (const key of ['__proto__', 'constructor', 'a\0b', 'x'.repeat(241)]) {
		await assert.rejects(
			h.api.setSharedWidgetStorage(
				'widget_left',
				'persistent',
				key,
				'1',
				'set',
			),
			/key is invalid/,
		);
	}
	await assert.rejects(
		h.api.setSharedWidgetStorage(
			'widget_left',
			'persistent',
			'key',
			'{bad',
			'set',
		),
		/valid JSON/,
	);
	await assert.rejects(
		h.api.setSharedWidgetStorage(
			'widget_left',
			'persistent',
			'key',
			'{"__proto__":{}}',
			'set',
		),
		/JSON-safe/,
	);
	await assert.rejects(
		h.api.setSharedWidgetStorage(
			'widget_left',
			'persistent',
			'key',
			JSON.stringify('x'.repeat(65537)),
			'set',
		),
		/too large/,
	);
	h.namespaces.set('widget_left', 'tester:chat.2');
	await h.api.setSharedWidgetStorage(
		'widget_left',
		'persistent',
		'key',
		'1',
		'set',
	);
	assert.equal(
		h.writes[0],
		'/app/config/widget_storage/ns-tester%3Achat%2E2',
	);
	h.namespaces.set('widget_left', '..');
	await h.api.setSharedWidgetStorage(
		'widget_left',
		'persistent',
		'key',
		'1',
		'set',
	);
	assert.equal(h.writes[1], '/app/config/widget_storage/ns-%2E%2E');
	const corrupt = harness(
		new Map([
			[
				'/app/config/widget_storage/ns-tester%3Achat',
				{ unexpected: true },
			],
		]),
	);
	await assert.rejects(
		corrupt.api.setSharedWidgetStorage(
			'widget_left',
			'persistent',
			'key',
			'1',
			'set',
		),
		/malformed/,
	);
	assert.equal(corrupt.writes.length, 0);
});
