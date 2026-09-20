import { relatedWidgetIds } from '@/helpers/accountRouting';
import useAccounts from '@/contexts/accounts/useAccounts';
import { useAccountsDispatch } from '@/contexts/accounts/useAccountsDispatch';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import { startTikTokLive, stopTikTokLive } from '@/helpers/commands';
import { type Account } from '@/helpers/json/accounts';
import { sendTikTokEvent } from '@/helpers/widgetMessage';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useEffect, useRef, useState } from 'react';

type TikTokBackendMessage = {
	accountId: string;
	sessionId: string;
	message: string;
};

type TikTokBackendStatus = {
	accountId: string;
	sessionId: string;
	state:
		| 'connecting'
		| 'connected'
		| 'offline'
		| 'reconnecting'
		| 'reauthorize'
		| 'error';
	code?: number;
	message?: string;
};

type TikTokEventEnvelope = {
	type: string;
	data: Record<string, unknown>;
	timestamp?: unknown;
};

type TikTokMessageFragment =
	| { type: 'text'; text: string }
	| {
			type: 'emote';
			text: string;
			emote: { id: string; url: string };
	  };

export default function useTikTokChat() {
	const accounts = useAccounts();
	const widgetMetas = useWidgetMetas();
	const { addAccount: updateAccount } = useAccountsDispatch();
	const accountsRef = useRef(accounts);
	const widgetMetasRef = useRef(widgetMetas);
	const updateAccountRef = useRef(updateAccount);
	const sessions = useRef(new Map<string, string>());
	const operations = useRef(new Map<string, Promise<void>>());
	const [listenersReady, setListenersReady] = useState(false);
	const [retryTick, setRetryTick] = useState(0);
	accountsRef.current = accounts;
	widgetMetasRef.current = widgetMetas;
	updateAccountRef.current = updateAccount;

	// Serialize native mutations; a delayed stop can never cancel a newer reader.
	function enqueue(accountId: string, operation: () => Promise<void>) {
		const task = (operations.current.get(accountId) ?? Promise.resolve())
			.catch(() => {})
			.then(operation)
			.finally(() => {
				if (operations.current.get(accountId) === task)
					operations.current.delete(accountId);
			});
		operations.current.set(accountId, task);
		return task;
	}

	useEffect(() => {
		let disposed = false;
		let unlisteners: VoidFunction[] = [];
		const appWindow = getCurrentWebviewWindow();
		const queue: {
			accountId: string;
			sessionId: string;
			chat: NonNullable<ReturnType<typeof normalizeChatEvent>>;
		}[] = [];
		const seen = new Set<string>();
		let processing = false;
		let lastOverflow = 0;
		async function drain() {
			if (processing) return;
			processing = true;
			try {
				while (!disposed && queue.length) {
					const { accountId, sessionId, chat } = queue.shift()!;
					const account = accountsRef.current[accountId];
					if (
						!account ||
						sessions.current.get(accountId) !== sessionId
					)
						continue;
					try {
						await Promise.all(
							relatedWidgetIds(
								account,
								accountsRef.current,
								widgetMetasRef.current,
							).map(widgetId =>
								sendTikTokEvent(
									account.id,
									widgetId,
									chat.id,
									chat.type,
									chat.timestamp,
									chat.data,
								),
							),
						);
					} catch (error) {
						console.error(
							'Unable to forward TikTok LIVE chat:',
							error,
						);
					}
				}
			} finally {
				processing = false;
			}
		}
		function stop(accountId: string, sessionId: string) {
			sessions.current.delete(accountId);
			void enqueue(accountId, () =>
				stopTikTokLive(accountId, sessionId),
			).catch(error =>
				console.error('Unable to stop TikTok LIVE chat:', error),
			);
		}
		Promise.allSettled([
			appWindow.listen<TikTokBackendMessage>(
				'tiktok-live-message',
				event => {
					const { accountId, sessionId, message } = event.payload;
					if (
						disposed ||
						sessions.current.get(accountId) !== sessionId
					)
						return;
					for (const envelope of parseEulerStreamMessage(message)) {
						const chat = normalizeChatEvent(envelope);
						if (!chat) continue;
						const key = JSON.stringify([accountId, chat.id]);
						if (seen.has(key)) continue;
						seen.add(key);
						while (seen.size > 2000)
							seen.delete(seen.values().next().value!);
						if (queue.length >= 256) {
							queue.shift();
							if (Date.now() - lastOverflow > 60_000) {
								lastOverflow = Date.now();
								console.warn(
									'TikTok display queue reached its limit; dropping the oldest pending message.',
								);
							}
						}
						queue.push({ accountId, sessionId, chat });
					}
					void drain();
				},
			),
			appWindow.listen<TikTokBackendStatus>(
				'tiktok-live-status',
				event => {
					const { accountId, sessionId, state, code, message } =
						event.payload;
					if (
						disposed ||
						sessions.current.get(accountId) !== sessionId
					)
						return;
					const account = accountsRef.current[accountId];
					if (state === 'reauthorize') {
						stop(accountId, sessionId);
						if (account && !account.reauthorize)
							updateAccountRef.current({
								...account,
								reauthorize: true,
							});
						// Preserve the stored key even when it needs user attention.
						console.error(
							`TikTok LIVE credentials need attention for ${account?.displayName ?? accountId}:`,
							message,
						);
					} else if (state === 'error') {
						stop(accountId, sessionId);
						console.error(
							`TikTok LIVE connection stopped${code ? ` (${code})` : ''}:`,
							message,
						);
					} else if (state === 'connected') {
						console.info(
							`TikTok LIVE connected for ${account?.displayName ?? accountId}.`,
						);
					} else if (state === 'reconnecting') {
						console.warn(
							`TikTok LIVE reconnecting${code ? ` (${code})` : ''}:`,
							message,
						);
					} else if (state === 'offline') {
						console.info(
							'TikTok broadcaster is offline; Slime2 will retry automatically.',
						);
					}
				},
			),
		]).then(results => {
			const ready = results.flatMap(result =>
				result.status === 'fulfilled' ? [result.value] : [],
			);
			if (disposed || ready.length !== results.length) {
				ready.forEach(unlisten => unlisten());
				if (!disposed)
					console.error(
						'Unable to register all TikTok LIVE listeners.',
					);
				return;
			}
			unlisteners = ready;
			setListenersReady(true);
		});
		const retry = setInterval(
			() => setRetryTick(value => value + 1),
			300_000,
		);
		return () => {
			disposed = true;
			clearInterval(retry);
			unlisteners.forEach(unlisten => unlisten());
			queue.length = 0;
			seen.clear();
		};
	}, []);

	useEffect(() => {
		if (!listenersReady) return;
		const needed = new Map(
			Object.values(accounts)
				.filter(account =>
					isTikTokAccountNeeded(account, accounts, widgetMetas),
				)
				.map(account => [account.id, account]),
		);
		for (const [accountId, sessionId] of sessions.current) {
			if (needed.has(accountId)) continue;
			sessions.current.delete(accountId);
			void enqueue(accountId, () =>
				stopTikTokLive(accountId, sessionId),
			).catch(error =>
				console.error('Unable to stop TikTok LIVE chat:', error),
			);
		}
		for (const [accountId, account] of needed) {
			if (sessions.current.has(accountId)) continue;
			const sessionId = crypto.randomUUID();
			sessions.current.set(accountId, sessionId);
			void enqueue(accountId, async () => {
				if (sessions.current.get(accountId) !== sessionId) return;
				await startTikTokLive(accountId, account.serviceId, sessionId);
			}).catch(error => {
				if (sessions.current.get(accountId) !== sessionId) return;
				sessions.current.delete(accountId);
				console.error(
					'Unable to start TikTok LIVE chat; retrying in 5 minutes:',
					error,
				);
			});
		}
	}, [accounts, listenersReady, widgetMetas, retryTick]);

	useEffect(
		() => () => {
			for (const [accountId, sessionId] of sessions.current) {
				void enqueue(accountId, () =>
					stopTikTokLive(accountId, sessionId),
				).catch(error =>
					console.error('Unable to stop TikTok LIVE chat:', error),
				);
			}
			sessions.current.clear();
		},
		[],
	);
}

