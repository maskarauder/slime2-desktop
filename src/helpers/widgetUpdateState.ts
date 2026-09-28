// In-flight widget responses and queued saves must not overwrite a new core.
const updating = new Set<string>();
const generations = new Map<string, number>();
const listeners = new Set<() => void>();

export function anyWidgetUpdating() {
	return updating.size > 0;
}
export function subscribeWidgetUpdates(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function isWidgetUpdating(id: string) {
	return updating.has(id);
}

export function widgetUpdateGeneration(id: string) {
	return generations.get(id) ?? 0;
}

export function beginWidgetUpdate(ids: string[]) {
	if (updating.size)
		throw new Error('Another widget update is still running.');
	for (const id of ids) {
		updating.add(id);
		generations.set(id, widgetUpdateGeneration(id) + 1);
	}
	for (const listener of listeners) listener();
	let finished = false;
	return () => {
		if (finished) return;
		finished = true;
		for (const id of ids) {
			updating.delete(id);
			generations.set(id, widgetUpdateGeneration(id) + 1);
		}
		for (const listener of listeners) listener();
	};
}
