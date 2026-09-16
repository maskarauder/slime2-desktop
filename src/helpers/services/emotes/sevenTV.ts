import axios from 'axios';

const sevenTvAxios = axios.create({
	baseURL: 'https://7tv.io/v3',
});

type SevenTvImageFile = {
	name: string;
	static_name?: string;
	width: number;
	format: string;
};

type SevenTvImageHost = {
	url: string;
	files: SevenTvImageFile[];
};

type SevenTvEmote = {
	id: string;
	name: string;
	data?: {
		animated?: boolean;
		host?: SevenTvImageHost;
	};
};

type SevenTvEmoteSet = {
	id: string;
	name: string;
	emotes?: SevenTvEmote[];
};

type SevenTvUserResponse = {
	emote_set?: SevenTvEmoteSet | null;
	emote_set_id?: string | null;
};

async function getEmoteSet(id: string): Promise<SevenTvEmoteSet | null> {
	return sevenTvAxios
		.get<SevenTvEmoteSet>(`/emote-sets/${id}`)
		.then(response => response.data)
		.catch(() => null);
}

function normalizeEmote(emote: SevenTvEmote) {
	const host = emote.data?.host;
	let largestWebp: SevenTvImageFile | undefined;

	for (const file of host?.files ?? []) {
		if (file.format.toUpperCase() !== 'WEBP') continue;

		if (!largestWebp || file.width > largestWebp.width) {
			largestWebp = file;
		}
	}

	const baseUrl = host?.url
		? `${host.url.startsWith('//') ? 'https:' : ''}${host.url}`.replace(
				/\/$/,
				'',
			)
		: `https://cdn.7tv.app/emote/${emote.id}`;
	const animatedFilename = largestWebp?.name ?? '4x.webp';
	const staticFilename =
		largestWebp?.static_name ??
		(emote.data?.animated ? '4x_static.webp' : animatedFilename);

	return {
		id: emote.id,
		name: emote.name,
		srcAnimated: `${baseUrl}/${animatedFilename}`,
		srcStatic: `${baseUrl}/${staticFilename}`,
	};
}

const sevenTvApi = {
	async getUser(platform: 'twitch', userId: string) {
		const [globalEmoteSet, user] = await Promise.all([
			getEmoteSet('global'),
			sevenTvAxios
				.get<SevenTvUserResponse>(`/users/${platform}/${userId}`, {
					headers: {
						'X-7tv-Missing-EmoteSet-Aware': '1',
					},
				})
				.then(response => response.data)
				.catch(() => null),
		]);

		let channelEmoteSet = user?.emote_set ?? null;
		if (!channelEmoteSet && user?.emote_set_id) {
			channelEmoteSet = await getEmoteSet(user.emote_set_id);
		}

		if (!globalEmoteSet && !channelEmoteSet) return null;

		return {
			emotes: [
				...(globalEmoteSet?.emotes ?? []),
				...(channelEmoteSet?.emotes ?? []),
			].map(normalizeEmote),
		};
	},
};

export default sevenTvApi;