function isTikTokAccountNeeded(
	account: Account,
	accounts: ReturnType<typeof useAccounts>,
	widgetMetas: ReturnType<typeof useWidgetMetas>,
) {
	return (
		!account.reauthorize &&
		account.service === 'tiktok' &&
		account.type === 'read' &&
		relatedWidgetIds(account, accounts, widgetMetas).length > 0
	);
}

function parseEulerStreamMessage(message: string): TikTokEventEnvelope[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(message);
	} catch (error) {
		console.error('Euler Stream returned invalid JSON:', error);
		return [];
	}

	const bundleTimestamp = isRecord(parsed) ? parsed.timestamp : undefined;
	const rawEvents =
		isRecord(parsed) && Array.isArray(parsed.messages)
			? parsed.messages
			: Array.isArray(parsed)
				? parsed
				: [parsed];

	return rawEvents.flatMap(rawEvent => {
		if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string') return [];

		let data: unknown = rawEvent.data;
		if (typeof data === 'string') {
			try {
				data = JSON.parse(data);
			} catch {
				return [];
			}
		}
		if (!isRecord(data)) return [];

		return [
			{
				type: rawEvent.type,
				data,
				timestamp: rawEvent.timestamp ?? bundleTimestamp,
			},
		];
	});
}

function normalizeChatEvent(envelope: TikTokEventEnvelope) {
	if (envelope.type !== 'WebcastChatMessage') return null;

	const { data } = envelope;
	const comment = typeof data.comment === 'string' ? data.comment : '';
	const user = isRecord(data.user) ? data.user : {};
	const common = isRecord(data.common) ? data.common : {};
	const username = firstString(user, ['uniqueId', 'displayId', 'nickname']);
	const displayName = firstString(user, [
		'nickname',
		'displayId',
		'uniqueId',
	]);
	const userId = firstString(user, ['userId', 'idStr', 'secUid', 'uniqueId']);

	if (!comment && (!Array.isArray(data.emotes) || data.emotes.length === 0))
		return null;
	if (!username || !displayName || !userId) return null;

	const timestamp = normalizeTimestamp(
		common.createTime ?? envelope.timestamp,
	);
	const messageId =
		firstString(common, ['msgId', 'logId']) ?? crypto.randomUUID();

	return {
		id: messageId,
		type: envelope.type,
		timestamp,
		data: {
			message: {
				text: comment,
				fragments: buildTikTokFragments(comment, data.emotes),
			},
			chatter_user_name: displayName,
			chatter_user_login: username,
			chatter_user_id: userId,
			message_id: messageId,
			color: null,
			badges: [],
			message_type: 'chat',
		},
	};
}

