import Random from '@/helpers/random';
import alejoPronounsApi from './alejoPronouns';
import pronounDbApi from './pronounDb';

const cache = new Map<string, { pronouns: string[] | null; expires: number }>();
const pending = new Map<string, Promise<string[] | null>>();

export async function getPronouns(
	platform: 'twitch',
	userId: string,
	username: string,
) {
	if (userId.startsWith('mock_'))
		return Random.boolean() ? Random.item(MOCK_PRONOUNS) : null;
	const key = `${platform}:${userId}`;
	const now = Date.now();
	for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
	const found = cache.get(key);
	if (found) return found.pronouns;
	if (pending.has(key)) return pending.get(key)!;
	if (pending.size >= 64) return null;
	const task = Promise.all([
		alejoPronounsApi.getUser(username).catch(() => null),
		pronounDbApi.getLookup(platform, userId).catch(() => null),
	])
		.then(([alejo, db]) => {
			const pronouns = alejo ?? db ?? null;
			cache.set(key, {
				pronouns,
				expires: Date.now() + (pronouns ? 300_000 : 30_000),
			});
			while (cache.size > 1000) cache.delete(cache.keys().next().value!);
			return pronouns;
		})
		.finally(() => pending.delete(key));
	pending.set(key, task);
	return task;
}

export const MOCK_PRONOUNS = [
	['ae', 'aer'],
	['any'],
	['e', 'em'],
	['fae', 'faer'],
	['he', 'him'],
	['it', 'its'],
	['other'],
	['per', 'per'],
	['she', 'her'],
	['they', 'them'],
	['ve', 'ver'],
	['xe', 'xem'],
	['zie', 'hir'],
	['she', 'they'],
	['they', 'she'],
	['he', 'they'],
	['they', 'he'],
	['she', 'he'],
	['he', 'she'],
];
