import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

const { migrateWidgetSettings, selectWidgetMigration } = loadTs(
	'src/helpers/widgetSettingsMigration.ts',
);
const migrate = (...args) => structuredClone(migrateWidgetSettings(...args));
const input = (type, defaultValue, extra = {}) => ({
	type,
	label: 'Synthetic setting',
	...(defaultValue === undefined ? {} : { defaultValue }),
	...extra,
});
const text = value => input('text-input', value);
const schema = settings => ({ general: { label: 'General', settings } });
const section = settings => ({ type: 'section', label: 'Style', settings });
const repeated = settings => ({
	type: 'multi-section',
	label: 'Rules',
	settings,
});
const choice = (type, values, defaultValue) =>
	input(type, defaultValue, {
		options: values.map(value => ({ label: String(value), value })),
	});
const migration = operations => ({ operations });
const rename = (from, to) => ({ type: 'rename', from, to });
const convert = (key, conversion, mappings) => ({
	type: 'convert',
	key,
	conversion,
	...(mappings ? { mappings } : {}),
});
const manifest = migrations => ({ schemaVersion: 1, migrations });
const step = (from, to, operations = []) => ({ from, to, operations });

test('upgrade preserves untouched old defaults, explicit false/zero/empty values, and raw media references', () => {
	const old = schema({
		style: section({
			size: input('number-input', 24),
			font: input('font-input', 'Example Font'),
			color: input('color-input', '#123456'),
		}),
		enabled: input('toggle-input', true),
		limit: input('number-input', 3),
		prefix: text('old prefix'),
		background: input('image-input', 'assets/default.png'),
		sounds: input('multi-audio-input', ['gallery:example.ogg']),
	});
	const next = schema({
		style: section({
			size: input('number-input', 48),
			font: input('font-input', 'Changed Font'),
			color: input('color-input', '#ffffff'),
		}),
		enabled: input('toggle-input', true),
		limit: input('number-input', 5),
		prefix: text('new prefix'),
		background: input('image-input', 'assets/replacement.png'),
		sounds: input('multi-audio-input', ['assets/new.ogg']),
		refresh: input('number-input', 900),
	});
	const raw = { enabled: false, limit: 0, prefix: '' };
	const result = migrate(old, next, raw);
	assert.deepEqual(result.values, {
		enabled: false,
		limit: 0,
		prefix: '',
		size: 24,
		font: 'Example Font',
		color: '#123456',
		background: 'assets/default.png',
		sounds: ['gallery:example.ogg'],
		'sounds.volume': [0.2],
		refresh: 900,
	});
	assert.deepEqual(result.added, ['refresh']);
	assert.deepEqual(result.removed, []);
	assert.deepEqual(raw, { enabled: false, limit: 0, prefix: '' });
});

test('materializes implicit empty, numeric, boolean, option, array, and media defaults without URL rewriting', () => {
	const old = schema({
		text: text(),
		num: input('number-input'),
		slider: input('slider-input', undefined, { min: 5 }),
		toggle: input('toggle-input'),
		choice: choice('dropdown-input', [false, true]),
		multi: input('multi-text-input'),
		image: input('image-input'),
		sound: input('audio-input'),
	});
	assert.deepEqual(migrate(old, old, {}).values, {
		text: '',
		num: null,
		slider: 5,
		toggle: false,
		choice: false,
		multi: [],
		image: '',
		sound: '',
		'sound.volume': 0.2,
	});
});

test('moving a field between categories and regular sections retains its flat key', () => {
	const old = schema({ group: section({ message: text('before') }) });
	const next = {
		elsewhere: { label: 'Elsewhere', settings: { message: text('after') } },
	};
	assert.deepEqual(migrate(old, next, { message: 'custom' }).values, {
		message: 'custom',
	});
});

