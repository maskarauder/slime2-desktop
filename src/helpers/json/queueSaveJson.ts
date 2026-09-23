import { saveJsonAtomic } from '../commands';
const pending = new Map<string, unknown>(),
	running = new Map<string, Promise<void>>(),
	timers = new Map<string, ReturnType<typeof setTimeout>>();
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
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	while (pending.size || running.size)
		await Promise.all(
			[...new Set([...pending.keys(), ...running.keys()])].map(drain),
		);
}
