import { invoke } from '@tauri-apps/api/core';
import youtubeAuth, { YouTubeReauthorizationError } from './youtubeAuth';
import type { YouTubeLiveChatMessageListResponse } from './youtubeTypes';

export class YouTubeStreamError extends Error {
	constructor(
		public readonly grpcCode: number | undefined,
		message: string,
		public readonly streamCode?:
			'STREAM_EMPTY_EOF' | 'STREAM_EOF' | 'NATIVE_STREAM_ERROR',
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
		undefined,
		'Unable to use the native YouTube stream connection.',
		'NATIVE_STREAM_ERROR',
	);
}

/** Native null means a clean response end, not a gRPC UNAVAILABLE status. */
export function streamEndedError(
	receivedBatch: boolean,
	diagnostics?: {
		elapsedMs: number;
		responseBatches: number;
		resuming: boolean;
	},
) {
	const detail = diagnostics
		? ` Elapsed: ${Math.max(0, Math.round(diagnostics.elapsedMs))}ms; response batches: ${diagnostics.responseBatches}; continuation supplied: ${diagnostics.resuming ? 'yes' : 'no'}.`
		: '';
	return new YouTubeStreamError(
		undefined,
		(receivedBatch
			? 'YouTube ended the stream after sending responses; resuming from the last received page.'
			: 'YouTube closed streamList without sending any response batches. No gRPC error status was reported.') +
			detail,
		receivedBatch ? 'STREAM_EOF' : 'STREAM_EMPTY_EOF',
	);
}

/** Pull one batch at a time so a slow widget cannot grow an unbounded IPC queue. */
export async function* streamYouTubeChat(
	accountId: string,
	liveChatId: string,
	pageToken: string | undefined,
	signal: AbortSignal,
	onConnected?: () => void,
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
		let responseBatches = 0;
		const startedAt = Date.now();
		const resuming = Boolean(pageToken);
		try {
			await invoke<void>('open_youtube_chat_stream', {
				accountId,
				sessionId,
				accessToken: tokens.accessToken,
				liveChatId,
				pageToken: pageToken ?? null,
			});
			if (signal.aborted) return;
			while (!signal.aborted) {
				const batch =
					await invoke<YouTubeLiveChatMessageListResponse | null>(
						'next_youtube_chat_batch',
						{ accountId, sessionId },
					);
				if (signal.aborted) return;
				if (batch === null)
					throw streamEndedError(responseBatches > 0, {
						elapsedMs: Date.now() - startedAt,
						responseBatches,
						resuming,
					});
				if (++responseBatches === 1) {
					// HTTP response headers alone do not prove streamList delivers
					// data. An empty but valid batch does, even when chat is quiet.
					console.info(
						`YouTube streamList receiving responses for ${accountId}.`,
					);
					onConnected?.();
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