test('prunes only removed declared values and their companions, retaining opaque widget state', () => {
	const old = schema({
		title: text('Hi'),
		sound: input('audio-input', 'a.ogg'),
		rules: repeated({
			pattern: text('*'),
			sound: input('audio-input', 'b.ogg'),
		}),
	});
	const raw = {
		title: 'custom',
		sound: 'gallery:user.ogg',
		'sound.volume': 0.7,
		rules: ['rules[row1]'],
		'rules[row1]': 'My rule',
		'rules[row1].pattern': 'hello',
		'rules[row1].sound.volume': 0.1,
		'rules[row1].runtimeCounter': 9,
		'rules[previously-removed].pattern': 'stale opaque value',
		internalState: 'saved',
	};
	const result = migrate(old, schema({ title: text('New title') }), raw);
	assert.deepEqual(result.values, {
		title: 'custom',
		'rules[row1].runtimeCounter': 9,
		'rules[previously-removed].pattern': 'stale opaque value',
		internalState: 'saved',
	});
	assert.deepEqual(result.removed, [
		'sound',
		'rules',
		'rules[].pattern',
		'rules[].sound',
	]);
	assert.match(result.warnings[0], /Preserved 3 widget-owned values/);
});

test('repeated rows preserve order, IDs, labels, media volumes, and old defaults while adding and removing child fields', () => {
	const old = schema({
		rules: repeated({
			pattern: text('*'),
			enabled: input('toggle-input', true),
			audio: input('audio-input', 'gallery:default.ogg'),
			retired: text('old'),
		}),
	});
	const next = schema({
		rules: repeated({
			pattern: text('new pattern'),
			enabled: input('toggle-input', false),
			audio: input('audio-input', 'new.ogg'),
			priority: input('number-input', 5),
		}),
	});
	const raw = {
		rules: ['rules[b]', 'rules[a]'],
		'rules[b]': 'Second',
		'rules[a]': 'First',
		'rules[b].pattern': 'hello',
		'rules[a].enabled': false,
		'rules[b].audio.volume': 0,
	};
	const result = migrate(old, next, raw);
	assert.deepEqual(result.values.rules, ['rules[b]', 'rules[a]']);
	assert.equal(result.values['rules[b]'], 'Second');
	assert.equal(result.values['rules[a]'], 'First');
	assert.equal(result.values['rules[b].pattern'], 'hello');
	assert.equal(result.values['rules[a].pattern'], '*');
	assert.equal(result.values['rules[b].enabled'], true);
	assert.equal(result.values['rules[a].enabled'], false);
	assert.equal(result.values['rules[b].audio'], 'gallery:default.ogg');
	assert.equal(result.values['rules[b].audio.volume'], 0);
	assert.equal(result.values['rules[a].audio.volume'], 0.2);
	assert.equal(result.values['rules[a].priority'], 5);
	assert.equal(Object.hasOwn(result.values, 'rules[a].retired'), false);
	assert.deepEqual(result.added, ['rules[].priority']);
	assert.deepEqual(result.removed, ['rules[].retired']);
});

test('renames repeated groups and child fields without regenerating row IDs or labels', () => {
	const old = schema({
		rules: repeated({ sound: input('audio-input', 'default.ogg') }),
	});
	const next = schema({
		events: repeated({ audio: input('audio-input', 'changed.ogg') }),
	});
	const result = migrate(
		old,
		next,
		{
			rules: ['rules[stable]'],
			'rules[stable]': 'Custom name',
			'rules[stable].sound': 'gallery:user.ogg',
			'rules[stable].sound.volume': 0.8,
		},
		migration([
			rename('rules', 'events'),
			rename('events[].sound', 'events[].audio'),
		]),
	);
	assert.deepEqual(result.values, {
		events: ['rules[stable]'],
		'rules[stable]': 'Custom name',
		'rules[stable].audio': 'gallery:user.ogg',
		'rules[stable].audio.volume': 0.8,
	});
	assert.deepEqual(result.added, []);
	assert.deepEqual(result.removed, []);
	assert.deepEqual(result.renamed, [
		'rules → events',
		'events[].sound → events[].audio',
	]);
});

