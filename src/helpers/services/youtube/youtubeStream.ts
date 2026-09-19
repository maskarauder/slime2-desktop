import { invoke } from '@tauri-apps/api/core';
import youtubeAuth, { YouTubeReauthorizationError } from './youtubeAuth';
import type { YouTubeLiveChatMessageListResponse } from './youtubeTypes';

export class YouTubeStreamError extends Error {
	constructor(
		public readonly grpcCode: number,
		message: string,
	) {
		super(message);
		this.name = 'YouTubeStreamError';
	}
}

function streamError(error: unknown): YouTubeStreamError {
	if (error instanceof YouTubeStreamError) return error;
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof error.code === 'number' &&
		'message' in error &&
		typeof error.message === 'string'
	) {
		return new YouTubeStreamError(error.code, error.message);
	}
	// Never log arbitrary IPC error objects or command arguments with tokens.
	return new YouTubeStreamError(
		14,
		'Unable to use the native YouTube stream connection.',
	);
}

/** Pull one batch at a time so a slow widget cannot grow an unbounded IPC queue. */
export async function* streamYouTubeChat(
	accountId: string,
	liveChatId: string,
	pageToken: string | undefined,
	signal: AbortSignal,
): AsyncGenerator<YouTubeLiveChatMessageListResponse> {
	let rejectedToken: string | undefined;
	let refreshedAfterRejection = false;
	while (!signal.aborted) {
		// Refresh using the existing shared OAuth logic and credential store.
		const tokens = await youtubeAuth.getValidTokens(
			accountId,
			rejectedToken,
		);
		if (signal.aborted) return;
		const sessionId = crypto.randomUUID();
		const close = () =>
			invoke<void>('close_youtube_chat_stream', { accountId, sessionId });
		const abort = () => {
			void close().catch(() => {});
		};
		signal.addEventListener('abort', abort, { once: true });
		try {
			await invoke<void>('open_youtube_chat_stream', {
				accountId,
				sessionId,
				accessToken: tokens.accessToken,
				liveChatId,
				pageToken: pageToken ?? null,
			});
			if (signal.aborted) return;
			console.info(`YouTube streamList connected for ${accountId}.`);
			while (!signal.aborted) {
				const batch =
					await invoke<YouTubeLiveChatMessageListResponse | null>(
						'next_youtube_chat_batch',
						{ accountId, sessionId },
					);
				if (signal.aborted) return;
				if (batch === null) {
					throw new YouTubeStreamError(
						14,
						'YouTube stream ended; reconnecting from the last received page.',
					);
				}
				// A response proves the token worked. A later expiry during a long
				// stream may need another refresh; only consecutive rejections fail.
				refreshedAfterRejection = false;
				rejectedToken = undefined;
				yield batch;
				// Commit only after the consumer successfully dispatches the batch.
				pageToken = batch.nextPageToken || pageToken;
			}
		} catch (error) {
			if (signal.aborted) return;
			const failure = streamError(error);
			if (failure.grpcCode !== 16) throw failure;
			if (refreshedAfterRejection) {
				throw new YouTubeReauthorizationError(
					'YouTube rejected the refreshed access token. Reconnect this account.',
				);
			}
			refreshedAfterRejection = true;
			rejectedToken = tokens.accessToken;
		} finally {
			signal.removeEventListener('abort', abort);
			// Repeat cleanup after open settles, covering an abort that arrived
			// before the native open command had registered its connection.
			await close().catch(() => {});
		}
	}
}
