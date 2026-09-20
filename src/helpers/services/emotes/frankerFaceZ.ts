import { createCachedJsonGet } from '../requestCache';
import axios from 'axios';

const ffzAxios = axios.create({
	baseURL: 'https://api.frankerfacez.com/v1',
});
const cachedGet = createCachedJsonGet(ffzAxios);

type FfzImageUrls = {
	// 1 is guaranteed, 2 and 4 aren't
	'1': string;
	'2': string | null;
	'4': string | null;
};

type FfzEmote = {
	id: number;
	name: string;
	height: number;
	width: number;
	public: boolean;
	hidden: boolean;
	modifier: boolean;
	modifier_flags: number;
	offset: string | null;
	margins: string | null;
	css: string | null;
	owner: {
		_id: number;
		name: string;
		display_name: string | null;
	} | null;
	artist: {
		_id: number;
		name: string;
		display_name: string | null;
	} | null;
	urls: FfzImageUrls;
	animated?: FfzImageUrls | null;
	mask?: FfzImageUrls | null;
	mask_animated?: FfzImageUrls | null;
	status: number;
	usage_count: number;
	created_at: string;
	last_updated: string | null;
};

type FfzSet = {
	id: number;
	_type: number;
	icon: string | null;
	title: string | null;
	css: string | null;
	emoticons: FfzEmote[];
};

type FfzSets = Record<string, FfzSet>;

const ffzApi = {
	async getRoom(platform: 'twitch' | 'youtube', userId: string) {
		const roomType = platform === 'youtube' ? 'yt' : 'id';
		const [globalData, roomData] = await Promise.all([
			cachedGet<{
				default_sets: number[];
				sets: FfzSets;
			}>('/set/global')
				.then(response => response.data)
				.catch(() => null),
			cachedGet<{
				room: {
					_id: number; // ffz user id
					twitch_id: number;
					youtube_id: string | null;
					id: string; // platform username
					is_group: boolean;
					display_name: string | null; // platform display name
					set: number;
					moderator_badge: string | null;
					vip_badge: FfzImageUrls | null;
					mod_urls: FfzImageUrls | null;
					user_badges: Record<string, string[]>;
					user_badge_ids: Record<string, number[]>;
					css: string | null;
				};
				sets: FfzSets;
			}>(`/room/${roomType}/${userId}`)
				.then(response => response.data)
				.catch(() => null),
		]);

		if (!globalData && !roomData) return null;

		const room = roomData?.room;
		const roomSet = room ? roomData?.sets?.[room.set] : undefined;
		const globalEmotes = (globalData?.default_sets ?? []).flatMap(
			setId => globalData?.sets?.[setId]?.emoticons ?? [],
		);

		return {
			moderator_badge: room?.moderator_badge ?? null,
			vip_badge: room?.vip_badge ?? null,
			mod_urls: room?.mod_urls ?? null,
			user_badges: room?.user_badges ?? {},
			user_badge_ids: room?.user_badge_ids ?? {},
			emotes: [...globalEmotes, ...(roomSet?.emoticons ?? [])].map(
				emote => {
					return {
						id: emote.id,
						name: emote.name,
						height: emote.height,
						width: emote.width,
						urls: emote.urls,
						animated: emote.animated,
					};
				},
			),
		};
	},
};

export default ffzApi;
