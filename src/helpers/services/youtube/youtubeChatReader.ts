import youtubeApi from './youtubeApi';
import type { ConnectionUpdate } from '../../connectionStatus';
import { YouTubeReauthorizationError } from './youtubeAuth';
import { getYouTubeErrorDetails } from './youtubeError';
import {
	streamYouTubeChat,
	streamEndedError,
	YouTubeStreamError,
} from './youtubeStream';
import type {
	YouTubeLiveChatMessage,
	YouTubeLiveChatMessageListResponse,
} from './youtubeTypes';

export const REST_POLL_INTERVAL = 30_000;
const BROADCAST_RETRY_DELAY = 60_000;
const STREAM_RETRY_DELAY = 5_000;
const FALLBACK_DURATION = 10 * 60_000;
const LIMIT_RETRY_DELAY = 15 * 60_000;
const MAX_SEEN_MESSAGES = 5_000;

export function abortableDelay(milliseconds: number, signal: AbortSignal) {
	return new Promise<void>(resolve => {
		if (signal.aborted || milliseconds <= 0) {
			resolve();
			return;
		}
		function finish() {
			clearTimeout(timer);
			signal.removeEventListener('abort', finish);
			resolve();
		}
		const timer = setTimeout(finish, milliseconds);
		signal.addEventListener('abort', finish, { once: true });
	});
}

const defaultDependencies = {
	broadcast: youtubeApi.getActiveBroadcast,
	poll: youtubeApi.getLiveChatMessages,
	stream: streamYouTubeChat,
	delay: abortableDelay,
	now: Date.now,
};

