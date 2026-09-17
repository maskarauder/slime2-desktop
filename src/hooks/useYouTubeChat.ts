import useAccounts from '@/contexts/accounts/useAccounts';
import { useAccountsDispatch } from '@/contexts/accounts/useAccountsDispatch';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import { deleteTokens, type Account } from '@/helpers/json/accounts';
import youtubeApi from '@/helpers/services/youtube/youtubeApi';
import { YouTubeReauthorizationError } from '@/helpers/services/youtube/youtubeAuth';
import { getYouTubeErrorDetails } from '@/helpers/services/youtube/youtubeError';
import type { YouTubeLiveChatMessage } from '@/helpers/services/youtube/youtubeTypes';
import { sendYouTubeEvent } from '@/helpers/widgetMessage';
import axios from 'axios';
import { useEffect, useRef } from 'react';

const BROADCAST_RETRY_DELAY = 60 * 1000;
const ERROR_RETRY_DELAY = 15 * 1000;
const DEFAULT_POLLING_INTERVAL = 5 * 1000;
const MAX_SEEN_MESSAGE_IDS = 5_000;

type YouTubeSession = {
	abortController: AbortController;
	seenMessageIds: Set<string>;
	activeBroadcastId?: string;
	waitingForBroadcastLogged: boolean;
};

