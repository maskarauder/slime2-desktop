import type { AxiosInstance, AxiosRequestConfig } from 'axios';

// Public emote catalogs only: share work between layouts without caching credentials.
export function createCachedJsonGet(client: AxiosInstance) {
	const cache = new Map<
		string,
		{ data?: unknown; failed?: boolean; expires: number }
	>();
	const pending = new Map<string, Promise<{ data: unknown }>>();
	return function get<T>(
		url: string,
		config?: AxiosRequestConfig,
	): Promise<{ data: T }> {
		const key = JSON.stringify([url, config?.params, config?.headers]);
		const now = Date.now();
		for (const [id, entry] of cache)
			if (entry.expires <= now) cache.delete(id);
		const found = cache.get(key);
		if (found)
			return found.failed
				? Promise.reject(
						new Error('Emote catalog temporarily unavailable.'),
					)
				: Promise.resolve({ data: found.data as T });
		const running = pending.get(key);
		if (running) return running as Promise<{ data: T }>;
		if (pending.size >= 32)
			return Promise.reject(new Error('Emote catalog lookup is busy.'));
		const task = client
			.get<T>(url, { ...config, timeout: 5000 })
			.then(
				({ data }) => {
					cache.set(key, { data, expires: Date.now() + 300_000 });
					return { data };
				},
				() => {
					cache.set(key, {
						failed: true,
						expires: Date.now() + 30_000,
					});
					throw new Error('Emote catalog temporarily unavailable.');
				},
			)
			.finally(() => {
				pending.delete(key);
				while (cache.size > 32)
					cache.delete(cache.keys().next().value!);
			});
		pending.set(key, task);
		return task;
	};
}
