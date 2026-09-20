import { relatedWidgetIds } from '@/helpers/accountRouting';
import useAccounts from '@/contexts/accounts/useAccounts';
import { useAccountsDispatch } from '@/contexts/accounts/useAccountsDispatch';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import { deleteTokens, type Account } from '@/helpers/json/accounts';
import { YouTubeReauthorizationError } from '@/helpers/services/youtube/youtubeAuth';
import { readYouTubeChat } from '@/helpers/services/youtube/youtubeChatReader';
import { getYouTubeErrorDetails } from '@/helpers/services/youtube/youtubeError';
import type { YouTubeLiveChatMessage } from '@/helpers/services/youtube/youtubeTypes';
import { sendYouTubeEvent } from '@/helpers/widgetMessage';
import { useEffect, useRef } from 'react';

type YouTubeSession = {
	abortController: AbortController;
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

		const widgetIds = relatedWidgetIds(
			account,
			accountsRef.current,
			widgetMetasRef.current,
		);
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
		try {
			await readYouTubeChat({
				accountId,
				signal: session.abortController.signal,
				accountName: () =>
					accountsRef.current[accountId]?.displayName ?? accountId,
				onMessage: message => dispatchMessage(accountId, message),
			});
		} catch (error) {
			if (session.abortController.signal.aborted) return;
			const details = getYouTubeErrorDetails(error);
			console.error(`YouTube chat stopped for ${accountId}:`, details);
			if (
				error instanceof YouTubeReauthorizationError ||
				details.status === 401
			) {
				await markForReauthorization(accountId);
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
				.filter(account =>
					isYouTubeAccountNeeded(account, accounts, widgetMetas),
				)
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
						getYouTubeErrorDetails(error),
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
	accounts: ReturnType<typeof useAccounts>,
	widgetMetas: ReturnType<typeof useWidgetMetas>,
) {
	return (
		!account.reauthorize &&
		account.service === 'youtube' &&
		account.type === 'read' &&
		relatedWidgetIds(account, accounts, widgetMetas).length > 0
	);
}
