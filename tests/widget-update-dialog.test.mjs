import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const componentSource = ts.transpileModule(
	readFileSync(
		new URL(
			'../src/components/dialog/UpdateWidgetDialog.tsx',
			import.meta.url,
		),
		'utf8',
	),
	{
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
			esModuleInterop: false,
		},
	},
).outputText;

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function text(node) {
	if (node === undefined || node === null || typeof node === 'boolean')
		return '';
	if (Array.isArray(node)) return node.map(text).join('');
	return typeof node === 'object' ? text(node.props?.children) : String(node);
}

function nodes(node) {
	if (!node || typeof node !== 'object') return [];
	if (Array.isArray(node)) return node.flatMap(nodes);
	return [node, ...nodes(node.props?.children)];
}

// Exercise the production component's handlers and effect lifetimes without a
// browser/Tauri runtime. JSX leaves use existing components as opaque nodes.
function harness(options = {}) {
	const meta = { id: 'example.chat', name: 'Example Chat', version: '1.0.0' };
	const metas = options.metas ?? {
		left: meta,
		right: meta,
		vertical: meta,
		other: { ...meta, id: 'example.other' },
	};
	const calls = {
		previews: [],
		discarded: [],
		applied: [],
		restored: [],
		closed: 0,
		backupChecks: 0,
	};
	const slots = [];
	let cursor = 0;
	let effects = [];
	let dirty = true;
	let tree;
	let unmounted = false;
	const hooks = {
		useState(initial) {
			const index = cursor++;
			if (!slots[index]) slots[index] = { value: initial };
			return [
				slots[index].value,
				next => {
					const value =
						typeof next === 'function'
							? next(slots[index].value)
							: next;
					if (!Object.is(value, slots[index].value)) dirty = true;
					slots[index].value = value;
				},
			];
		},
		useRef(initial) {
			const index = cursor++;
			if (!slots[index]) slots[index] = { current: initial };
			return slots[index];
		},
		useEffect(callback, dependencies) {
			const index = cursor++;
			const previous = slots[index];
			if (
				previous &&
				dependencies.every((value, i) =>
					Object.is(value, previous.dependencies[i]),
				)
			)
				return;
			slots[index] = { dependencies };
			effects.push(() => {
				previous?.cleanup?.();
				slots[index].cleanup = callback();
			});
		},
	};
	const service = {
		async hasWidgetUpdateBackup() {
			calls.backupChecks++;
			return typeof options.hasBackup === 'function'
				? options.hasBackup(calls.backupChecks)
				: (options.hasBackup ?? false);
		},
		async previewWidgetUpdate(zipPath, ids) {
			calls.previews.push({ zipPath, ids: [...ids] });
			if (options.preview) return options.preview(zipPath, ids);
			return {
				token: `preview-${calls.previews.length}`,
				meta: { ...meta, version: options.newVersion ?? '2.0.0' },
				widgets: ids.map(widgetId => ({
					widgetId,
					meta: metas[widgetId],
					added: ['newField'],
					removed: ['oldField'],
					renamed: ['oldName → newName'],
					warnings: ['One field needs a new value.'],
				})),
			};
		},
		async discardWidgetUpdate(token) {
			calls.discarded.push(token);
		},
		async applyWidgetUpdate(preview) {
			calls.applied.push(preview);
			return options.apply?.(preview);
		},
		async restoreWidgetUpdate(id) {
			calls.restored.push(id);
			return options.restore?.(id);
		},
	};
	const jsx = (type, props) => ({ type, props });
	const mocks = {
		react: hooks,
		'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
		'@/contexts/dialog/useDialog': {
			useDialog: () => ({
				closeDialog: () => {
					calls.closed++;
				},
			}),
		},
		'@/contexts/widget_metas/useWidgetMetas': { default: () => metas },
		'@/contexts/tile_metas/useTileMetas': {
			default: () => ({
				left: { name: 'Left layout' },
				right: { name: 'Right layout' },
				vertical: { name: 'Vertical layout' },
			}),
		},
		'@/helpers/openFile': {
			openZip: async () => '/invented/example-chat.zip',
		},
		'@/helpers/widgetUpdater': service,
		'./DialogButton/DialogActionButton': { default: 'action' },
		'./DialogButton/DialogConfirmButton': { default: 'confirm' },
		'./DialogContent': { default: 'content' },
	};
	const module = { exports: {} };
	vm.runInNewContext(componentSource, {
		module,
		exports: module.exports,
		Error,
		require(name) {
			assert.ok(Object.hasOwn(mocks, name), `unexpected import ${name}`);
			return mocks[name];
		},
	});
	function render() {
		for (let pass = 0; dirty && !unmounted; pass++) {
			assert.ok(pass < 20, 'component render did not settle');
			dirty = false;
			cursor = 0;
			tree = module.exports.default({ widgetId: 'left' });
			const pending = effects;
			effects = [];
			pending.forEach(effect => effect());
		}
	}
	return {
		calls,
		async settle() {
			render();
			await new Promise(resolve => setImmediate(resolve));
			render();
		},
		button(label) {
			const button = nodes(tree).find(
				node =>
					['button', 'action', 'confirm'].includes(node.type) &&
					text(node) === label,
			);
			assert.ok(button, `missing button ${label}: ${text(tree)}`);
			return button.props;
		},
		checkbox() {
			return nodes(tree).find(node => node.type === 'input')?.props;
		},
		text() {
			return text(tree);
		},
		unmount() {
			unmounted = true;
			slots.forEach(slot => slot.cleanup?.());
		},
	};
}

