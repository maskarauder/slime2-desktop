import { loadJson, saveJsonAtomic } from '../commands';
import { sendSharedWidgetStorageChange } from '../widgetMessage';
import { mainConfigPath } from './jsonPaths';
import { loadWidgetMeta } from './widgetMeta';

export type SharedWidgetStorageScope = 'persistent' | 'session';
export type SharedWidgetStorageValue =
	| null
	| boolean
	| number
	| string
	| SharedWidgetStorageValue[]
	| { [key: string]: SharedWidgetStorageValue };

type SharedWidgetStorageFile = {
	version: 1;
	revision: number;
	values: Record<string, SharedWidgetStorageValue>;
};

type SharedWidgetStorageOperation = {
	signature: string;
	result: SharedWidgetStorageResult;
};

export type SharedWidgetStorageResult = {
	namespace: string;
	scope: SharedWidgetStorageScope;
	key: string;
	value: SharedWidgetStorageValue | null;
	found: boolean;
	revision: number;
	updated: boolean;
	deleted?: boolean;
};

const MAX_NAMESPACE_LENGTH = 120;
const MAX_KEY_LENGTH = 240;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_OPERATION_RESULTS = 1000;

const stores = new Map<string, SharedWidgetStorageFile>();
const loadPromises = new Map<string, Promise<SharedWidgetStorageFile>>();
const locks = new Map<string, Promise<void>>();
const subscribers = new Map<string, Set<string>>();
const operationResults = new Map<string, SharedWidgetStorageOperation>();

export async function getSharedWidgetStorage(
	widgetId: string,
	scope: SharedWidgetStorageScope,
	key: string,
): Promise<SharedWidgetStorageResult> {
	const namespace = await getNamespace(widgetId);
	validateKey(key);
	subscribe(namespace, scope, widgetId);

	return withStorageLock(storageId(namespace, scope), async () => {
		const store = await loadStore(namespace, scope);
		const found = Object.prototype.hasOwnProperty.call(store.values, key);

		return {
			namespace,
			scope,
			key,
			value: found ? structuredClone(store.values[key] ?? null) : null,
			found,
			revision: store.revision,
			updated: false,
		};
	});
}

export async function setSharedWidgetStorage(
	widgetId: string,
	scope: SharedWidgetStorageScope,
	key: string,
	valueJson: string,
	mode: 'set' | 'set-if-absent',
	operationId?: string,
): Promise<SharedWidgetStorageResult> {
	const namespace = await getNamespace(widgetId);
	validateKey(key);
	validateOperationId(operationId);
	const value = parseValue(valueJson);
	const id = storageId(namespace, scope);
	const operationKey = operationId
		? JSON.stringify([id, operationId])
		: undefined;
	const operationSignature = `set:${mode}:${key}`;
	subscribe(namespace, scope, widgetId);

	return withStorageLock(id, async () => {
		const previousResult = getOperationResult(
			operationKey,
			operationSignature,
		);
		if (previousResult) return previousResult;

		const store = await loadStore(namespace, scope);
		const found = Object.prototype.hasOwnProperty.call(store.values, key);
		let result: SharedWidgetStorageResult;

		if (
			found &&
			(mode === 'set-if-absent' ||
				JSON.stringify(store.values[key]) === JSON.stringify(value))
		) {
			result = {
				namespace,
				scope,
				key,
				value: store.values[key] ?? null,
				found: true,
				revision: store.revision,
				updated: false,
			};
		} else {
			const nextStore = structuredClone(store);
			nextStore.values[key] = value;
			nextStore.revision += 1;
			validateFileSize(nextStore);
			await persistStore(namespace, scope, nextStore);
			stores.set(id, nextStore);

			result = {
				namespace,
				scope,
				key,
				value,
				found: true,
				revision: nextStore.revision,
				updated: true,
			};
		}

		if (operationKey)
			rememberOperation(operationKey, operationSignature, result);
		return structuredClone(result);
	});
}

