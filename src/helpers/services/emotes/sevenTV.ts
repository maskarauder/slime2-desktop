import axios from 'axios';
import { createSevenTvLive } from './sevenTvLive';
import type { RawEmote, RawSet, RawUser, SevenTvEmote } from './sevenTvLive';
export type {
	SevenTvAccount,
	SevenTvEmote,
	SevenTvPlatform,
	SevenTvUpdate,
} from './sevenTvLive';

const sevenTvAxios = axios.create({
	baseURL: 'https://7tv.io/v3',
	timeout: 5000,
});
// Bypass the shared five-minute request cache: EventAPI and reconciliation need
// current catalogs. Deduplicate concurrent HTTP requests without caching errors.
const pending = new Map<
	string,
	{ promise: Promise<unknown>; signal: AbortSignal }
>();
function get<T>(
	path: string,
	signal: AbortSignal,
	missingSetAware = false,
): Promise<T | null> {
	const existing = pending.get(path);
	if (existing && !existing.signal.aborted)
		return existing.promise as Promise<T | null>;
	if (existing) pending.delete(path);
	if (pending.size >= 128)
		return Promise.reject(new Error('7TV lookup is busy.'));
	const task = sevenTvAxios
		.get<T>(path, {
			signal,
			...(missingSetAware
				? { headers: { 'X-7tv-Missing-EmoteSet-Aware': '1' } }
				: {}),
		})
		.then(response => response.data)
		.catch((error: unknown) => {
			if (axios.isAxiosError(error) && error.response?.status === 404)
				return null;
			throw new Error('7TV catalog temporarily unavailable.');
		})
		.finally(() => {
			if (pending.get(path)?.promise === task) pending.delete(path);
		});
	pending.set(path, { promise: task, signal });
	return task;
}

export function normalizeSevenTvEmote(emote: RawEmote): SevenTvEmote {
	const host = emote.data?.host;
	const files = Array.isArray(host?.files) ? host.files : [];
	let largestWebp: (typeof files)[number] | undefined;
	for (const file of files) {
		if (
			typeof file?.format !== 'string' ||
			file.format.toUpperCase() !== 'WEBP'
		)
			continue;
		if (!largestWebp || file.width > largestWebp.width) largestWebp = file;
	}
	const baseUrl =
		typeof host?.url === 'string' && host.url
			? `${host.url.startsWith('//') ? 'https:' : ''}${host.url}`.replace(
					/\/$/,
					'',
				)
			: `https://cdn.7tv.app/emote/${emote.id}`;
	const animatedFilename = largestWebp?.name ?? '4x.webp';
	const staticFilename =
		largestWebp?.static_name ??
		(emote.data?.animated ? '4x_static.webp' : animatedFilename);
	return {
		id: emote.id,
		name: emote.name,
		srcAnimated: `${baseUrl}/${animatedFilename}`,
		srcStatic: `${baseUrl}/${staticFilename}`,
	};
}

const sevenTvApi = createSevenTvLive({
	loadSet: (id, signal) =>
		get<RawSet>(`/emote-sets/${encodeURIComponent(id)}`, signal),
	loadUser: (platform, userId, signal) =>
		get<RawUser>(
			`/users/${platform === 'youtube' ? 'google' : platform}/${encodeURIComponent(userId)}`,
			signal,
			true,
		),
	normalize: normalizeSevenTvEmote,
	connect: url => new WebSocket(url),
});
export default sevenTvApi;
