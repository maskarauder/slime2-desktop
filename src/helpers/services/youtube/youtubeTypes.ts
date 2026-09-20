export type YouTubeChannel = {
	id: string;
	snippet: {
		title: string;
		customUrl?: string;
		thumbnails?: {
			default?: { url: string };
			medium?: { url: string };
			high?: { url: string };
		};
	};
};

export type YouTubeLiveBroadcast = {
	id: string;
	snippet: {
		title: string;
		liveChatId?: string;
	};
	status?: {
		lifeCycleStatus?: string;
	};
};

export type YouTubeAuthorDetails = {
	channelId: string;
	channelUrl: string;
	displayName: string;
	profileImageUrl: string;
	isVerified: boolean;
	isChatOwner: boolean;
	isChatSponsor: boolean;
	isChatModerator: boolean;
};

export type YouTubeLiveChatMessage = {
	id: string;
	snippet: {
		type: string;
		liveChatId: string;
		authorChannelId?: string;
		publishedAt: string;
		hasDisplayContent?: boolean;
		displayMessage?: string;
		textMessageDetails?: { messageText: string };
		userBannedDetails?: {
			bannedUserDetails: {
				channelId: string;
				channelUrl: string;
				displayName: string;
				profileImageUrl: string;
			};
			banType: 'permanent' | 'temporary';
			banDurationSeconds?: string;
		};
		memberMilestoneChatDetails?: {
			userComment: string;
			memberMonth: number;
			memberLevelName: string;
		};
		newSponsorDetails?: {
			memberLevelName: string;
			isUpgrade: boolean;
		};
		superChatDetails?: {
			amountMicros: string;
			currency: string;
			amountDisplayString: string;
			userComment: string;
			tier: number;
		};
		superStickerDetails?: {
			superStickerMetadata: {
				stickerId: string;
				altText: string;
				language: string;
			};
			amountMicros: string;
			currency: string;
			amountDisplayString: string;
			tier: number;
		};
		membershipGiftingDetails?: {
			giftMembershipsCount: number;
			giftMembershipsLevelName: string;
		};
		giftMembershipReceivedDetails?: {
			memberLevelName: string;
			gifterChannelId: string;
			associatedMembershipGiftingMessageId: string;
		};
		pollDetails?: {
			metadata: {
				status?: 'active' | 'closed' | 'unknown';
				questionText?: string;
				options?: { optionText: string; tally: string }[];
			};
		};
		giftEventDetails?: {
			giftMetadata: {
				jewelsAmount: number;
				comboCount?: number;
				giftDuration?: { seconds: number; nanos: number };
				hasVisualEffect?: boolean;
				giftName: string;
				giftUrl: string;
				altText: string;
				language: string;
			};
		};
	};
	authorDetails?: YouTubeAuthorDetails;
};

export type YouTubeListResponse<T> = {
	items?: T[];
	nextPageToken?: string;
};

export type YouTubeLiveChatMessageListResponse =
	YouTubeListResponse<YouTubeLiveChatMessage> & {
		pollingIntervalMillis?: number;
		offlineAt?: string;
		activePollItem?: YouTubeLiveChatMessage;
	};
