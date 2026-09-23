import { getYouTubeGlobalEmotes } from './services/emotes/YouTube';
import {
	sendTikTokEvent,
	sendYouTubeEvent,
	sendTwitchEvent,
} from './widgetMessage';
import { abortableDelay } from './services/youtube/youtubeChatReader';
export type SimulationPlatform = 'twitch' | 'youtube' | 'tiktok';
export type SimulationKind =
	| 'chat'
	| 'emote'
	| 'gif'
	| 'superChat'
	| 'superSticker'
	| 'membership'
	| 'membershipGift'
	| 'gift';

// Existing project sample, pinned to a commit; this is a synthetic GIF event,
// not a Twitch asset lookup. Live GIF URLs must always be forwarded unchanged.
const SAMPLE_GIF_URL =
	'https://raw.githubusercontent.com/maskarauder/slime2-desktop/81c8ed9a4d75ef523aa365befada3181d4edc1f4/resources/widgets/test/assets/heavy_breathing.gif';

export function makeSimulation(
	platform: SimulationPlatform,
	kind: SimulationKind,
	name: string,
	text: string,
) {
	const id = `simulation-${crypto.randomUUID()}`,
		timestamp = new Date().toISOString(),
		viewer = name.trim().slice(0, 60) || 'Sample Viewer',
		content = text.slice(0, 500) || 'Hello from the simulator!';
	const emote = getYouTubeGlobalEmotes().find(
		e => e.name === ':face-red-droopy-eyes:',
	)!;
	if (platform === 'youtube') {
		if (kind === 'gif')
			throw new Error(
				'GIF message simulation is only available for Twitch.',
			);
		const types = {
			chat: 'textMessageEvent',
			emote: 'textMessageEvent',
			superChat: 'superChatEvent',
			superSticker: 'superStickerEvent',
			membership: 'newSponsorEvent',
			membershipGift: 'membershipGiftingEvent',
			gift: 'giftEvent',
		};
		const snippet: Record<string, unknown> = {
			liveChatId: 'simulation-youtube',
			publishedAt: timestamp,
			hasDisplayContent: true,
			type: types[kind],
		};
		if (kind === 'chat' || kind === 'emote') {
			snippet.displayMessage =
				kind === 'emote' ? `${content} ${emote.name}` : content;
			snippet.textMessageDetails = {
				messageText: snippet.displayMessage,
			};
		}
		if (kind === 'superChat')
			snippet.superChatDetails = {
				amountMicros: '5000000',
				currency: 'USD',
				amountDisplayString: '$5.00',
				userComment: content,
				tier: 2,
			};
		if (kind === 'superSticker')
			snippet.superStickerDetails = {
				amountMicros: '2000000',
				currency: 'USD',
				amountDisplayString: '$2.00',
				tier: 1,
				superStickerMetadata: {
					stickerId: 'simulation',
					altText: 'Thank you!',
					language: 'en',
				},
			};
		if (kind === 'membership')
			snippet.newSponsorDetails = {
				memberLevelName: 'Sample member',
				isUpgrade: false,
			};
		if (kind === 'membershipGift')
			snippet.membershipGiftingDetails = {
				giftMembershipsCount: 5,
				giftMembershipsLevelName: 'Sample member',
			};
		return {
			id,
			type: types[kind],
			timestamp,
			data: {
				id,
				snippet,
				authorDetails: {
					channelId: 'UC0000000000000000000000',
					channelUrl: '',
					displayName: viewer,
					profileImageUrl: '',
					isChatOwner: false,
					isChatModerator: false,
					isVerified: false,
					isChatSponsor: kind === 'membership',
				},
				...(kind === 'emote'
					? {
							simulationFragments: [
								{ type: 'text', text: `${content} ` },
								{
									type: 'emote',
									text: emote.name,
									emote: {
										id: emote.id,
										url: emote.srcAnimated,
									},
								},
							],
						}
					: {}),
			},
		};
	}
	if (kind === 'gif' && platform !== 'twitch')
		throw new Error('GIF message simulation is only available for Twitch.');
	const fragments = [
		{ type: 'text', text: kind === 'gif' ? `${content} ` : content },
		...(kind === 'gif'
			? [
					{
						type: 'gif',
						text: '[GIF]',
						gif: { id: 'simulation-gif', url: SAMPLE_GIF_URL },
					},
				]
			: []),
		...(kind === 'emote'
			? [
					{
						type: 'emote',
						text: ':sample:',
						emote: {
							id: platform === 'twitch' ? '25' : 'sample',
							url: emote.srcAnimated,
							emote_set_id: '0',
							owner_id: '0',
							format: ['static'],
						},
					},
				]
			: []),
	];
	return {
		id,
		type:
			platform === 'twitch'
				? 'channel.chat.message'
				: kind === 'gift'
					? 'WebcastGiftMessage'
					: 'WebcastChatMessage',
		timestamp,
		data: {
			broadcaster_user_id: 'simulation-channel',
			broadcaster_user_login: 'simulation',
			broadcaster_user_name: 'Simulation',
			chatter_user_id: '9000000000000000001',
			chatter_user_login: 'sample_viewer',
			chatter_user_name: viewer,
			message_id: id,
			message_type: kind === 'gift' ? 'gift' : 'text',
			color: '#9146ff',
			badges: [],
			message: {
				text:
					kind === 'gift'
						? 'Sent 3 × Sample gift'
						: kind === 'gif'
							? `${content} [GIF]`
							: content,
				fragments:
					kind === 'gift'
						? [{ type: 'text', text: 'Sent 3 × Sample gift' }]
						: fragments,
			},
			...(kind === 'gift'
				? {
						gift: {
							id: 'sample',
							name: 'Sample gift',
							count: 3,
							complete: true,
						},
					}
				: {}),
		},
	};
}
export async function simulateBurst(options: {
	platform: SimulationPlatform;
	kind: SimulationKind;
	name: string;
	text: string;
	widgetIds: string[];
	count: number;
	interval: number;
	signal: AbortSignal;
	onProgress: (sent: number) => void;
}) {
	const count = Math.max(1, Math.min(100, Math.floor(options.count) || 1)),
		interval = Math.max(100, Math.min(30000, options.interval || 1000));
	for (let i = 0; i < count && !options.signal.aborted; i++) {
		const event = makeSimulation(
			options.platform,
			options.kind,
			options.name,
			options.text,
		);
		for (const id of options.widgetIds) {
			if (options.signal.aborted) return;
			if (options.platform === 'twitch')
				await sendTwitchEvent(
					'simulation',
					id,
					event.id,
					event.type,
					'1',
					event.timestamp,
					event.data,
					true,
					false,
				);
			else if (options.platform === 'youtube')
				await sendYouTubeEvent(
					'simulation',
					id,
					event.id,
					event.type,
					event.timestamp,
					event.data,
					true,
					false,
				);
			else
				await sendTikTokEvent(
					'simulation',
					id,
					event.id,
					event.type,
					event.timestamp,
					event.data,
					true,
					false,
				);
		}
		options.onProgress(i + 1);
		if (i + 1 < count) await abortableDelay(interval, options.signal);
	}
}
