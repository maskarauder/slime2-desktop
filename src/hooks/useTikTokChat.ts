import useAccounts from '@/contexts/accounts/useAccounts';
import { useAccountsDispatch } from '@/contexts/accounts/useAccountsDispatch';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import { startTikTokLive, stopTikTokLive } from '@/helpers/commands';
import { deleteTokens, type Account } from '@/helpers/json/accounts';
import { sendTikTokEvent } from '@/helpers/widgetMessage';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useEffect, useRef, useState } from 'react';

type TikTokBackendMessage = {
	accountId: string;
	message: string;
};

type TikTokBackendStatus = {
	accountId: string;
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
	const sessions = useRef(new Set<string>());
	const [listenersReady, setListenersReady] = useState(false);

	useEffect(() => {
		accountsRef.current = accounts;
	}, [accounts]);

	useEffect(() => {
		widgetMetasRef.current = widgetMetas;
	}, [widgetMetas]);

	useEffect(() => {
		updateAccountRef.current = updateAccount;
	}, [updateAccount]);

	useEffect(() => {
		let disposed = false;
		let unlistenMessage: VoidFunction | undefined;
		let unlistenStatus: VoidFunction | undefined;
		const appWindow = getCurrentWebviewWindow();

		async function markForReauthorization(
			accountId: string,
			message?: string,
		) {
			const account = accountsRef.current[accountId];
			if (!account || account.reauthorize) return;

			console.error(
				`TikTok LIVE credentials need attention for ${account.displayName}:`,
				message ?? 'Euler Stream rejected the connection.',
			);
			sessions.current.delete(accountId);
			updateAccountRef.current({ ...account, reauthorize: true });

			try {
				await deleteTokens(accountId);
			} catch (error) {
				console.error(error);
			}
		}

		Promise.all([
			appWindow.listen<TikTokBackendMessage>(
				'tiktok-live-message',
				event => {
					if (!sessions.current.has(event.payload.accountId)) return;

					const account =
						accountsRef.current[event.payload.accountId];
					if (!account) return;

					for (const envelope of parseEulerStreamMessage(
						event.payload.message,
					)) {
						const chatEvent = normalizeChatEvent(envelope);
						if (!chatEvent) continue;

						const widgetIds = relatedWidgetIds(
							account,
							accountsRef.current,
							widgetMetasRef.current,
						);
						void Promise.all(
							widgetIds.map(widgetId =>
								sendTikTokEvent(
									account.id,
									widgetId,
									chatEvent.id,
									chatEvent.type,
									chatEvent.timestamp,
									chatEvent.data,
								),
							),
						).catch(error => {
							console.error(
								'Unable to forward TikTok LIVE chat:',
								error,
							);
						});
					}
				},
			),
			appWindow.listen<TikTokBackendStatus>(
				'tiktok-live-status',
				event => {
					const { accountId, state, code, message } = event.payload;
					if (!sessions.current.has(accountId)) return;

					if (state === 'reauthorize') {
						void markForReauthorization(accountId, message);
						return;
					}

					if (state === 'connected') {
						console.info(
							`TikTok LIVE connected for ${accountsRef.current[accountId]?.displayName ?? accountId}.`,
						);
					} else if (state === 'reconnecting') {
						console.warn(
							`TikTok LIVE reconnecting${code ? ` (${code})` : ''}:`,
							message ??
								'Connection closed; retrying in 15 seconds.',
						);
					} else if (state === 'error') {
						console.error(
							`TikTok LIVE connection stopped${code ? ` (${code})` : ''}:`,
							message ?? 'Unknown connection error.',
						);
					} else if (state === 'offline') {
						console.info(
							'TikTok broadcaster is offline; Slime2 will retry automatically.',
						);
					}
				},
			),
		])
			.then(unlistenFunctions => {
				if (disposed) {
					unlistenFunctions.forEach(unlisten => {
						unlisten();
					});
					return;
				}

				[unlistenMessage, unlistenStatus] = unlistenFunctions;
				setListenersReady(true);
			})
			.catch(error => {
				console.error(
					'Unable to listen for TikTok LIVE events:',
					error,
				);
			});

		return () => {
			disposed = true;
			unlistenMessage?.();
			unlistenStatus?.();
		};
	}, []);

	useEffect(() => {
		if (!listenersReady) return;

		const neededAccounts = new Map(
			Object.values(accounts)
				.filter(account =>
					isTikTokAccountNeeded(account, accounts, widgetMetas),
				)
				.map(account => [account.id, account]),
		);

		for (const accountId of sessions.current) {
			if (neededAccounts.has(accountId)) continue;

			sessions.current.delete(accountId);
			void stopTikTokLive(accountId).catch(error => {
				console.error('Unable to stop TikTok LIVE chat:', error);
			});
		}

		for (const [accountId, account] of neededAccounts) {
			if (sessions.current.has(accountId)) continue;

			sessions.current.add(accountId);
			void startTikTokLive(accountId, account.serviceId).catch(
				async error => {
					if (!sessions.current.delete(accountId)) return;

					console.error('Unable to start TikTok LIVE chat:', error);
					const currentAccount = accountsRef.current[accountId];
					if (!currentAccount || currentAccount.reauthorize) return;

					updateAccountRef.current({
						...currentAccount,
						reauthorize: true,
					});
					try {
						await deleteTokens(accountId);
					} catch (deleteError) {
						console.error(deleteError);
					}
				},
			);
		}
	}, [accounts, listenersReady, widgetMetas]);

	useEffect(() => {
		const activeSessions = sessions.current;
		return () => {
			for (const accountId of activeSessions) {
				void stopTikTokLive(accountId);
			}
			activeSessions.clear();
		};
	}, []);
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

function relatedWidgetIds(
	account: Account,
	accounts: ReturnType<typeof useAccounts>,
	widgetMetas: ReturnType<typeof useWidgetMetas>,
) {
	return Object.entries(widgetMetas)
		.filter(([widgetId, widgetMeta]) =>
			widgetMeta.accounts.some((slot, index) => {
				if (slot.service !== 'tiktok' || slot.type !== 'read') {
					return false;
				}

				const manuallySelectedAccount = Object.values(accounts).find(
					otherAccount =>
						!otherAccount.reauthorize &&
						otherAccount.service === 'tiktok' &&
						otherAccount.type === 'read' &&
						otherAccount.widgets[widgetId] === index,
				);

				return manuallySelectedAccount
					? manuallySelectedAccount.id === account.id
					: account.default;
			}),
		)
		.map(([widgetId]) => widgetId);
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