export default function useYouTubeChat() {
	const accounts = useAccounts();
	const widgetMetas = useWidgetMetas();
	const { addAccount: updateAccount } = useAccountsDispatch();
	const accountsRef = useRef(accounts);
	const widgetMetasRef = useRef(widgetMetas);
	const sessions = useRef(new Map<string, YouTubeSession>());

	async function dispatchMessage(
		accountId: string,
		message: YouTubeLiveChatMessage,
	) {
		const account = accountsRef.current[accountId];
		if (!account) return;

		const widgetIds = relatedWidgetIds(account, widgetMetasRef.current);
		await Promise.all(
			widgetIds.map(widgetId =>
				sendYouTubeEvent(
					accountId,
					widgetId,
					message.id,
					message.snippet.type,
					message.snippet.publishedAt,
					message,
				),
			),
		);
	}

	async function markForReauthorization(accountId: string) {
		const account = accountsRef.current[accountId];
		if (!account) return;

		updateAccount({ ...account, reauthorize: true });
		try {
			await deleteTokens(account.id);
		} catch (error) {
			console.error(error);
		}
	}

	async function consumeYouTubeChat(
		accountId: string,
		session: YouTubeSession,
	) {
		const { signal } = session.abortController;

		while (!signal.aborted) {
			try {
				const broadcastResponse = await youtubeApi.getActiveBroadcast(
					accountId,
					signal,
				);
				const broadcast = broadcastResponse.data.items?.find(
					broadcast =>
						broadcast.status?.lifeCycleStatus === 'live' &&
						Boolean(broadcast.snippet.liveChatId),
				);
				const liveChatId = broadcast?.snippet.liveChatId;

				if (!liveChatId) {
					if (!session.waitingForBroadcastLogged) {
						console.info(
							`No active YouTube broadcast with live chat was found for ${accountsRef.current[accountId]?.displayName ?? accountId}. Retrying in one minute.`,
						);
						session.waitingForBroadcastLogged = true;
					}
					await abortableDelay(BROADCAST_RETRY_DELAY, signal);
					continue;
				}

				session.waitingForBroadcastLogged = false;
				if (session.activeBroadcastId !== broadcast.id) {
					session.activeBroadcastId = broadcast.id;
					session.seenMessageIds.clear();
					console.info(
						`Reading YouTube chat for ${accountsRef.current[accountId]?.displayName ?? accountId}:`,
						broadcast.snippet.title,
					);
				}
				let pageToken: string | undefined;

				while (!signal.aborted) {
					const response = await youtubeApi.getLiveChatMessages(
						accountId,
						liveChatId,
						pageToken,
						signal,
					);
					const {
						items = [],
						nextPageToken,
						offlineAt,
					} = response.data;
					pageToken = nextPageToken;

					for (const message of items) {
						if (
							!message.id ||
							!rememberMessage(session, message.id)
						)
							continue;
						await dispatchMessage(accountId, message);
					}

					if (offlineAt) break;

					await abortableDelay(
						Math.max(
							response.data.pollingIntervalMillis ??
								DEFAULT_POLLING_INTERVAL,
							1000,
						),
						signal,
					);
				}

				await abortableDelay(BROADCAST_RETRY_DELAY, signal);
			} catch (error) {
				if (signal.aborted || axios.isCancel(error)) return;

				if (
					error instanceof YouTubeReauthorizationError ||
					(axios.isAxiosError(error) &&
						error.response?.status === 401)
				) {
					await markForReauthorization(accountId);
					return;
				}

				console.error(
					'YouTube live chat connection error:',
					getYouTubeErrorDetails(error),
				);
				await abortableDelay(retryDelayFor(error), signal);
			}
		}
	}

	useEffect(() => {
		accountsRef.current = accounts;
	}, [accounts]);

	useEffect(() => {
		widgetMetasRef.current = widgetMetas;
	}, [widgetMetas]);

	useEffect(() => {
		const neededAccounts = new Set(
			Object.values(accounts)
				.filter(account => isYouTubeAccountNeeded(account, widgetMetas))
				.map(account => account.id),
		);

		for (const [accountId, session] of sessions.current) {
			if (!neededAccounts.has(accountId)) {
				session.abortController.abort();
				sessions.current.delete(accountId);
			}
		}

		for (const accountId of neededAccounts) {
			if (sessions.current.has(accountId)) continue;

			const session: YouTubeSession = {
				abortController: new AbortController(),
				seenMessageIds: new Set(),
				waitingForBroadcastLogged: false,
			};
			sessions.current.set(accountId, session);
			consumeYouTubeChat(accountId, session).finally(() => {
				if (sessions.current.get(accountId) === session) {
					sessions.current.delete(accountId);
				}
			});
		}
		// consumeYouTubeChat reads changing data through refs; restarting on its
		// function identity would tear down every active polling session.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [accounts, widgetMetas]);

	useEffect(() => {
		const activeSessions = sessions.current;
		return () => {
			for (const session of activeSessions.values()) {
				session.abortController.abort();
			}
			activeSessions.clear();
		};
	}, []);
}

function isYouTubeAccountNeeded(
	account: Account,
	widgetMetas: ReturnType<typeof useWidgetMetas>,
) {
	return (
		!account.reauthorize &&
		account.service === 'youtube' &&
		account.type === 'read' &&
		relatedWidgetIds(account, widgetMetas).length > 0
	);
}

function relatedWidgetIds(
	account: Account,
	widgetMetas: ReturnType<typeof useWidgetMetas>,
) {
	return Object.entries(widgetMetas)
		.filter(([widgetId, widgetMeta]) =>
			widgetMeta.accounts.some(
				(slot, index) =>
					slot.service === 'youtube' &&
					slot.type === 'read' &&
					(account.widgets[widgetId] === index || account.default),
			),
		)
		.map(([widgetId]) => widgetId);
}

function retryDelayFor(error: unknown) {
	if (axios.isAxiosError(error)) {
		const reason = error.response?.data?.error?.errors?.[0]?.reason;
		const status = error.response?.status;
		if (
			(status !== undefined && status >= 400 && status < 500) ||
			reason === 'liveChatEnded' ||
			reason === 'liveChatNotFound'
		) {
			return BROADCAST_RETRY_DELAY;
		}
	}

	return ERROR_RETRY_DELAY;
}

function rememberMessage(session: YouTubeSession, messageId: string) {
	if (session.seenMessageIds.has(messageId)) return false;

	session.seenMessageIds.add(messageId);
	if (session.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
		const oldestMessageId = session.seenMessageIds.values().next().value;
		if (oldestMessageId !== undefined) {
			session.seenMessageIds.delete(oldestMessageId);
		}
	}

	return true;
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
	return new Promise<void>(resolve => {
		if (signal.aborted) {
			resolve();
			return;
		}

		const timeoutId = window.setTimeout(resolve, milliseconds);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timeoutId);
				resolve();
			},
			{ once: true },
		);
	});
}