export async function deleteSharedWidgetStorage(
	widgetId: string,
	scope: SharedWidgetStorageScope,
	key: string,
	operationId?: string,
): Promise<SharedWidgetStorageResult> {
	const namespace = await getNamespace(widgetId);
	validateKey(key);
	validateOperationId(operationId);
	const id = storageId(namespace, scope);
	const operationKey = operationId
		? JSON.stringify([id, operationId])
		: undefined;
	const operationSignature = `delete:${key}`;
	subscribe(namespace, scope, widgetId);

	return withStorageLock(id, async () => {
		const previousResult = getOperationResult(
			operationKey,
			operationSignature,
		);
		if (previousResult) return previousResult;

		const store = await loadStore(namespace, scope);
		const found = Object.prototype.hasOwnProperty.call(store.values, key);
		let result: SharedWidgetStorageResult;

		if (!found) {
			result = {
				namespace,
				scope,
				key,
				value: null,
				found: false,
				revision: store.revision,
				updated: false,
				deleted: true,
			};
		} else {
			const nextStore = structuredClone(store);
			delete nextStore.values[key];
			nextStore.revision += 1;
			await persistStore(namespace, scope, nextStore);
			stores.set(id, nextStore);

			result = {
				namespace,
				scope,
				key,
				value: null,
				found: false,
				revision: nextStore.revision,
				updated: true,
				deleted: true,
			};
		}

		if (operationKey)
			rememberOperation(operationKey, operationSignature, result);
		return structuredClone(result);
	});
}

export async function broadcastSharedWidgetStorageChange(
	result: SharedWidgetStorageResult,
) {
	if (!result.updated) return;
	const widgetIds = subscribers.get(
		storageId(result.namespace, result.scope),
	);
	if (!widgetIds) return;

	await Promise.allSettled(
		[...widgetIds].map(widgetId =>
			sendSharedWidgetStorageChange(widgetId, result),
		),
	);
}

export function forgetSharedWidgetStorageSubscriber(widgetId: string) {
	for (const widgetIds of subscribers.values()) widgetIds.delete(widgetId);
}

async function getNamespace(widgetId: string) {
	if (!/^widget_[-A-Za-z0-9_]+$/.test(widgetId)) {
		throw new Error('The widget ID is invalid.');
	}
	const { storageNamespace } = await loadWidgetMeta(widgetId);
	if (!storageNamespace) {
		throw new Error(
			'This widget does not declare a shared storage namespace in config/meta.json.',
		);
	}
	if (
		storageNamespace.length > MAX_NAMESPACE_LENGTH ||
		!/^[-a-z0-9._:]+$/.test(storageNamespace)
	) {
		throw new Error('The widget shared storage namespace is invalid.');
	}
	return storageNamespace;
}

function subscribe(
	namespace: string,
	scope: SharedWidgetStorageScope,
	widgetId: string,
) {
	const id = storageId(namespace, scope);
	const widgetIds = subscribers.get(id) ?? new Set<string>();
	widgetIds.add(widgetId);
	subscribers.set(id, widgetIds);
}

async function loadStore(
	namespace: string,
	scope: SharedWidgetStorageScope,
): Promise<SharedWidgetStorageFile> {
	const id = storageId(namespace, scope);
	const cached = stores.get(id);
	if (cached) return cached;

	if (scope === 'session') {
		const store = emptyStore();
		stores.set(id, store);
		return store;
	}

	const existingPromise = loadPromises.get(id);
	if (existingPromise) return existingPromise;

	const promise = (async () => {
		const json = await loadJson(await storagePath(namespace));
		const store = parseStore(json);
		stores.set(id, store);
		return store;
	})();
	loadPromises.set(id, promise);

	try {
		return await promise;
	} finally {
		loadPromises.delete(id);
	}
}

async function persistStore(
	namespace: string,
	scope: SharedWidgetStorageScope,
	store: SharedWidgetStorageFile,
) {
	if (scope === 'persistent') {
		await saveJsonAtomic(store, await storagePath(namespace));
	}
}

async function storagePath(namespace: string) {
	// Prefix avoids Windows device names; encode dots because Rust's JSON file
	// helper treats the last dot as an extension. No user-provided path segments.
	const filename = `ns-${encodeURIComponent(namespace).replace(/\./g, '%2E')}`;
	return mainConfigPath(`widget_storage/${filename}`);
}

