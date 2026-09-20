import { resolveWidgetAccounts } from '../accountRouting';
import { lookupTikTokUserId } from '../commands';
import type { Accounts } from '../json/accounts';
import { loadWidgetMeta } from '../json/widgetMeta';
import twitchApi from './twitch/twitchApi';
import youtubeApi from './youtube/youtubeApi';

export type UserPlatform = 'twitch' | 'youtube' | 'tiktok';
export type ResolvedPlatformUser = {
	platform: UserPlatform;
	id: string;
	username: string;
};

class LookupError extends Error {}

const cache = new Map<
	string,
	{
		promise: Promise<ResolvedPlatformUser>;
		expiresAt: number;
		pending: boolean;
	}
>();
const recentLookups: number[] = [];
let pendingLookups = 0;

export function normalizeLookupUsername(platform: UserPlatform, input: string) {
	const username = input
		.trim()
		.replace(/^@/, '')
		.normalize('NFC')
		.toLowerCase();
	const valid =
		platform === 'twitch'
			? /^[a-z0-9_]{1,25}$/.test(username)
			: platform === 'tiktok'
				? /^[a-z0-9_.]{1,32}$/.test(username)
				: /^[\p{L}\p{M}\p{N}_.\-·]{1,100}$/u.test(username);
	if (!valid)
		throw new LookupError(
			`Use a ${platform} username or @handle, without a profile URL or display name.`,
		);
	return username;
}

// Generic widget API: the app resolves accounts; the widget owns its mappings
// and command policy. Nothing here depends on Villager Chat or person IDs.
export async function resolveWidgetPlatformUser(
	widgetId: string,
	accounts: Accounts,
	payload: { account_id: string; platform: UserPlatform; username: string },
): Promise<ResolvedPlatformUser> {
	const { account_id: accountId, platform } = payload;
	const username = normalizeLookupUsername(platform, payload.username);
	const meta = await loadWidgetMeta(widgetId);
	const assigned = resolveWidgetAccounts(widgetId, meta, accounts).some(
		account =>
			account?.id === accountId &&
			account.service === platform &&
			account.type === 'read',
	);
	if (!assigned)
		throw new LookupError(
			`Assign a connected ${platform} read account to this widget before looking up usernames.`,
		);
	return resolvePlatformUser(accountId, platform, username);
}

function resolvePlatformUser(
	accountId: string,
	platform: UserPlatform,
	username: string,
) {
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (!entry.pending && entry.expiresAt <= now) cache.delete(key);
	}
	const key = JSON.stringify([accountId, platform, username]);
	const cached = cache.get(key);
	if (cached) return cached.promise;
	while (recentLookups.length && recentLookups[0]! <= now - 60_000)
		recentLookups.shift();
	if (pendingLookups >= 16 || recentLookups.length >= 60) {
		throw new LookupError(
			'Username lookups are busy. Please retry in one minute.',
		);
	}
	if (cache.size >= 256) {
		for (const [oldKey, entry] of cache) {
			if (!entry.pending) {
				cache.delete(oldKey);
				break;
			}
		}
	}
	recentLookups.push(now);
	pendingLookups += 1;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new LookupError(
					`${platform} username lookup timed out. Please retry.`,
				),
			);
			controller.abort();
		}, 20_000);
	});
	const entry = {
		promise: Promise.resolve({} as ResolvedPlatformUser),
		expiresAt: Infinity,
		pending: true,
	};
	entry.promise = Promise.race([
		lookup(accountId, platform, username, controller.signal),
		deadline,
	])
		.then(
			result => {
				entry.expiresAt = Date.now() + 60_000;
				return result;
			},
			error => {
				// Coalesce failures too: three layouts should not make three failing
				// requests. Only bounded, curated errors reach a widget or the log.
				entry.expiresAt = Date.now() + 5_000;
				throw safeLookupError(platform, error);
			},
		)
		.finally(() => {
			clearTimeout(timer);
			entry.pending = false;
			pendingLookups -= 1;
		});
	cache.set(key, entry);
	return entry.promise;
}

async function lookup(
	accountId: string,
	platform: UserPlatform,
	username: string,
	signal: AbortSignal,
): Promise<ResolvedPlatformUser> {
	let id: string | undefined;
	if (platform === 'twitch') {
		const { data } = await twitchApi.getUserByLogin(
			accountId,
			username,
			signal,
		);
		const matches =
			data.data?.filter(user => user.login.toLowerCase() === username) ??
			[];
		if (matches.length === 1) id = matches[0]?.id;
	} else if (platform === 'youtube') {
		const { data } = await youtubeApi.getChannelByHandle(
			accountId,
			username,
			signal,
		);
		if (data.items?.length === 1) {
			const channel = data.items[0]!;
			const returnedHandle = channel.snippet?.customUrl;
			// forHandle is an exact API lookup. If YouTube also returns a handle,
			// reject a mismatched result instead of using a display-name search.
			if (
				!returnedHandle?.startsWith('@') ||
				normalizeLookupUsername('youtube', returnedHandle) === username
			) {
				id = channel.id;
			}
		}
	} else {
		id = await lookupTikTokUserId(accountId, username);
	}
	const validId =
		typeof id === 'string' &&
		(platform === 'youtube'
			? /^UC[-_a-zA-Z0-9]{22}$/.test(id)
			: /^\d{1,32}$/.test(id));
	if (!validId)
		throw new LookupError(
			`No unique ${platform} account was found for @${username}. Check the username or use a stable user ID.`,
		);
	return { platform, id: id!, username };
}

function safeLookupError(platform: UserPlatform, error: unknown): LookupError {
	if (error instanceof LookupError) return error;
	const nativeCode = typeof error === 'string' ? error : '';
	const httpMatch = /^TIKTOK_LOOKUP_HTTP_(\d{3})$/.exec(nativeCode);
	const status = httpMatch
		? Number(httpMatch[1])
		: (error as { response?: { status?: number } } | null)?.response
				?.status;
	if (status === 401 || nativeCode === 'TIKTOK_LOOKUP_CREDENTIALS') {
		return new LookupError(
			`${platform} lookup credentials are unavailable or expired. Reconnect the assigned account.`,
		);
	}
	if (status === 403) {
		return new LookupError(
			platform === 'tiktok'
				? 'Euler Stream denied the user-ID lookup. Check that your API key has access to this endpoint, or supply the numeric TikTok ID.'
				: `${platform} denied the username lookup. Check API access, consent, and quota.`,
		);
	}
	if (status === 429)
		return new LookupError(
			`${platform} username lookup is rate limited. Please retry later.`,
		);
	if (status === 404 || nativeCode === 'TIKTOK_LOOKUP_NOT_FOUND')
		return new LookupError(
			`The ${platform} username was not found. Check the @handle or use a stable user ID.`,
		);
	return new LookupError(
		`${platform} username lookup failed. Check your connection and API access, then retry. No account links were changed.`,
	);
}