/** One reader per account; the caller fans out each message to its widgets. */
export async function readYouTubeChat(
	options: {
		accountId: string;
		signal: AbortSignal;
		accountName: () => string;
		onMessage: (message: YouTubeLiveChatMessage) => Promise<void>;
		onStatus?: (status: ConnectionUpdate) => void;
	},
	dependencies = defaultDependencies,
) {
	const { accountId, signal, accountName, onMessage } = options;
	const { broadcast, poll, stream, delay, now } = dependencies;
	const seen = new Map<string, string>();
	let liveChatId: string | undefined;
	let previousChatId: string | undefined;
	let pageToken: string | undefined;
	let pollingInterval = REST_POLL_INTERVAL;
	let nextPollAt = 0;
	let fallbackUntil = 0;
	let streamFailures = 0;
	let waitingForBroadcast = false;
	let lastHealthLog = now();
	let receivedSinceHealthLog = 0;
	const status = (value: ConnectionUpdate) => {
		if (!signal.aborted) options.onStatus?.(value);
	};
	function wait(
		milliseconds: number,
		state: 'waiting' | 'reconnecting' | 'paused',
		detail?: string,
	) {
		status({ state, retryAt: now() + milliseconds, detail });
		return delay(milliseconds, signal);
	}

	function clearChat() {
		liveChatId = undefined;
		pageToken = undefined;
		pollingInterval = REST_POLL_INTERVAL;
		fallbackUntil = 0;
		streamFailures = 0;
	}

	async function processBatch(batch: YouTubeLiveChatMessageListResponse) {
		let ended = Boolean(batch.offlineAt);
		const messages = [...(batch.items ?? [])];
		if (batch.activePollItem) messages.push(batch.activePollItem);
		for (const message of messages) {
			if (signal.aborted) return false;
			if (message.snippet.type === 'chatEndedEvent') ended = true;
			if (!message.id) continue;
			const type = message.snippet.type;
			const key = `${message.snippet.liveChatId}:${message.id}`;
			// Gift/poll IDs can be updated; tombstones supersede ordinary messages.
			const signature =
				type === 'giftEvent' || type === 'pollEvent'
					? JSON.stringify([
							type,
							message.snippet.giftEventDetails,
							message.snippet.pollDetails,
						])
					: type;
			if (seen.get(key) === 'tombstone' || seen.get(key) === signature)
				continue;
			await onMessage(message);
			seen.delete(key);
			seen.set(key, signature);
			if (seen.size > MAX_SEEN_MESSAGES) {
				const oldest = seen.keys().next().value;
				if (oldest !== undefined) seen.delete(oldest);
			}
			receivedSinceHealthLog++;
		}
		// Do not advance after a partially dispatched or interrupted batch.
		if (!signal.aborted) pageToken = batch.nextPageToken || pageToken;
		if (now() - lastHealthLog >= 5 * 60_000) {
			console.info(
				`YouTube chat healthy for ${accountName()}; ${receivedSinceHealthLog} new message(s) since the last status.`,
			);
			lastHealthLog = now();
			receivedSinceHealthLog = 0;
		}
		return ended;
	}

	while (!signal.aborted) {
		let mode: 'discovery' | 'stream' | 'rest' = 'discovery';
		let streamStartedAt = now();
		let receivedStreamBatch = false;
		try {
			if (!liveChatId) {
				status({
					state: 'connecting',
					detail: 'Checking for a live broadcast',
				});
				const response = await broadcast(accountId, signal);
				if (signal.aborted) return;
				const active = response.data.items?.find(
					item =>
						item.status?.lifeCycleStatus === 'live' &&
						item.snippet.liveChatId,
				);
				if (!active?.snippet.liveChatId) {
					if (!waitingForBroadcast) {
						console.info(
							`No active YouTube broadcast with live chat was found for ${accountName()}. Retrying in one minute.`,
						);
						waitingForBroadcast = true;
					}
					await wait(BROADCAST_RETRY_DELAY, 'waiting');
					continue;
				}
				liveChatId = active.snippet.liveChatId;
				if (liveChatId !== previousChatId) {
					seen.clear();
					previousChatId = liveChatId;
				}
				waitingForBroadcast = false;
				console.info(
					`Reading YouTube chat for ${accountName()}:`,
					active.snippet.title,
				);
			}

			if (now() < fallbackUntil) {
				mode = 'rest';
				await delay(Math.max(0, nextPollAt - now()), signal);
				if (signal.aborted) return;
				const response = await poll(
					accountId,
					liveChatId,
					pageToken,
					signal,
				);
				if (signal.aborted) return;
				const suggested = response.data.pollingIntervalMillis;
				pollingInterval = Math.max(
					REST_POLL_INTERVAL,
					Number.isFinite(suggested)
						? suggested!
						: REST_POLL_INTERVAL,
				);
				nextPollAt = now() + pollingInterval;
				status({
					state: 'connected',
					transport: 'rest',
					retryAt: nextPollAt,
					detail: 'REST fallback; next poll',
				});
				if (await processBatch(response.data)) {
					clearChat();
					await wait(
						BROADCAST_RETRY_DELAY,
						'waiting',
						'Live chat ended',
					);
				}
				continue;
			}

			mode = 'stream';
			status({
				state: 'connecting',
				transport: 'grpc',
				detail: 'Waiting for the first streamList response',
			});
			streamStartedAt = now();
			let ended = false;
			for await (const batch of stream(
				accountId,
				liveChatId,
				pageToken,
				signal,
				() => status({ state: 'connected', transport: 'grpc' }),
			)) {
				receivedStreamBatch = true;
				if (signal.aborted) return;
				if (await processBatch(batch)) {
					ended = true;
					break;
				}
			}
			if (signal.aborted) return;
			if (ended) {
				console.info(
					`YouTube live chat ended for ${accountName()}; checking for another broadcast in one minute.`,
				);
				clearChat();
				await wait(BROADCAST_RETRY_DELAY, 'waiting', 'Live chat ended');
				continue;
			}
			throw streamEndedError(receivedStreamBatch);
		} catch (error) {
			if (signal.aborted) return;
			const details = getYouTubeErrorDetails(error);
			if (
				error instanceof YouTubeReauthorizationError ||
				details.status === 401
			)
				throw error;
			const code =
				error instanceof YouTubeStreamError
					? error.grpcCode
					: undefined;
			const reason = details.reason ?? '';

			// A transport switch cannot bypass project quotas or permission errors.
			if (
				code === 8 ||
				code === 7 ||
				['quotaExceeded', 'dailyLimitExceeded'].includes(reason)
			) {
				console.warn(
					`YouTube chat paused for ${accountName()} for 15 minutes after a quota, rate limit, or permission error:`,
					details,
				);
				await wait(
					LIMIT_RETRY_DELAY,
					'paused',
					'Quota, rate limit, or permission error',
				);
				continue;
			}
			if (
				code === 5 ||
				code === 9 ||
				[
					'liveChatEnded',
					'liveChatNotFound',
					'liveChatDisabled',
				].includes(reason)
			) {
				clearChat();
				console.info(
					`YouTube live chat is no longer available for ${accountName()}; checking again in one minute.`,
				);
				await wait(
					BROADCAST_RETRY_DELAY,
					'waiting',
					'Live chat unavailable',
				);
				continue;
			}
			if (
				(code === 3 && pageToken) ||
				['invalidPageToken', 'pageTokenInvalid'].includes(reason)
			) {
				pageToken = undefined;
				// Keep message IDs to avoid replaying recent history after a reset.
			}

			if (mode === 'stream') {
				if (receivedStreamBatch && now() - streamStartedAt >= 60_000)
					streamFailures = 0;
				streamFailures++;
				if (streamFailures >= 3 || code === 12) {
					fallbackUntil = now() + FALLBACK_DURATION;
					nextPollAt = Math.max(
						nextPollAt,
						now() + REST_POLL_INTERVAL,
					);
					status({
						state: 'reconnecting',
						transport: 'rest',
						retryAt: nextPollAt,
						detail: 'Switching to REST fallback',
					});
					streamFailures = 0;
					console.warn(
						`YouTube streamList unavailable for ${accountName()}; using REST fallback with at least 30s between polls and retrying streaming in 10 minutes:`,
						details,
					);
				} else {
					const retryDelay = STREAM_RETRY_DELAY * streamFailures;
					console.warn(
						`YouTube streamList reconnect for ${accountName()} in ${retryDelay / 1000}s:`,
						details,
					);
					await wait(
						retryDelay,
						'reconnecting',
						'Resuming streamList',
					);
				}
			} else {
				const retryDelay =
					mode === 'rest'
						? Math.max(pollingInterval, REST_POLL_INTERVAL)
						: BROADCAST_RETRY_DELAY;
				nextPollAt = Math.max(nextPollAt, now() + retryDelay);
				console.warn(
					`YouTube ${mode} retry for ${accountName()} in ${retryDelay / 1000}s:`,
					details,
				);
				await wait(retryDelay, 'reconnecting', `Retrying ${mode}`);
			}
		}
	}
}