function parseStore(value: unknown): SharedWidgetStorageFile {
	if (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 0
	) {
		return emptyStore();
	}

	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		(value as { version?: unknown }).version !== 1 ||
		!Number.isSafeInteger((value as { revision?: unknown }).revision) ||
		((value as { revision: number }).revision ?? -1) < 0 ||
		!isValueRecord((value as { values?: unknown }).values)
	) {
		throw new Error('The shared widget storage file is malformed.');
	}

	const store = value as SharedWidgetStorageFile;
	validateFileSize(store);
	return structuredClone(store);
}

function emptyStore(): SharedWidgetStorageFile {
	return { version: 1, revision: 0, values: {} };
}

function parseValue(valueJson: string): SharedWidgetStorageValue {
	if (byteLength(valueJson) > MAX_VALUE_BYTES) {
		throw new Error('The shared widget storage value is too large.');
	}

	let value: unknown;
	try {
		value = JSON.parse(valueJson);
	} catch {
		throw new Error('The shared widget storage value is not valid JSON.');
	}

	if (!isJsonValue(value)) {
		throw new Error('The shared widget storage value is not JSON-safe.');
	}
	return value;
}

function isValueRecord(
	value: unknown,
): value is Record<string, SharedWidgetStorageValue> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.entries(value).every(
		([key, item]) => isValidKey(key) && isJsonValue(item),
	);
}

function isJsonValue(
	value: unknown,
	depth = 0,
): value is SharedWidgetStorageValue {
	if (depth > 64) return false;
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value))
		return value.every(item => isJsonValue(item, depth + 1));
	if (typeof value !== 'object') return false;
	return Object.entries(value).every(
		([key, item]) =>
			!['__proto__', 'constructor', 'prototype'].includes(key) &&
			isJsonValue(item, depth + 1),
	);
}

function validateKey(key: string) {
	if (!isValidKey(key))
		throw new Error('The shared widget storage key is invalid.');
}

function isValidKey(key: string) {
	return (
		key.length > 0 &&
		key.length <= MAX_KEY_LENGTH &&
		!/[\u0000-\u001f\u007f]/.test(key) &&
		!['__proto__', 'constructor', 'prototype'].includes(key)
	);
}

function validateOperationId(operationId?: string) {
	if (
		operationId !== undefined &&
		(operationId.length === 0 ||
			operationId.length > MAX_KEY_LENGTH ||
			/[\u0000-\u001f\u007f]/.test(operationId))
	) {
		throw new Error('The shared widget storage operation ID is invalid.');
	}
}

function validateFileSize(store: SharedWidgetStorageFile) {
	if (byteLength(JSON.stringify(store)) > MAX_FILE_BYTES) {
		throw new Error('The shared widget storage file is too large.');
	}
}

function byteLength(value: string) {
	return new TextEncoder().encode(value).byteLength;
}

function storageId(namespace: string, scope: SharedWidgetStorageScope) {
	return `${scope}:${namespace}`;
}

async function withStorageLock<T>(id: string, task: () => Promise<T>) {
	const previous = locks.get(id) ?? Promise.resolve();
	let release = () => {};
	const current = new Promise<void>(resolve => {
		release = resolve;
	});
	locks.set(id, current);

	await previous.catch(() => undefined);
	try {
		return await task();
	} finally {
		release();
		if (locks.get(id) === current) locks.delete(id);
	}
}

function getOperationResult(key: string | undefined, signature: string) {
	if (!key) return undefined;
	const operation = operationResults.get(key);
	if (!operation) return undefined;
	if (operation.signature !== signature) {
		throw new Error('The shared widget storage operation ID was reused.');
	}
	return { ...structuredClone(operation.result), updated: false };
}

function rememberOperation(
	key: string,
	signature: string,
	result: SharedWidgetStorageResult,
) {
	operationResults.set(key, {
		signature,
		result: structuredClone(result),
	});
	while (operationResults.size > MAX_OPERATION_RESULTS) {
		const oldestKey = operationResults.keys().next().value;
		if (oldestKey === undefined) break;
		operationResults.delete(oldestKey);
	}
}
