export type ConnectionUpdate = {
	state:
		| 'connecting'
		| 'connected'
		| 'waiting'
		| 'reconnecting'
		| 'paused'
		| 'reauthorize'
		| 'error';
	detail?: string;
	retryAt?: number;
	transport?: 'websocket' | 'grpc' | 'rest';
};
let snapshot: Record<string, ConnectionUpdate> = {};
const owners = new Map<string, symbol>();
const listeners = new Set<() => void>();
const reconnectListeners = new Set<(id: string) => void>();
const lastReconnect = new Map<string, number>();
export const getConnections = () => snapshot;
export function subscribeConnections(callback: () => void) {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}
function publish() {
	listeners.forEach(callback => callback());
}
export function beginConnection(id: string) {
	const owner = Symbol(id);
	owners.set(id, owner);
	function update(status: ConnectionUpdate) {
		if (owners.get(id) !== owner) return;
		snapshot = { ...snapshot, [id]: status };
		publish();
	}
	update({ state: 'connecting' });
	return {
		update,
		dispose() {
			if (owners.get(id) !== owner) return;
			owners.delete(id);
			const next = { ...snapshot };
			delete next[id];
			snapshot = next;
			publish();
		},
	};
}
export function subscribeReconnect(callback: (id: string) => void) {
	reconnectListeners.add(callback);
	return () => {
		reconnectListeners.delete(callback);
	};
}
export function reconnectNow(id: string) {
	if (!snapshot[id] || Date.now() - (lastReconnect.get(id) ?? 0) < 2000)
		return;
	lastReconnect.set(id, Date.now());
	while (lastReconnect.size > 1000)
		lastReconnect.delete(lastReconnect.keys().next().value!);
	snapshot = { ...snapshot, [id]: { state: 'connecting' } };
	publish();
	reconnectListeners.forEach(callback => callback(id));
}
