import axios, { type AxiosRequestConfig } from 'axios';
import youtubeAuth from './youtubeAuth';
import type {
	YouTubeChannel,
	YouTubeListResponse,
	YouTubeLiveBroadcast,
	YouTubeLiveChatMessageListResponse,
} from './youtubeTypes';

const REQUEST_TIMEOUT_MS = 30 * 1000;

const youtubeApiAxios = axios.create({
	baseURL: 'https://www.googleapis.com/youtube/v3',
	timeout: REQUEST_TIMEOUT_MS,
});

const youtubeApi = {
	async getMyChannelWithAccessToken(accessToken: string) {
		return youtubeRequest<YouTubeListResponse<YouTubeChannel>>(
			'/channels',
			{
				headers: { Authorization: `Bearer ${accessToken}` },
				params: { mine: true, part: 'id,snippet', maxResults: 1 },
			},
		);
	},

	async getMyChannel(accountId: string, signal?: AbortSignal) {
		return youtubeApiGet<YouTubeListResponse<YouTubeChannel>>(
			'/channels',
			accountId,
			{
				signal,
				params: { mine: true, part: 'id,snippet', maxResults: 1 },
			},
		);
	},

	async getActiveBroadcast(accountId: string, signal?: AbortSignal) {
		return youtubeApiGet<YouTubeListResponse<YouTubeLiveBroadcast>>(
			'/liveBroadcasts',
			accountId,
			{
				signal,
				params: {
					part: 'id,snippet,status',
					broadcastStatus: 'active',
					broadcastType: 'all',
					maxResults: 50,
				},
			},
		);
	},

	async getLiveChatMessages(
		accountId: string,
		liveChatId: string,
		pageToken?: string,
		signal?: AbortSignal,
	) {
		return youtubeApiGet<YouTubeLiveChatMessageListResponse>(
			'/liveChat/messages',
			accountId,
			{
				signal,
				params: {
					liveChatId,
					part: 'id,snippet,authorDetails',
					maxResults: 2000,
					pageToken,
					profileImageSize: 88,
				},
			},
		);
	},
};

export default youtubeApi;

async function youtubeApiGet<T>(
	url: string,
	accountId: string,
	config?: AxiosRequestConfig,
) {
	if (config?.signal?.aborted) throw new axios.CanceledError();
	const tokens = await youtubeAuth.getValidTokens(accountId);
	const request = (accessToken: string) =>
		youtubeRequest<T>(url, {
			...config,
			headers: {
				...config?.headers,
				Authorization: `Bearer ${accessToken}`,
			},
		});
	try {
		return await request(tokens.accessToken);
	} catch (error) {
		if (
			config?.signal?.aborted ||
			!axios.isAxiosError(error) ||
			error.response?.status !== 401
		)
			throw error;
		// An access token can be rejected before its recorded expiry. Try one
		// refresh, sharing it with other requests for this account, before the
		// caller asks the user to reconnect. Never loop on a second 401.
		const refreshed = await youtubeAuth.getValidTokens(
			accountId,
			tokens.accessToken,
		);
		return request(refreshed.accessToken);
	}
}

async function youtubeRequest<T>(url: string, config: AxiosRequestConfig) {
	const parentSignal = config.signal;
	if (parentSignal?.aborted) throw new axios.CanceledError();
	const controller = new AbortController();
	let timedOut = false;
	const abort = () => controller.abort();
	parentSignal?.addEventListener?.('abort', abort, { once: true });
	// Axios' response timeout plus an abort deadline also covers a connection
	// that never finishes opening after a network outage or system sleep.
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, REQUEST_TIMEOUT_MS);
	try {
		return await youtubeApiAxios.get<T>(url, {
			...config,
			signal: controller.signal,
		});
	} catch (error) {
		if (timedOut && !parentSignal?.aborted) {
			throw new axios.AxiosError(
				'YouTube request timed out after 30 seconds.',
				'ETIMEDOUT',
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener?.('abort', abort);
	}
}