function buildTikTokFragments(
	comment: string,
	rawEmotes: unknown,
): TikTokMessageFragment[] {
	if (!Array.isArray(rawEmotes) || rawEmotes.length === 0) {
		return [{ type: 'text', text: comment }];
	}

	const commentCharacters = Array.from(comment);
	const emotes = rawEmotes
		.flatMap(rawEmote => {
			if (!isRecord(rawEmote)) return [];

			const emote = isRecord(rawEmote.emote) ? rawEmote.emote : rawEmote;
			const image = isRecord(emote.image) ? emote.image : {};
			const id = firstString(emote, ['emoteId', 'id']);
			const url =
				firstString(image, ['imageUrl']) ??
				firstString(rawEmote, ['emoteImageUrl']);
			const numericPosition = Number(rawEmote.placeInComment);

			if (!id || !url) return [];
			return [
				{
					id,
					url,
					position: Number.isFinite(numericPosition)
						? Math.max(0, Math.floor(numericPosition))
						: commentCharacters.length,
				},
			];
		})
		.sort((first, second) => first.position - second.position);

	if (emotes.length === 0) return [{ type: 'text', text: comment }];

	const fragments: TikTokMessageFragment[] = [];
	let cursor = 0;
	for (const emote of emotes) {
		const position = Math.max(
			cursor,
			Math.min(commentCharacters.length, emote.position),
		);
		if (position > cursor) {
			fragments.push({
				type: 'text',
				text: commentCharacters.slice(cursor, position).join(''),
			});
		}
		fragments.push({
			type: 'emote',
			text: `:${emote.id}:`,
			emote: { id: emote.id, url: emote.url },
		});

		cursor = position;
		if (
			commentCharacters[cursor] === '\uFFFC' ||
			commentCharacters[cursor] === '\uFFFD'
		) {
			cursor += 1;
		}
	}

	if (cursor < commentCharacters.length) {
		fragments.push({
			type: 'text',
			text: commentCharacters.slice(cursor).join(''),
		});
	}

	return fragments;
}

function normalizeTimestamp(value: unknown) {
	if (typeof value === 'number' || typeof value === 'string') {
		const numericValue = Number(value);
		if (Number.isFinite(numericValue) && numericValue > 0) {
			const milliseconds =
				numericValue < 1_000_000_000_000
					? numericValue * 1000
					: numericValue;
			return new Date(milliseconds).toISOString();
		}

		const date = new Date(value);
		if (!Number.isNaN(date.valueOf())) return date.toISOString();
	}

	return new Date().toISOString();
}

function firstString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value) return value;
		if (typeof value === 'number') return String(value);
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
