import axios from 'axios';

const sevenTvAxios = axios.create({
	baseURL: 'https://7tv.io/v3',
});

type SevenTvEmote = {
	id: string;
	name: string;
};

type SevenTvEmoteSet = {
	id: string;
	name: string;
	emotes: SevenTvEmote[];
};

const sevenTvApi = {
	async getUser(platform: 'twitch', userId: string) {
		const [globalEmoteSet, user] = await Promise.all([
			sevenTvAxios
				.get<SevenTvEmoteSet>('/emote-sets/global')
				.then(response => response.data)
				.catch(() => null),
			sevenTvAxios
				.get<{
					id: string;
					platform: string;
					username: string;
					emote_set: SevenTvEmoteSet;
				}>(`/users/${platform}/${userId}`)
				.then(response => response.data)
				.catch(() => null),
		]);

		if (!globalEmoteSet && !user) return null;

		return {
			emotes: [
				...(globalEmoteSet?.emotes ?? []),
				...(user?.emote_set?.emotes ?? []),
			].map(emote => {
				return {
					id: emote.id,
					name: emote.name,
				};
			}),
		};
	},
};

export default sevenTvApi;
