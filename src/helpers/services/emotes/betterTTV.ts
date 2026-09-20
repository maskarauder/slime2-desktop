import { createCachedJsonGet } from '../requestCache';
import axios from 'axios';

const bttvAxios = axios.create({
	baseURL: 'https://api.betterttv.net/3/cached',
});
const cachedGet = createCachedJsonGet(bttvAxios);

type BttvEmote = {
	id: string;
	code: string;
	imageType: string;
	animated: boolean;
	userId?: string;
	user?: {
		id: string;
		name: string;
		displayName: string;
		providerId: string;
	};
};

const bttvApi = {
	async getUser(platform: 'twitch' | 'youtube', userId: string) {
		const [globalEmotes, user] = await Promise.all([
			cachedGet<BttvEmote[]>('/emotes/global')
				.then(response => response.data)
				.catch(() => null),
			cachedGet<{
				id: string;
				bots: string[];
				avatar: string;
				channelEmotes: BttvEmote[];
				sharedEmotes: BttvEmote[];
			}>(`/users/${platform}/${userId}`)
				.then(response => response.data)
				.catch(() => null),
		]);

		if (!globalEmotes && !user) return null;

		return {
			bots: user?.bots ?? [],
			emotes: [
				...(globalEmotes ?? []),
				...(user?.channelEmotes ?? []),
				...(user?.sharedEmotes ?? []),
			].map(emote => {
				return {
					id: emote.id,
					code: emote.code,
					imageType: emote.imageType,
					animated: emote.animated,
				};
			}),
		};
	},
};

export default bttvApi;
