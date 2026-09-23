type TikTokEventEnvelope = {
	type: string;
	data: Record<string, unknown>;
	timestamp?: unknown;
};

type TikTokMessageFragment =
	| { type: 'text'; text: string }
	| {
			type: 'emote';
			text: string;
			emote: { id: string; url: string };
	  };

export function parseEulerStreamMessage(
	message: string,
): TikTokEventEnvelope[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(message);
	} catch (error) {
		console.error('Euler Stream returned invalid JSON:', error);
		return [];
	}

	const bundleTimestamp = isRecord(parsed) ? parsed.timestamp : undefined;
	const rawEvents =
		isRecord(parsed) && Array.isArray(parsed.messages)
			? parsed.messages
			: Array.isArray(parsed)
				? parsed
				: [parsed];

	return rawEvents.flatMap(rawEvent => {
		if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string') return [];

		let data: unknown = rawEvent.data;
		if (typeof data === 'string') {
			try {
				data = JSON.parse(data);
			} catch {
				return [];
			}
		}
		if (!isRecord(data)) return [];

		return [
			{
				type: rawEvent.type,
				data,
				timestamp: rawEvent.timestamp ?? bundleTimestamp,
			},
		];
	});
}

export function normalizeChatEvent(envelope: TikTokEventEnvelope) {
	if (!['WebcastChatMessage', 'WebcastGiftMessage'].includes(envelope.type))
		return null;

	const { data } = envelope;
	const giftDetails = isRecord(data.giftDetails) ? data.giftDetails : {};
	const giftEvent = envelope.type === 'WebcastGiftMessage';
	if (
		giftEvent &&
		Number(giftDetails.giftType) === 1 &&
		Number(data.repeatEnd) !== 1
	)
		return null;
	const rawCount = Number(data.repeatCount ?? 1);
	const gift = giftEvent
		? {
				id:
					firstString(giftDetails, ['id']) ??
					firstString(data, ['giftId']) ??
					'',
				name: (firstString(giftDetails, ['name']) ?? 'gift').slice(
					0,
					100,
				),
				count: Number.isFinite(rawCount)
					? Math.max(1, Math.min(1_000_000, Math.floor(rawCount)))
					: 1,
				complete: true,
			}
		: undefined;
	const comment = gift
		? `Sent ${gift.count} × ${gift.name}`
		: typeof data.comment === 'string'
			? data.comment
			: '';
	const user = isRecord(data.user) ? data.user : {};
	const common = isRecord(data.common) ? data.common : {};
	const username = firstString(user, ['uniqueId', 'displayId', 'nickname']);
	const displayName = firstString(user, [
		'nickname',
		'displayId',
		'uniqueId',
	]);
	const userId = firstString(user, ['userId', 'idStr', 'secUid', 'uniqueId']);

	if (!comment && (!Array.isArray(data.emotes) || data.emotes.length === 0))
		return null;
	if (!username || !displayName || !userId) return null;

	const timestamp = normalizeTimestamp(
		common.createTime ?? envelope.timestamp,
	);
	const messageId =
		firstString(common, ['msgId', 'logId']) ?? crypto.randomUUID();

	return {
		id: messageId,
		type: envelope.type,
		timestamp,
		data: {
			...(gift ? { gift } : {}),
			message: {
				text: comment,
				fragments: buildTikTokFragments(comment, data.emotes),
			},
			chatter_user_name: displayName,
			chatter_user_login: username,
			chatter_user_id: userId,
			message_id: messageId,
			color: null,
			badges: [],
			message_type: gift ? 'gift' : 'chat',
		},
	};
}

function buildTikTokFragments(
	comment: string,
	rawEmotes: unknown,
): TikTokMessageFragment[] {
	if (!Array.isArray(rawEmotes) || rawEmotes.length === 0) {
		return [{ type: 'text', text: comment }];
	}

	const commentCharacters = Array.from(comment);
	const emotes = rawEmotes
		.flatMap(rawEmote => {
			if (!isRecord(rawEmote)) return [];

			const emote = isRecord(rawEmote.emote) ? rawEmote.emote : rawEmote;
			const image = isRecord(emote.image) ? emote.image : {};
			const id = firstString(emote, ['emoteId', 'id']);
			const url =
				firstString(image, ['imageUrl']) ??
				firstString(rawEmote, ['emoteImageUrl']);
			const numericPosition = Number(rawEmote.placeInComment);

			if (!id || !url) return [];
			return [
				{
					id,
					url,
					position: Number.isFinite(numericPosition)
						? Math.max(0, Math.floor(numericPosition))
						: commentCharacters.length,
				},
			];
		})
		.sort((first, second) => first.position - second.position);

	if (emotes.length === 0) return [{ type: 'text', text: comment }];

	const fragments: TikTokMessageFragment[] = [];
	let cursor = 0;
	for (const emote of emotes) {
		const position = Math.max(
			cursor,
			Math.min(commentCharacters.length, emote.position),
		);
		if (position > cursor) {
			fragments.push({
				type: 'text',
				text: commentCharacters.slice(cursor, position).join(''),
			});
		}
		fragments.push({
			type: 'emote',
			text: `:${emote.id}:`,
			emote: { id: emote.id, url: emote.url },
		});

		cursor = position;
		if (
			commentCharacters[cursor] === '\uFFFC' ||
			commentCharacters[cursor] === '\uFFFD'
		) {
			cursor += 1;
		}
	}

	if (cursor < commentCharacters.length) {
		fragments.push({
			type: 'text',
			text: commentCharacters.slice(cursor).join(''),
		});
	}

	return fragments;
}

function normalizeTimestamp(value: unknown) {
	if (typeof value === 'number' || typeof value === 'string') {
		const numericValue = Number(value);
		if (Number.isFinite(numericValue) && numericValue > 0) {
			const milliseconds =
				numericValue < 1_000_000_000_000
					? numericValue * 1000
					: numericValue;
			return new Date(milliseconds).toISOString();
		}

		const date = new Date(value);
		if (!Number.isNaN(date.valueOf())) return date.toISOString();
	}

	return new Date().toISOString();
}

function firstString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value) return value;
		if (typeof value === 'number' && Number.isSafeInteger(value))
			return String(value);
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
