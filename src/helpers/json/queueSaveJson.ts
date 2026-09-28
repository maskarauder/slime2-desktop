import { saveJsonAtomic } from '../commands';
const pending = new Map<string, unknown>(),
	running = new Map<string, Promise<void>>(),
	timers = new Map<string, ReturnType<typeof setTimeout>>();
const paused = new Set<string>();
const preparing = new Set<Promise<void>>();

export function queueSaveJsonAfterPath(
	value: unknown,
	path: Promise<string>,
): Promise<void> {
	const snapshot = structuredClone(value);
	const task = path.then(resolved => {
		queueSaveJson(snapshot, resolved);
	});
	preparing.add(task);
	void task.then(
		() => preparing.delete(task),
		() => preparing.delete(task),
	);
	return task;
}
async function settlePreparations() {
	while (preparing.size) await Promise.all([...preparing]);
}
export function queueSaveJson(value: unknown, path: string) {
	pending.set(path, structuredClone(value));
	if (!timers.has(path)) {
		void drain(path).catch(error =>
			console.error('Unable to save configuration:', error),
		);
		timers.set(
			path,
			setTimeout(() => {
				timers.delete(path);
				void drain(path).catch(error =>
					console.error('Unable to save configuration:', error),
				);
			}, 3000),
		);
	}
}
async function drain(path: string): Promise<void> {
	while (running.has(path)) await running.get(path)?.catch(() => {});
	if (paused.has(path)) return;
	if (!pending.has(path)) return;
	const value = pending.get(path);
	pending.delete(path);
	const task = saveJsonAtomic(value, path);
	running.set(path, task);
	try {
		await task;
	} catch (error) {
		if (!pending.has(path)) pending.set(path, value);
		throw error;
	} finally {
		if (running.get(path) === task) running.delete(path);
	}
}
export async function flushQueuedSaves() {
	await settlePreparations();
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	while (
		[...pending.keys(), ...running.keys()].some(path => !paused.has(path))
	)
		await Promise.all(
			[...new Set([...pending.keys(), ...running.keys()])]
				.filter(path => !paused.has(path))
				.map(drain),
		);
}

/** Flush first, then hold these paths while native code swaps core/config files. */
export function pauseQueuedSaves(paths: string[]) {
	if (paths.some(path => paused.has(path) || running.has(path)))
		throw new Error(
			'Configuration saves are still in progress. Please retry.',
		);
	for (const path of paths) {
		paused.add(path);
		clearTimeout(timers.get(path));
		timers.delete(path);
	}
	let released = false;
	return async (reconcile?: (path: string, value: unknown) => unknown) => {
		if (released) return;
		released = true;
		try {
			await settlePreparations();
			for (const path of paths) {
				if (reconcile && pending.has(path))
					pending.set(path, reconcile(path, pending.get(path)));
			}
		} finally {
			for (const path of paths) paused.delete(path);
		}
		await Promise.all(paths.map(drain));
	};
}
