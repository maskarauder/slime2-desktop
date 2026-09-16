import axios, { type AxiosRequestConfig } from 'axios';
import youtubeAuth from './youtubeAuth';
import type {
	YouTubeChannel,
	YouTubeListResponse,
	YouTubeLiveBroadcast,
	YouTubeLiveChatMessageListResponse,
} from './youtubeTypes';

const youtubeApiAxios = axios.create({
	baseURL: 'https://www.googleapis.com/youtube/v3',
});

const youtubeApi = {
	async getMyChannelWithAccessToken(accessToken: string) {
		return youtubeApiAxios.get<YouTubeListResponse<YouTubeChannel>>(
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
					mine: true,
					part: 'id,snippet,status',
					broadcastStatus: 'active',
					broadcastType: 'all',
					maxResults: 1,
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
					maxResults: 200,
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
	const tokens = await youtubeAuth.getValidTokens(accountId);
	return youtubeApiAxios.get<T>(url, {
		...config,
		headers: {
			...config?.headers,
			Authorization: `Bearer ${tokens.accessToken}`,
		},
	});
}