test('renames scalar and multi-media settings with their volume companions', () => {
	const old = schema({ oldSound: input('multi-audio-input', []) });
	const next = schema({ sounds: input('multi-audio-input', []) });
	assert.deepEqual(
		migrate(
			old,
			next,
			{ oldSound: ['a.ogg', 'gallery:b.ogg'], 'oldSound.volume': [0.5] },
			migration([rename('oldSound', 'sounds')]),
		).values,
		{ sounds: ['a.ogg', 'gallery:b.ogg'], 'sounds.volume': [0.5, 0.2] },
	);
});

test('selects exact version chains and applies rename then finite scalar conversions', () => {
	const selected = selectWidgetMigration(
		manifest([
			step('1.0', '1.1', [rename('sizeText', 'size')]),
			step('1.1', '2.0', [convert('size', 'to-number')]),
		]),
		'1.0',
		'2.0',
	);
	const result = migrate(
		schema({ sizeText: text('24') }),
		schema({ size: input('number-input', 40) }),
		{},
		selected,
	);
	assert.equal(result.values.size, 24);
	assert.equal(Object.hasOwn(result.values, 'sizeText'), false);
	assert.equal(selectWidgetMigration(undefined, '1.0', '2.0'), undefined);
	assert.deepEqual(
		structuredClone(selectWidgetMigration(manifest([]), '1.0', '1.0')),
		{ operations: [] },
	);
});

test('explicit conversions preserve false and zero and reject ambiguous or nonfinite conversions', () => {
	const old = schema({ flag: text('false') });
	const next = schema({ flag: input('toggle-input', true) });
	assert.equal(
		migrate(old, next, {}, migration([convert('flag', 'to-boolean')]))
			.values.flag,
		false,
	);
	assert.equal(
		migrate(
			schema({ flag: input('number-input', 0) }),
			schema({ flag: text('default') }),
			{},
			migration([convert('flag', 'to-string')]),
		).values.flag,
		'0',
	);
	for (const value of ['anything', '', '0x10', '1e999', 'Infinity']) {
		assert.throws(
			() =>
				migrate(
					schema({ count: text(value) }),
					schema({ count: input('number-input', 0) }),
					{},
					migration([convert('count', 'to-number')]),
				),
			/Conversion/,
		);
	}
	assert.throws(
		() =>
			migrate(
				old,
				next,
				{ flag: 'no' },
				migration([convert('flag', 'to-boolean')]),
			),
		/Conversion/,
	);
});

test('maps renamed option values within each repeated row and multi-select arrays', () => {
	const old = schema({
		rules: repeated({
			mode: choice('dropdown-input', ['old', 'keep'], 'old'),
		}),
		visible: choice('multi-select-input', ['old', 'keep'], ['old']),
	});
	const next = schema({
		rules: repeated({
			mode: choice('dropdown-input', ['new', 'keep'], 'new'),
		}),
		visible: choice('multi-select-input', ['new', 'keep'], []),
	});
	const mappings = [{ from: 'old', to: 'new' }];
	const result = migrate(
		old,
		next,
		{ rules: ['rules[x]'], 'rules[x]': 'x', visible: ['old', 'keep'] },
		migration([
			convert('rules[].mode', 'map', mappings),
			convert('visible', 'map', mappings),
		]),
	);
	assert.equal(result.values['rules[x].mode'], 'new');
	assert.deepEqual(result.values.visible, ['new', 'keep']);
});

