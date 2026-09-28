import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

const deferred = () => {
	let resolve, reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const schema = (limit, extra = {}) => ({
	main: {
		label: 'Settings',
		settings: {
			limit: {
				type: 'number-input',
				label: 'Limit',
				defaultValue: limit,
			},
			...extra,
		},
	},
});
const meta = version => ({
	id: 'test:chat',
	name: 'Example Chat',
	creator: 'Example',
	version,
	type: ['overlay'],
	accounts: [{ service: 'twitch', type: 'read' }],
});

function queueHarness() {
	const writes = [],
		timers = new Map();
	let next = 0,
		failure = false;
	const queue = loadTs(
		'src/helpers/json/queueSaveJson.ts',
		{
			'../commands': {
				saveJsonAtomic: async (value, path) => {
					if (failure) throw new Error('Disk full');
					writes.push({ value: structuredClone(value), path });
				},
			},
		},
		{
			setTimeout: fn => {
				timers.set(++next, fn);
				return next;
			},
			clearTimeout: id => timers.delete(id),
			console: { ...console, error() {} },
		},
	);
	return {
		queue,
		writes,
		fail: value => {
			failure = value;
		},
	};
}

test('queued saves flush delayed path resolution before a configuration transaction', async () => {
	const h = queueHarness(),
		path = deferred();
	const raw = { limit: 3 };
	const saving = h.queue.queueSaveJsonAfterPath(raw, path.promise);
	raw.limit = 99;
	let flushed = false;
	const flush = h.queue.flushQueuedSaves().then(() => {
		flushed = true;
	});
	await tick();
	assert.equal(flushed, false);
	path.resolve('/values');
	await saving;
	await flush;
	assert.deepEqual(h.writes, [{ path: '/values', value: { limit: 3 } }]);
});

test('paused paths reconcile even delayed saves; unrelated writes continue', async () => {
	const h = queueHarness();
	const release = h.queue.pauseQueuedSaves(['/values']);
	const path = deferred();
	const saving = h.queue.queueSaveJsonAfterPath({ old: true }, path.promise);
	h.queue.queueSaveJson({ other: true }, '/other');
	const done = release((_, value) => ({ ...value, migrated: true }));
	await tick();
	assert.equal(
		h.writes.some(w => w.path === '/values'),
		false,
	);
	path.resolve('/values');
	await saving;
	await done;
	assert.deepEqual(h.writes.find(w => w.path === '/values').value, {
		old: true,
		migrated: true,
	});
	assert(h.writes.some(w => w.path === '/other'));
});

test('failed resume writes are retained for retry and do not leave the path paused', async () => {
	const h = queueHarness();
	const release = h.queue.pauseQueuedSaves(['/values']);
	h.queue.queueSaveJson({ limit: 3 }, '/values');
	h.fail(true);
	await assert.rejects(release(), /Disk full/);
	h.fail(false);
	await h.queue.flushQueuedSaves();
	assert.deepEqual(h.writes[0].value, { limit: 3 });
});

function serviceHarness() {
	const queue = queueHarness(),
		state = loadTs('src/helpers/widgetUpdateState.ts');
	const calls = [],
		events = [],
		reloads = [],
		cached = [];
	const slots = { widget_a: { account: 0 } };
	const prepared = {
		token: 'prepared',
		meta: meta('2'),
		settings: schema(10, {
			enabled: {
				type: 'toggle-input',
				label: 'Enabled',
				defaultValue: true,
			},
		}),
		migrations: null,
		widgets: [
			{
				widgetId: 'widget_a',
				meta: meta('1'),
				settings: schema(3),
				values: { opaque: 'kept' },
			},
		],
	};
	let commitFailure,
		failAfterCommit = false;
	const api = loadTs(
		'src/helpers/widgetUpdater.ts',
		{
			'@tauri-apps/api/core': {
				invoke: async (name, args) => {
					calls.push({
						name,
						args,
						held: state.isWidgetUpdating('widget_a'),
					});
					if (name === 'prepare_widget_update')
						return structuredClone(prepared);
					if (name === 'commit_widget_update') {
						if (commitFailure) throw new Error(commitFailure);
						if (failAfterCommit) {
							queue.queue.queueSaveJson(
								{
									account: {
										id: 'account',
										widgets: { widget_a: 9 },
										displayName: 'Newest',
									},
								},
								'/config/accounts',
							);
							queue.fail(true);
						}
						return { widgetIds: ['widget_a'], accountSlots: slots };
					}
					if (name === 'restore_widget_update')
						return {
							widgetId: 'widget_a',
							meta: meta('1'),
							settings: schema(3),
							values: { limit: 3 },
							accountSlots: slots.widget_a,
						};
					if (name === 'get_widget_update_status') return true;
				},
			},
			'react-dom': { flushSync: fn => fn() },
			'./json/jsonPaths': {
				mainConfigPath: async name => `/config/${name}`,
				tileFolderPath: async id => `/tiles/${id}`,
			},
			'./json/queueSaveJson': queue.queue,
			'./json/widgetMeta': {
				WidgetMetaSchema: { parse: value => value },
			},
			'./json/widgetSettings': {
				WidgetSettingsSchema: { parse: value => value },
			},
			'./json/widgetValues': { WidgetValuesZ: { parse: value => value } },
			'./queryClient': {
				queryClient: {
					cancelQueries: async args =>
						calls.push({ name: 'cancel', args }),
					setQueryData: (key, value) => cached.push({ key, value }),
				},
			},
			'./widgetMessage': {
				sendWidgetCoreChange: async id =>
					reloads.push({ id, held: state.isWidgetUpdating(id) }),
			},
			'./widgetUpdateState': state,
		},
		{
			CustomEvent: class {
				constructor(type, options) {
					this.type = type;
					this.detail = options.detail;
				}
			},
			dispatchEvent: event => {
				events.push({
					event,
					held: state.isWidgetUpdating('widget_a'),
				});
				return true;
			},
		},
	);
	return {
		api,
		queue,
		state,
		calls,
		events,
		reloads,
		cached,
		prepared,
		failCommit: message => {
			commitFailure = message;
		},
		failAfterCommit: () => {
			failAfterCommit = true;
		},
	};
}

test('upgrade commits migrated old defaults before hydrating state and reloading the original widget', async () => {
	const h = serviceHarness();
	const preview = await h.api.previewWidgetUpdate('/new.zip', ['widget_a']);
	assert.equal(preview.widgets[0].values.limit, 3);
	assert.equal(preview.widgets[0].values.enabled, true);
	assert.equal(preview.widgets[0].values.opaque, 'kept');
	await h.api.applyWidgetUpdate(preview);
	const commit = h.calls.find(c => c.name === 'commit_widget_update');
	assert.equal(commit.held, true);
	assert.equal(commit.args.updates[0].values.limit, 3);
	assert(
		h.calls.findIndex(c => c.name === 'cancel') < h.calls.indexOf(commit),
	);
	assert.equal(h.events[0].held, true);
	assert.equal(h.events[0].event.detail.widgets[0].meta.version, '2');
	assert.deepEqual(h.reloads, [{ id: 'widget_a', held: false }]);
	assert.equal(h.cached.length, 1);
	await assert.rejects(
		h.api.applyWidgetUpdate(preview),
		/fresh update preview/,
	);
});

test('failed commit releases save guards without publishing an uninstalled core', async () => {
	const h = serviceHarness();
	const preview = await h.api.previewWidgetUpdate('/new.zip', ['widget_a']);
	h.failCommit('Widget changed since preview');
	await assert.rejects(
		h.api.applyWidgetUpdate(preview),
		/changed since preview/,
	);
	assert.equal(h.state.isWidgetUpdating('widget_a'), false);
	assert.equal(h.events.length, 0);
	assert.equal(h.reloads.length, 0);
	assert(h.calls.some(c => c.name === 'discard_widget_update'));
});

test('an already installed update still reloads when a subsequent configuration save fails', async () => {
	const h = serviceHarness();
	const preview = await h.api.previewWidgetUpdate('/new.zip', ['widget_a']);
	h.failAfterCommit();
	await assert.rejects(
		h.api.applyWidgetUpdate(preview),
		error =>
			error.installed === true && /was installed/.test(error.message),
	);
	assert.deepEqual(h.reloads, [{ id: 'widget_a', held: false }]);
	h.queue.fail(false);
	await h.queue.queue.flushQueuedSaves();
	const value = h.queue.writes.find(w => w.path === '/config/accounts').value;
	assert.equal(value.account.widgets.widget_a, 0);
	assert.equal(value.account.displayName, 'Newest');
});

test('restore hydrates backup settings and assignments then reloads the same widget ID', async () => {
	const h = serviceHarness();
	await h.api.restoreWidgetUpdate('widget_a');
	const result = h.events[0].event.detail;
	assert.equal(result.widgets[0].meta.version, '1');
	assert.equal(result.accountSlots.widget_a.account, 0);
	assert.deepEqual(h.reloads, [{ id: 'widget_a', held: false }]);
});

test('migration errors discard staging without calling the native commit', async () => {
	const h = serviceHarness();
	h.prepared.widgets[0].values.limit = 'invalid number';
	await assert.rejects(
		h.api.previewWidgetUpdate('/new.zip', ['widget_a']),
		/limit/,
	);
	assert(h.calls.some(c => c.name === 'discard_widget_update'));
	assert(!h.calls.some(c => c.name === 'commit_widget_update'));
});

test('account slots remap by stable identity or unambiguous provider/type and leave other metadata intact', () => {
	const { widgetAccountSlotMap, replaceWidgetAccountSlots } = loadTs(
		'src/helpers/widgetAccountMigration.ts',
	);
	const twitch = { service: 'twitch', type: 'read' },
		youtube = { service: 'youtube', type: 'read' };
	assert.deepEqual(
		Array.from(
			widgetAccountSlotMap(
				{ accounts: [twitch, youtube] },
				{ accounts: [youtube, twitch] },
			),
		),
		[1, 0],
	);
	assert.deepEqual(
		Array.from(
			widgetAccountSlotMap(
				{ accounts: [twitch, youtube] },
				{ accounts: [youtube] },
			),
		),
		[null, 0],
	);
	assert.throws(
		() =>
			widgetAccountSlotMap(
				{ accounts: [twitch, twitch] },
				{ accounts: [twitch] },
			),
		/duplicate legacy/,
	);
	const old = {
		a: {
			id: 'a',
			displayName: 'Latest profile',
			widgets: { widget_a: 0, widget_other: 2 },
		},
	};
	const updated = replaceWidgetAccountSlots(old, { widget_a: { a: 1 } });
	assert.equal(updated.a.widgets.widget_a, 1);
	assert.equal(updated.a.widgets.widget_other, 2);
	assert.equal(updated.a.displayName, 'Latest profile');
	assert.equal(old.a.widgets.widget_a, 0);
});
