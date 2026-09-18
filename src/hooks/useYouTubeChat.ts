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
	activeLiveChatId?: string;
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
		let liveChatId: string | undefined;
		let pageToken: string | undefined;
		let pollingInterval = DEFAULT_POLLING_INTERVAL;
		let consecutiveFailures = 0;
		let lastHealthLog = Date.now();
		let receivedSinceHealthLog = 0;
		const accountName = () =>
			accountsRef.current[accountId]?.displayName ?? accountId;

		while (!signal.aborted) {
			try {
				if (!liveChatId) {
					const broadcastResponse =
						await youtubeApi.getActiveBroadcast(accountId, signal);
					if (signal.aborted) return;
					const broadcast = broadcastResponse.data.items?.find(
						broadcast =>
							broadcast.status?.lifeCycleStatus === 'live' &&
							Boolean(broadcast.snippet.liveChatId),
					);
					if (!broadcast?.snippet.liveChatId) {
						if (
							!session.waitingForBroadcastLogged ||
							consecutiveFailures > 0
						) {
							console.info(
								`YouTube broadcast lookup succeeded for ${accountName()}; no active live chat. Retrying in one minute.`,
							);
							session.waitingForBroadcastLogged = true;
						}
						consecutiveFailures = 0;
						await abortableDelay(BROADCAST_RETRY_DELAY, signal);
						continue;
					}
					liveChatId = broadcast.snippet.liveChatId;
					session.waitingForBroadcastLogged = false;
					if (
						session.activeBroadcastId !== broadcast.id ||
						session.activeLiveChatId !==
							broadcast.snippet.liveChatId
					) {
						session.activeBroadcastId = broadcast.id;
						session.activeLiveChatId = broadcast.snippet.liveChatId;
						session.seenMessageIds.clear();
					}
					console.info(
						`Reading YouTube chat for ${accountName()}:`,
						broadcast.snippet.title,
					);
				}

				const response = await youtubeApi.getLiveChatMessages(
					accountId,
					liveChatId,
					pageToken,
					signal,
				);
				if (signal.aborted) return;
				const { items = [], nextPageToken, offlineAt } = response.data;
				pollingInterval = Math.max(
					response.data.pollingIntervalMillis ??
						DEFAULT_POLLING_INTERVAL,
					1000,
				);
				for (const message of items) {
					if (signal.aborted) return;
					if (!message.id || session.seenMessageIds.has(message.id))
						continue;
					await dispatchMessage(accountId, message);
					rememberMessage(session, message.id);
					receivedSinceHealthLog += 1;
				}
				// Advance only after dispatch. A transient failure retries the same
				// page, skipping messages already forwarded successfully.
				pageToken = nextPageToken;
				if (consecutiveFailures > 0) {
					console.info(
						`YouTube chat polling recovered for ${accountName()} after ${consecutiveFailures} failed attempt(s).`,
					);
					consecutiveFailures = 0;
				}
				if (Date.now() - lastHealthLog >= 5 * 60 * 1000) {
					console.info(
						`YouTube chat polling healthy for ${accountName()}; ${receivedSinceHealthLog} new message(s) since the last status. Next poll in ${pollingInterval}ms.`,
					);
					lastHealthLog = Date.now();
					receivedSinceHealthLog = 0;
				}
				if (offlineAt) {
					console.info(
						`YouTube broadcast ended for ${accountName()}; looking for another live chat in one minute.`,
					);
					liveChatId = undefined;
					pageToken = undefined;
					pollingInterval = DEFAULT_POLLING_INTERVAL;
					await abortableDelay(BROADCAST_RETRY_DELAY, signal);
				} else {
					// Empty pages are healthy idle polls. Never disconnect because
					// viewers have stopped sending messages.
					await abortableDelay(pollingInterval, signal);
				}
			} catch (error) {
				if (signal.aborted) return;
				if (
					error instanceof YouTubeReauthorizationError ||
					(axios.isAxiosError(error) &&
						error.response?.status === 401)
				) {
					console.error(
						`YouTube account needs reconnecting for ${accountName()}:`,
						getYouTubeErrorDetails(error),
					);
					await markForReauthorization(accountId);
					return;
				}

				const details = getYouTubeErrorDetails(error);
				if (
					[
						'liveChatEnded',
						'liveChatNotFound',
						'liveChatDisabled',
					].includes(details.reason ?? '')
				) {
					liveChatId = undefined;
					pageToken = undefined;
					pollingInterval = DEFAULT_POLLING_INTERVAL;
				} else if (details.reason === 'invalidPageToken') {
					pageToken = undefined;
				}
				consecutiveFailures += 1;
				const delay = Math.max(
					pollingInterval,
					retryDelayFor(error, consecutiveFailures),
				);
				console.warn(
					`YouTube chat retry for ${accountName()} in ${Math.ceil(delay / 1000)}s:`,
					details,
				);
				// Only a failed transport attempt may wake early on network recovery;
				// successful polling still honors Google's pollingIntervalMillis.
				await abortableDelay(
					delay,
					signal,
					details.status === undefined,
				);
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
			consumeYouTubeChat(accountId, session)
				.finally(() => {
					if (sessions.current.get(accountId) === session) {
						sessions.current.delete(accountId);
					}
				})
				.catch(error => {
					console.error(
						`YouTube chat session stopped unexpectedly for ${accountId}:`,
						error,
					);
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

function retryDelayFor(error: unknown, failures: number) {
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

	return Math.min(
		ERROR_RETRY_DELAY * 2 ** Math.min(failures - 1, 2),
		BROADCAST_RETRY_DELAY,
	);
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

function abortableDelay(
	milliseconds: number,
	signal: AbortSignal,
	wakeOnOnline = false,
) {
	return new Promise<void>(resolve => {
		if (signal.aborted) {
			resolve();
			return;
		}
		function finish() {
			clearTimeout(timeoutId);
			signal.removeEventListener('abort', finish);
			if (wakeOnOnline) window.removeEventListener('online', finish);
			resolve();
		}
		const timeoutId = window.setTimeout(finish, milliseconds);
		signal.addEventListener('abort', finish, { once: true });
		if (wakeOnOnline)
			window.addEventListener('online', finish, { once: true });
	});
}