test('rejects incompatible setting types, options, constraints, and group conversions without erasing saved values', () => {
	assert.throws(
		() =>
			migrate(
				schema({ value: text('42') }),
				schema({ value: input('number-input', 42) }),
				{},
			),
		/type changed.*explicit conversion/,
	);
	assert.throws(
		() =>
			migrate(
				schema({ mode: choice('select-input', ['old'], 'old') }),
				schema({ mode: choice('select-input', ['new'], 'new') }),
				{},
			),
		/incompatible.*explicit conversion/,
	);
	assert.throws(
		() =>
			migrate(
				schema({ count: input('number-input', 30) }),
				schema({ count: input('number-input', 10, { max: 20 }) }),
				{},
			),
		/incompatible/,
	);
	assert.throws(
		() =>
			migrate(
				schema({ rows: text('x') }),
				schema({ rows: repeated({ name: text() }) }),
				{},
			),
		/cannot become a repeated group/,
	);
	assert.throws(
		() =>
			migrate(
				schema({ rows: repeated({ name: text() }) }),
				schema({ rows: text('x') }),
				{},
			),
		/cannot become an input/,
	);
});

test('new schema fields and companions cannot consume opaque widget state or another setting', () => {
	assert.throws(
		() =>
			migrate(schema({}), schema({ internal: text() }), {
				internal: 'script-owned',
			}),
		/collides with widget-owned state/,
	);
	assert.throws(
		() =>
			migrate(
				schema({ image: input('image-input', 'a.png') }),
				schema({ image: input('video-input', 'a.mp4') }),
				{ 'image.volume': 0.6 },
			),
		/collides with widget-owned state/,
	);
	assert.throws(
		() =>
			migrate(
				schema({ old: text('old'), next: text('next') }),
				schema({ next: text() }),
				{},
				migration([rename('old', 'next')]),
			),
		/already declared/,
	);
	assert.throws(
		() =>
			migrate(
				schema({ old: text('old') }),
				schema({ next: text() }),
				{ next: 'opaque' },
				migration([rename('old', 'next')]),
			),
		/already contains a value/,
	);
});

test('schema key collisions, repeated row collisions, and malformed row IDs fail safely', () => {
	assert.throws(
		() =>
			migrate(
				schema({
					a: section({ same: text() }),
					b: section({ same: text() }),
				}),
				schema({}),
				{},
			),
		/Duplicate setting key/,
	);
	assert.throws(
		() =>
			migrate(
				schema({
					sound: input('audio-input'),
					'sound.volume': input('number-input'),
				}),
				schema({}),
				{},
			),
		/collide/,
	);
	assert.throws(
		() =>
			migrate(
				schema({
					rows: repeated({
						sound: input('audio-input'),
						'sound.volume': input('number-input'),
					}),
				}),
				schema({}),
				{},
			),
		/collide/,
	);
	assert.throws(
		() =>
			migrate(
				schema({ rules: repeated({ value: text() }), other: text() }),
				schema({}),
				{ rules: ['other'] },
			),
		/collide/,
	);
	for (const rows of [5, ['same', 'same'], [false], [''], ['rules[].x']]) {
		assert.throws(
			() =>
				migrate(
					schema({ rules: repeated({ value: text() }) }),
					schema({}),
					{ rules: rows },
				),
			/row IDs/,
		);
	}
});

test('prototype-like JSON keys remain ordinary own values without polluting objects', () => {
	const settings = schema(
		JSON.parse(
			'{"__proto__":{"type":"text-input","label":"Safe","defaultValue":"default"},"constructor":{"type":"text-input","label":"Safe","defaultValue":"constructor value"}}',
		),
	);
	const values = migrate(settings, settings, {}).values;
	assert.equal(Object.hasOwn(values, '__proto__'), true);
	assert.equal(values.__proto__, 'default');
	assert.equal(values.constructor, 'constructor value');
	assert.equal({}.polluted, undefined);
});