test('widget update previews one layout, then all package matches, before applying', async () => {
	const h = harness();
	await h.settle();
	assert.equal(h.button('Update widget').disabled, true);
	assert.equal(h.checkbox().checked, false);
	await h.button('Choose ZIP').onClick();
	await h.settle();
	assert.deepEqual(h.calls.previews[0].ids, ['left']);
	assert.equal(h.calls.applied.length, 0);
	assert.match(h.text(), /Left layout1\.0\.0 → 2\.0\.0/);
	assert.match(h.text(), /1 added · 1 removed · 1 renamed settings/);
	assert.match(h.text(), /One field needs a new value\./);
	h.checkbox().onChange({ target: { checked: true } });
	await h.settle();
	assert.deepEqual(h.calls.previews[1].ids, ['left', 'right', 'vertical']);
	assert.deepEqual(h.calls.discarded, ['preview-1']);
	await h.button('Update 3 widgets').onClick();
	assert.equal(h.calls.applied.length, 1);
	assert.equal(h.calls.applied[0].token, 'preview-2');
	assert.equal(h.calls.closed, 1);
	h.unmount();
	assert.deepEqual(
		h.calls.discarded,
		['preview-1'],
		'the service owns consumed tokens',
	);
});

test('a preview that resolves after the dialog closes is discarded', async () => {
	const pending = deferred();
	const h = harness({ preview: () => pending.promise });
	await h.settle();
	await h.button('Choose ZIP').onClick();
	await h.settle();
	assert.equal(h.button('Choose ZIP').disabled, true);
	h.unmount();
	pending.resolve({ token: 'late-preview' });
	await h.settle();
	assert.deepEqual(h.calls.discarded, ['late-preview']);
	assert.equal(h.calls.applied.length, 0);
});

test('closing during apply does not discard the committing token or close a later dialog', async () => {
	const pending = deferred();
	const h = harness({ apply: () => pending.promise });
	await h.settle();
	await h.button('Choose ZIP').onClick();
	await h.settle();
	const update = h.button('Update widget').onClick();
	await h.settle();
	assert.equal(h.button('Update widget').disabled, true);
	h.unmount();
	pending.resolve();
	await update;
	assert.deepEqual(h.calls.discarded, []);
	assert.equal(h.calls.closed, 0);
});

test('failed apply requires a fresh preview, including for same-version reinstalls', async () => {
	const h = harness({
		newVersion: '1.0.0',
		apply: async () => {
			throw new Error('Saved settings changed.');
		},
	});
	await h.settle();
	await h.button('Choose ZIP').onClick();
	await h.settle();
	assert.match(h.text(), /1\.0\.0 → 1\.0\.0 \(reinstall\)/);
	await h.button('Update widget').onClick();
	await h.settle();
	assert.equal(h.button('Update widget').disabled, true);
	assert.match(h.text(), /Saved settings changed\. Choose the ZIP again/);
	assert.equal(h.calls.closed, 0);
	await h.button('Choose ZIP').onClick();
	await h.settle();
	assert.equal(h.calls.previews.length, 2);
	assert.equal(h.button('Update widget').disabled, false);
	h.unmount();
});

test('restoring requires explicit confirmation and restores only the selected layout', async () => {
	const h = harness({ hasBackup: true });
	await h.settle();
	h.button('Restore previous version').onClick();
	await h.settle();
	assert.deepEqual(h.calls.restored, []);
	assert.match(h.text(), /Settings changes made since then will be lost/);
	assert.match(h.text(), /Account assignments also return to the backup/);
	await h.button('Restore').onClick();
	assert.deepEqual(h.calls.restored, ['left']);
	assert.equal(h.calls.closed, 1);
	h.unmount();
});

test('a committed update with follow-up errors refreshes its backup without recommending reinstallation', async () => {
	const failure = Object.assign(
		new Error('Widget update was installed. Reload the browser source.'),
		{ installed: true },
	);
	const h = harness({
		hasBackup: count => count > 1,
		apply: async () => {
			throw failure;
		},
	});
	await h.settle();
	await h.button('Choose ZIP').onClick();
	await h.settle();
	await h.button('Update widget').onClick();
	await h.settle();
	assert.match(
		h.text(),
		/Widget update was installed\. Reload the browser source\./,
	);
	assert.doesNotMatch(h.text(), /Choose the ZIP again/);
	assert.equal(h.button('Update widget').disabled, true);
	assert.equal(h.button('Restore previous version').disabled, false);
	assert.equal(h.calls.backupChecks, 2);
	assert.equal(h.calls.closed, 0);
	h.unmount();
	assert.deepEqual(h.calls.discarded, []);
});

test('a committed restore with follow-up errors leaves confirmation and refreshes backup availability', async () => {
	const failure = Object.assign(
		new Error(
			'Previous version was restored. Restart the app to refresh it.',
		),
		{ installed: true },
	);
	const h = harness({
		hasBackup: true,
		restore: async () => {
			throw failure;
		},
	});
	await h.settle();
	h.button('Restore previous version').onClick();
	await h.settle();
	await h.button('Restore').onClick();
	await h.settle();
	assert.match(
		h.text(),
		/Previous version was restored\. Restart the app to refresh it\./,
	);
	assert.doesNotMatch(h.text(), /Choose the ZIP again/);
	assert.equal(h.button('Restore previous version').disabled, false);
	assert.equal(h.calls.backupChecks, 2);
	assert.equal(h.calls.closed, 0);
	h.unmount();
});

test('widgets without a package ID cannot accidentally bulk-update one another', async () => {
	const h = harness({
		metas: {
			left: { id: '', name: 'Old widget', version: '1' },
			right: { id: '', name: 'Unrelated legacy widget', version: '1' },
		},
	});
	await h.settle();
	assert.equal(h.checkbox(), undefined);
	await h.button('Choose ZIP').onClick();
	await h.settle();
	assert.deepEqual(h.calls.previews[0].ids, ['left']);
	h.unmount();
});
