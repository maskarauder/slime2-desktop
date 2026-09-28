import type { WidgetSetting, WidgetSettings } from './json/widgetSettings';
import type { WidgetValue, WidgetValues } from './json/widgetValues';

type Scalar = string | number | boolean | null;
type MigrationOperation =
	| { type: 'rename'; from: string; to: string }
	| {
			type: 'convert';
			key: string;
			conversion: 'to-string' | 'to-number' | 'to-boolean' | 'map';
			mappings?: { from: Scalar; to: Scalar }[];
	  };

export type WidgetMigration = { operations: MigrationOperation[] };

export type WidgetSettingsMigrationResult = {
	values: WidgetValues;
	added: string[];
	removed: string[];
	renamed: string[];
	warnings: string[];
};

type Field = {
	kind: 'field';
	setting: WidgetSetting.AnyInput;
	group?: string;
	key: string;
	converted?: boolean;
};
type Group = { kind: 'group'; rows: string[] };
type Shape = Map<string, Field | Group>;

const MAX_MIGRATIONS = 128;
const MAX_OPERATIONS = 1024;
const MAX_MAPPINGS = 1024;

function fail(message: string): never {
	throw new Error(`Widget settings update: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		fail(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function keys(
	value: Record<string, unknown>,
	allowed: string[],
	label: string,
) {
	if (Object.keys(value).some(key => !allowed.includes(key))) {
		fail(`${label} contains an unsupported property.`);
	}
}

function nonemptyString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim() || value.length > 512) {
		fail(`${label} must be a nonempty string of at most 512 characters.`);
	}
	return value;
}

function scalar(value: unknown): value is Scalar {
	return (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	);
}

function parseOperations(value: unknown): MigrationOperation[] {
	if (!Array.isArray(value) || value.length > MAX_OPERATIONS) {
		fail(
			`operations must be an array with at most ${MAX_OPERATIONS} entries.`,
		);
	}
	return value.map((entry, index) => {
		const label = `Operation ${index + 1}`;
		const op = object(entry, label);
		if (op.type === 'rename') {
			keys(op, ['type', 'from', 'to'], label);
			const from = nonemptyString(op.from, `${label} from`);
			const to = nonemptyString(op.to, `${label} to`);
			if (from === to) fail(`${label} must rename to a different key.`);
			return { type: 'rename', from, to };
		}
		if (op.type !== 'convert') fail(`${label} has an unsupported type.`);
		keys(op, ['type', 'key', 'conversion', 'mappings'], label);
		const key = nonemptyString(op.key, `${label} key`);
		const conversion = op.conversion;
		if (
			conversion !== 'to-string' &&
			conversion !== 'to-number' &&
			conversion !== 'to-boolean' &&
			conversion !== 'map'
		) {
			fail(`${label} has an unsupported conversion.`);
		}
		if (conversion !== 'map') {
			if (op.mappings !== undefined)
				fail(`${label} only accepts mappings for map.`);
			return { type: 'convert', key, conversion };
		}
		if (!Array.isArray(op.mappings) || op.mappings.length > MAX_MAPPINGS) {
			fail(
				`${label} mappings must be an array with at most ${MAX_MAPPINGS} entries.`,
			);
		}
		const sources = new Set<Scalar>();
		const mappings = op.mappings.map(entry => {
			const mapping = object(entry, `${label} mapping`);
			keys(mapping, ['from', 'to'], `${label} mapping`);
			if (!scalar(mapping.from) || !scalar(mapping.to)) {
				fail(`${label} mapping values must be finite JSON scalars.`);
			}
			if (sources.has(mapping.from))
				fail(`${label} has duplicate mapping sources.`);
			sources.add(mapping.from);
			return { from: mapping.from, to: mapping.to };
		});
		return { type: 'convert', key, conversion, mappings };
	});
}

/**
 * Select a deterministic chain of exact package versions; never execute ZIP
 * code.
 */
export function selectWidgetMigration(
	manifest: unknown,
	fromVersion: string,
	toVersion: string,
): WidgetMigration | undefined {
	if (manifest === undefined || manifest === null) return undefined;
	const data = object(manifest, 'Migration manifest');
	keys(data, ['schemaVersion', 'migrations'], 'Migration manifest');
	if (data.schemaVersion !== 1)
		fail('Unsupported migration manifest schemaVersion.');
	if (
		!Array.isArray(data.migrations) ||
		data.migrations.length > MAX_MIGRATIONS
	) {
		fail(
			`migrations must be an array with at most ${MAX_MIGRATIONS} entries.`,
		);
	}
	const steps = new Map<
		string,
		{ to: string; operations: MigrationOperation[] }
	>();
	let total = 0;
	for (const entry of data.migrations) {
		const step = object(entry, 'Migration step');
		keys(step, ['from', 'to', 'operations'], 'Migration step');
		const from = nonemptyString(step.from, 'Migration from version');
		const to = nonemptyString(step.to, 'Migration to version');
		if (steps.has(from))
			fail(`Ambiguous migration steps from version ${from}.`);
		const operations = parseOperations(step.operations);
		total += operations.length;
		if (total > MAX_OPERATIONS)
			fail('Migration manifest contains too many operations.');
		steps.set(from, { to, operations });
	}
	// Validate all steps, including disconnected branches, before selecting one.
	for (const start of steps.keys()) {
		const visited = new Set<string>();
		let version = start;
		while (steps.has(version)) {
			if (visited.has(version))
				fail('Migration manifest contains a version cycle.');
			visited.add(version);
			version = steps.get(version)!.to;
		}
	}
	const operations: MigrationOperation[] = [];
	let current = fromVersion;
	while (current !== toVersion) {
		const step = steps.get(current);
		if (!step)
			fail(`No migration chain from ${fromVersion} to ${toVersion}.`);
		operations.push(...step.operations);
		current = step.to;
	}
	return { operations };
}

function isInput(
	setting: WidgetSetting.NonGroup,
): setting is WidgetSetting.AnyInput {
	return setting.type.endsWith('-input');
}

function shapeFrom(settings: WidgetSettings): Shape {
	const shape: Shape = new Map();
	function add(path: string, node: Field | Group) {
		if (shape.has(path)) fail(`Duplicate setting key ${path}.`);
		shape.set(path, node);
	}
	function addField(
		key: string,
		setting: WidgetSetting.NonGroup,
		group?: string,
	) {
		if (!isInput(setting)) return;
		// [] is reserved for repeated-row migration paths, never an actual row ID.
		if (key.includes('[]'))
			fail(`Setting key ${key} uses the reserved [] marker.`);
		add(group ? `${group}[].${key}` : key, {
			kind: 'field',
			key,
			group,
			setting,
		});
	}
	for (const category of Object.values(settings)) {
		for (const [key, setting] of Object.entries(category.settings)) {
			if (setting.type === 'multi-section') {
				if (key.includes('[]'))
					fail(`Setting key ${key} uses the reserved [] marker.`);
				add(key, { kind: 'group', rows: [] });
				for (const [child, field] of Object.entries(setting.settings)) {
					addField(child, field, key);
				}
			} else if (setting.type === 'section') {
				for (const [child, field] of Object.entries(setting.settings))
					addField(child, field);
			} else {
				addField(key, setting);
			}
		}
	}
	// Validate companion-key collisions even when a repeating group has no rows.
	const declared = new Set(shape.keys());
	for (const [path, node] of shape) {
		if (
			node.kind === 'field' &&
			hasVolume(node.setting) &&
			declared.has(`${path}.volume`)
		) {
			fail(
				`Settings and their companion values collide at ${path}.volume.`,
			);
		}
	}
	return shape;
}

function defaultValue(setting: WidgetSetting.AnyInput): WidgetValue {
	if (setting.defaultValue !== undefined)
		return structuredClone(setting.defaultValue);
	switch (setting.type) {
		case 'toggle-input':
			return false;
		case 'number-input':
			return null;
		case 'slider-input':
			return setting.min ?? 0;
		case 'dropdown-input':
		case 'select-input':
			return setting.options[0]?.value ?? '';
		case 'multi-select-input':
		case 'multi-text-input':
		case 'multi-image-input':
		case 'multi-audio-input':
		case 'multi-video-input':
			return [];
		default:
			return '';
	}
}

function hasVolume(setting: WidgetSetting.AnyInput) {
	return [
		'audio-input',
		'video-input',
		'multi-audio-input',
		'multi-video-input',
	].includes(setting.type);
}

function fieldKeys(field: Field, shape: Shape): string[] {
	if (!field.group) return [field.key];
	const group = shape.get(field.group);
	if (group?.kind !== 'group') fail(`Missing repeated group ${field.group}.`);
	return group.rows.map(row => `${row}.${field.key}`);
}

// Define own properties rather than treating imported JSON keys as prototypes.
function set(values: WidgetValues, key: string, value: WidgetValue) {
	Object.defineProperty(values, key, {
		value: structuredClone(value),
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function readRows(value: WidgetValue, path: string): string[] {
	if (value === undefined || value === null) return [];
	if (
		!Array.isArray(value) ||
		value.some(
			row => typeof row !== 'string' || !row || row.includes('[]'),
		) ||
		new Set(value).size !== value.length
	)
		fail(`Repeated group ${path} must contain unique, nonempty row IDs.`);
	return value as string[];
}

function claim(owned: Set<string>, key: string) {
	if (owned.has(key))
		fail(`Settings and their companion values collide at ${key}.`);
	owned.add(key);
}

function collectOwned(shape: Shape): Set<string> {
	const owned = new Set<string>();
	for (const [path, node] of shape) {
		if (node.kind === 'group') {
			claim(owned, path);
			for (const row of node.rows) claim(owned, row);
		} else {
			for (const key of fieldKeys(node, shape)) {
				claim(owned, key);
				if (hasVolume(node.setting)) claim(owned, `${key}.volume`);
			}
		}
	}
	return owned;
}

function addDefault(
	values: WidgetValues,
	key: string,
	setting: WidgetSetting.AnyInput,
) {
	if (
		!Object.hasOwn(values, key) ||
		values[key] === undefined ||
		values[key] === null
	)
		set(values, key, defaultValue(setting));
	if (!hasVolume(setting)) return;
	const volumeKey = `${key}.volume`;
	if (setting.type.startsWith('multi-')) {
		const media = values[key];
		const volumes = Object.hasOwn(values, volumeKey)
			? values[volumeKey]
			: undefined;
		if (!Array.isArray(media)) return; // The target schema validation reports this.
		if (volumes !== undefined && !Array.isArray(volumes)) {
			fail(`Media volume ${volumeKey} must be an array.`);
		}
		if (Array.isArray(volumes) && volumes.length > media.length) {
			fail(
				`Media volume ${volumeKey} contains more entries than its media list.`,
			);
		}
		set(
			values,
			volumeKey,
			media.map((_, index) =>
				Array.isArray(volumes) ? (volumes[index] ?? 0.2) : 0.2,
			),
		);
	} else if (
		!Object.hasOwn(values, volumeKey) ||
		values[volumeKey] === undefined
	) {
		set(values, volumeKey, 0.2);
	}
}

function compatibleTypes(
	old: WidgetSetting.AnyInput,
	next: WidgetSetting.AnyInput,
) {
	function family(type: WidgetSetting.AnyInput['type']) {
		if (
			[
				'text-input',
				'text-area-input',
				'color-input',
				'font-input',
			].includes(type)
		)
			return 'text';
		if (['number-input', 'slider-input'].includes(type)) return 'number';
		if (['dropdown-input', 'select-input'].includes(type)) return 'choice';
		if (['audio-input', 'video-input', 'image-input'].includes(type))
			return 'media';
		if (
			[
				'multi-audio-input',
				'multi-video-input',
				'multi-image-input',
			].includes(type)
		)
			return 'multi-media';
		return type;
	}
	return family(old.type) === family(next.type);
}

function validateValue(
	value: WidgetValue,
	setting: WidgetSetting.AnyInput,
	path: string,
) {
	let valid = true;
	if (setting.type === 'number-input' || setting.type === 'slider-input') {
		valid =
			(value === null && setting.type === 'number-input') ||
			(typeof value === 'number' &&
				Number.isFinite(value) &&
				(setting.min === undefined || value >= setting.min) &&
				(setting.max === undefined || value <= setting.max));
	} else if (setting.type === 'toggle-input') {
		valid = typeof value === 'boolean';
	} else if (
		setting.type === 'select-input' ||
		setting.type === 'dropdown-input'
	) {
		valid =
			setting.options.some(option => option.value === value) ||
			(setting.options.length === 0 && value === '');
	} else if (setting.type === 'multi-select-input') {
		valid =
			Array.isArray(value) &&
			value.every(item =>
				setting.options.some(option => option.value === item),
			);
	} else if (setting.type.startsWith('multi-')) {
		valid =
			Array.isArray(value) &&
			value.every(item => typeof item === 'string');
	} else {
		valid = typeof value === 'string';
	}
	if (!valid)
		fail(
			`Saved value for ${path} is incompatible with the new setting. Supply an explicit conversion.`,
		);
}

function validateVolume(
	values: WidgetValues,
	key: string,
	setting: WidgetSetting.AnyInput,
) {
	if (!hasVolume(setting)) return;
	const value = values[`${key}.volume`];
	const validVolume = (item: unknown) =>
		typeof item === 'number' &&
		Number.isFinite(item) &&
		item >= 0 &&
		item <= 1;
	if (
		setting.type.startsWith('multi-')
			? !Array.isArray(value) || !value.every(validVolume)
			: !validVolume(value)
	) {
		fail(
			`Saved media volume for ${key} is incompatible with the new setting.`,
		);
	}
}

function moveValue(values: WidgetValues, from: string, to: string) {
	if (Object.hasOwn(values, to))
		fail(`Rename target ${to} already contains a value.`);
	if (Object.hasOwn(values, from)) {
		set(values, to, values[from]);
		delete values[from];
	}
}

function rename(shape: Shape, values: WidgetValues, from: string, to: string) {
	const node = shape.get(from);
	if (!node) fail(`Cannot rename unknown setting ${from}.`);
	if (shape.has(to)) fail(`Rename target ${to} is already declared.`);
	if (node.kind === 'group') {
		if (to.includes('[]'))
			fail('Repeated groups can only be renamed to ordinary group keys.');
		moveValue(values, from, to);
		shape.delete(from);
		shape.set(to, node);
		for (const [path, child] of [...shape]) {
			if (child.kind !== 'field' || child.group !== from) continue;
			const nextPath = `${to}[].${child.key}`;
			if (shape.has(nextPath))
				fail(`Rename target ${nextPath} is already declared.`);
			shape.delete(path);
			shape.set(nextPath, { ...child, group: to });
		}
		return;
	}
	const prefix = node.group ? `${node.group}[].` : '';
	if (
		node.group
			? !to.startsWith(prefix) || to.slice(prefix.length).includes('[]')
			: to.includes('[]')
	) {
		fail(`Rename ${from} must stay in the same repeated group.`);
	}
	const nextKey = to.slice(prefix.length);
	if (!nextKey) fail('Rename targets cannot have an empty field key.');
	const replacement: Field = { ...node, key: nextKey };
	const fromKeys = fieldKeys(node, shape);
	const toKeys = fieldKeys(replacement, shape);
	for (const [index, source] of fromKeys.entries()) {
		const target = toKeys[index]!;
		moveValue(values, source, target);
		if (hasVolume(node.setting))
			moveValue(values, `${source}.volume`, `${target}.volume`);
	}
	shape.delete(from);
	shape.set(to, replacement);
}

function convert(
	value: WidgetValue,
	op: Extract<MigrationOperation, { type: 'convert' }>,
): WidgetValue {
	if (op.conversion === 'map') {
		// Null is a meaningful explicit mapping destination, not a missing mapping.
		const mapped = (item: unknown) => {
			const entry = op.mappings?.find(mapping => mapping.from === item);
			return entry ? entry.to : item;
		};
		if (Array.isArray(value)) {
			const result = value.map(mapped);
			if (result.some(item => item === null || !scalar(item)))
				fail(`Conversion for ${op.key} cannot put null in an array.`);
			return result as (string | number | boolean)[];
		}
		return mapped(value) as WidgetValue;
	}
	if (!scalar(value) || value === null)
		fail(`Conversion for ${op.key} requires a non-null scalar.`);
	if (op.conversion === 'to-string') return String(value);
	if (op.conversion === 'to-number') {
		if (typeof value === 'number') return value;
		if (
			typeof value !== 'string' ||
			!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
		) {
			fail(`Conversion for ${op.key} requires a decimal number.`);
		}
		const number = Number(value);
		if (!Number.isFinite(number))
			fail(`Conversion for ${op.key} must produce a finite number.`);
		return number;
	}
	if (value === true || value === 'true' || value === 1) return true;
	if (value === false || value === 'false' || value === 0) return false;
	fail(`Conversion for ${op.key} requires true, false, 1, or 0.`);
}

/** Preserve raw settings and opaque state; all mutation is confined to clones. */
export function migrateWidgetSettings(
	oldSettings: WidgetSettings,
	newSettings: WidgetSettings,
	rawValues: WidgetValues,
	migration?: unknown,
): WidgetSettingsMigrationResult {
	const operations =
		migration === undefined
			? []
			: (() => {
					const data = object(migration, 'Selected migration');
					keys(data, ['operations'], 'Selected migration');
					return parseOperations(data.operations);
				})();
	const oldShape = shapeFrom(oldSettings);
	const nextShape = shapeFrom(newSettings);
	const values: WidgetValues = structuredClone(rawValues);
	for (const [path, node] of oldShape) {
		if (node.kind !== 'group') continue;
		node.rows = readRows(
			Object.hasOwn(values, path) ? values[path] : undefined,
			path,
		);
		set(values, path, node.rows);
	}
	const originalOwned = collectOwned(oldShape);
	for (const node of oldShape.values()) {
		if (node.kind !== 'field') continue;
		for (const key of fieldKeys(node, oldShape))
			addDefault(values, key, node.setting);
	}
	const renamed: string[] = [];
	for (const op of operations) {
		if (op.type === 'rename') {
			rename(oldShape, values, op.from, op.to);
			renamed.push(`${op.from} → ${op.to}`);
		} else {
			const node = oldShape.get(op.key);
			if (node?.kind !== 'field')
				fail(`Cannot convert unknown input setting ${op.key}.`);
			for (const key of fieldKeys(node, oldShape))
				set(values, key, convert(values[key], op));
			node.converted = true;
		}
	}
	const previousOwned = collectOwned(oldShape);
	const added = [...nextShape.keys()].filter(path => !oldShape.has(path));
	const removed = [...oldShape.keys()].filter(path => !nextShape.has(path));
	for (const [path, node] of nextShape) {
		if (node.kind !== 'group') continue;
		const previous = oldShape.get(path);
		if (previous && previous.kind !== 'group')
			fail(`Setting ${path} cannot become a repeated group.`);
		if (!previous && Object.hasOwn(values, path))
			fail(`New setting ${path} collides with widget-owned state.`);
		node.rows = previous?.kind === 'group' ? [...previous.rows] : [];
		set(values, path, node.rows);
	}
	const nextOwned = collectOwned(nextShape);
	for (const [path, node] of nextShape) {
		if (node.kind !== 'field') continue;
		const previous = oldShape.get(path);
		if (previous?.kind === 'group')
			fail(`Repeated group ${path} cannot become an input.`);
		if (
			previous &&
			!previous.converted &&
			!compatibleTypes(previous.setting, node.setting)
		) {
			fail(
				`Setting type changed for ${path}; supply an explicit conversion.`,
			);
		}
		for (const key of fieldKeys(node, nextShape)) {
			if (!previous && Object.hasOwn(values, key))
				fail(`New setting ${path} collides with widget-owned state.`);
			const volumeKey = `${key}.volume`;
			if (
				hasVolume(node.setting) &&
				!previousOwned.has(volumeKey) &&
				Object.hasOwn(values, volumeKey)
			) {
				fail(
					`New media volume ${volumeKey} collides with widget-owned state.`,
				);
			}
			if (!previous) set(values, key, defaultValue(node.setting));
			// Existing inputs already contain their OLD defaults. Only new companions use new defaults.
			if (hasVolume(node.setting)) addDefault(values, key, node.setting);
			validateValue(values[key], node.setting, path);
			validateVolume(values, key, node.setting);
		}
	}
	for (const key of new Set([...originalOwned, ...previousOwned])) {
		if (!nextOwned.has(key)) delete values[key];
	}
	const opaqueCount = Object.keys(rawValues).filter(
		key => !originalOwned.has(key),
	).length;
	return {
		values,
		added,
		removed,
		renamed,
		warnings: opaqueCount
			? [
					`Preserved ${opaqueCount} widget-owned value${opaqueCount === 1 ? '' : 's'} outside the settings definitions.`,
				]
			: [],
	};
}