test('repeated fields cannot be moved between groups and unknown migration inputs cannot write opaque state', () => {
	const settings = schema({
		rules: repeated({ value: text() }),
		others: repeated({ value: text() }),
	});
	assert.throws(
		() =>
			migrate(
				settings,
				settings,
				{},
				migration([rename('rules[].value', 'others[].value')]),
			),
		/already declared|same repeated group/,
	);
	assert.throws(
		() =>
			migrate(
				schema({}),
				schema({}),
				{ internal: '42' },
				migration([convert('internal', 'to-number')]),
			),
		/unknown input setting/,
	);
	assert.throws(
		() =>
			migrate(
				schema({}),
				schema({}),
				{},
				migration([rename('unknown', 'new')]),
			),
		/unknown setting/,
	);
});

test('migration rejection leaves caller-owned schemas and raw values untouched', () => {
	const old = schema({ title: text('old'), count: text('bad') });
	const next = schema({
		renamedTitle: text('new'),
		count: input('number-input'),
	});
	const raw = { title: 'user title', counter: 7 };
	const snapshot = structuredClone({ old, next, raw });
	assert.throws(
		() =>
			migrate(
				old,
				next,
				raw,
				migration([
					rename('title', 'renamedTitle'),
					convert('count', 'to-number'),
				]),
			),
		/Conversion/,
	);
	assert.deepEqual({ old, next, raw }, snapshot);
});

test('malformed, ambiguous, cyclic, incomplete, or executable migration manifests are rejected', () => {
	const invalid = [
		{},
		{ schemaVersion: 2, migrations: [] },
		{ schemaVersion: 1, migrations: [], code: 'never run' },
		manifest([step('a', 'b'), step('a', 'c')]),
		manifest([step('a', 'b'), step('b', 'a')]),
		manifest([step('a', 'b', [{ type: 'eval', code: 'never run' }])]),
		manifest([step('a', 'b', [{ type: 'rename', from: 'x', to: 'x' }])]),
		manifest([
			step('a', 'b', [
				convert('x', 'map', [
					{ from: 'a', to: 'b' },
					{ from: 'a', to: 'c' },
				]),
			]),
		]),
		manifest([
			step('a', 'b', [convert('x', 'map', [{ from: {}, to: 'b' }])]),
		]),
		manifest([
			step('a', 'b', [
				{
					type: 'convert',
					key: 'x',
					conversion: 'to-number',
					script: 'never run',
				},
			]),
		]),
	];
	for (const data of invalid)
		assert.throws(
			() => selectWidgetMigration(data, 'a', 'b'),
			/Widget settings update/,
		);
	assert.throws(
		() => selectWidgetMigration(manifest([step('a', 'b')]), 'a', 'c'),
		/No migration chain/,
	);
	assert.throws(
		() =>
			selectWidgetMigration(
				manifest(
					Array.from({ length: 129 }, (_, i) =>
						step(String(i), String(i + 1)),
					),
				),
				'0',
				'129',
			),
		/at most 128/,
	);
});

test('map conversions distinguish explicit null destinations and reject null array entries', () => {
	assert.equal(
		migrate(
			schema({ number: input('number-input', 5) }),
			schema({ number: input('number-input', 10) }),
			{},
			migration([convert('number', 'map', [{ from: 5, to: null }])]),
		).values.number,
		null,
	);
	assert.throws(
		() =>
			migrate(
				schema({
					selected: choice('multi-select-input', ['a'], ['a']),
				}),
				schema({ selected: choice('multi-select-input', ['b'], []) }),
				{},
				migration([
					convert('selected', 'map', [{ from: 'a', to: null }]),
				]),
			),
		/cannot put null in an array/,
	);
});

test('built-in chat widget settings upgrade without dropping saved user configuration', () => {
	const settings = JSON.parse(
		readFileSync(
			new URL(
				'../resources/widgets/slime2_overlay_chat_box/config/settings.json',
				import.meta.url,
			),
			'utf8',
		),
	);
	const values = migrate(settings, settings, {}).values;
	assert.ok(Object.keys(values).length > 5);
	assert.deepEqual(migrate(settings, settings, values).values, values);
});
