use crate::proto::*;
use serde_json::{Value, json};

/// Preserve the REST event shape consumed by Slime2 and third-party widgets.
/// In particular, protobuf's uint64 values must remain decimal strings in JS.
pub(crate) fn batch(response: LiveChatMessageListResponse) -> Value {
	let mut result = json!({
		"items": response.items.into_iter().filter_map(message).collect::<Vec<_>>()
	});
	if let Some(token) =
		response.next_page_token.filter(|token| !token.is_empty())
	{
		result["nextPageToken"] = token.into();
	}
	if let Some(offline) = response.offline_at.filter(|value| !value.is_empty())
	{
		result["offlineAt"] = offline.into();
	}
	if let Some(poll) = response.active_poll_item.and_then(message) {
		result["activePollItem"] = poll;
	}
	result
}

fn message(value: LiveChatMessage) -> Option<Value> {
	let id = value.id?;
	let source = value.snippet?;
	let mut snippet = json!({
		"type": event_type(source.r#type.unwrap_or_default()),
		"liveChatId": source.live_chat_id.unwrap_or_default(),
		"publishedAt": source.published_at.unwrap_or_default(),
		"hasDisplayContent": source.has_display_content.unwrap_or_default(),
	});
	if let Some(text) = source.display_message {
		snippet["displayMessage"] = text.into();
	}
	if let Some(author) = source.author_channel_id {
		snippet["authorChannelId"] = author.into();
	}
	use live_chat_message_snippet::DisplayedContent as Content;
	match source.displayed_content {
		Some(Content::TextMessageDetails(details)) => {
			snippet["textMessageDetails"] = json!({
				"messageText": details.message_text.unwrap_or_default(),
			})
		}
		Some(Content::UserBannedDetails(details)) => {
			let user = details.banned_user_details.unwrap_or_default();
			snippet["userBannedDetails"] = json!({
				"bannedUserDetails": {
					"channelId": user.channel_id.unwrap_or_default(),
					"channelUrl": user.channel_url.unwrap_or_default(),
					"displayName": user.display_name.unwrap_or_default(),
					"profileImageUrl": user.profile_image_url.unwrap_or_default(),
				},
				"banType": if details.ban_type == Some(2) { "temporary" } else { "permanent" },
			});
			if let Some(seconds) = details.ban_duration_seconds {
				snippet["userBannedDetails"]["banDurationSeconds"] =
					seconds.to_string().into();
			}
		}
		Some(Content::SuperChatDetails(details)) => {
			snippet["superChatDetails"] = json!({
				"amountMicros": details.amount_micros.unwrap_or_default().to_string(),
				"currency": details.currency.unwrap_or_default(),
				"amountDisplayString": details.amount_display_string.unwrap_or_default(),
				"userComment": details.user_comment.unwrap_or_default(),
				"tier": details.tier.unwrap_or_default(),
			})
		}
		Some(Content::SuperStickerDetails(details)) => {
			let sticker = details.super_sticker_metadata.unwrap_or_default();
			snippet["superStickerDetails"] = json!({
				"amountMicros": details.amount_micros.unwrap_or_default().to_string(),
				"currency": details.currency.unwrap_or_default(),
				"amountDisplayString": details.amount_display_string.unwrap_or_default(),
				"tier": details.tier.unwrap_or_default(),
				"superStickerMetadata": {
					"stickerId": sticker.sticker_id.unwrap_or_default(),
					"altText": sticker.alt_text.unwrap_or_default(),
					"language": sticker.alt_text_language.unwrap_or_default(),
				},
			});
		}
		Some(Content::NewSponsorDetails(details)) => {
			snippet["newSponsorDetails"] = json!({
				"memberLevelName": details.member_level_name.unwrap_or_default(),
				"isUpgrade": details.is_upgrade.unwrap_or_default(),
			})
		}
		Some(Content::MemberMilestoneChatDetails(details)) => {
			snippet["memberMilestoneChatDetails"] = json!({
				"memberLevelName": details.member_level_name.unwrap_or_default(),
				"memberMonth": details.member_month.unwrap_or_default(),
				"userComment": details.user_comment.unwrap_or_default(),
			})
		}
		Some(Content::MembershipGiftingDetails(details)) => {
			snippet["membershipGiftingDetails"] = json!({
				"giftMembershipsCount": details.gift_memberships_count.unwrap_or_default(),
				"giftMembershipsLevelName": details.gift_memberships_level_name.unwrap_or_default(),
			})
		}
		Some(Content::GiftMembershipReceivedDetails(details)) => {
			snippet["giftMembershipReceivedDetails"] = json!({
				"memberLevelName": details.member_level_name.unwrap_or_default(),
				"gifterChannelId": details.gifter_channel_id.unwrap_or_default(),
				"associatedMembershipGiftingMessageId": details.associated_membership_gifting_message_id.unwrap_or_default(),
			})
		}
		Some(Content::PollDetails(details)) => {
			let metadata = details.metadata.unwrap_or_default();
			snippet["pollDetails"] = json!({
				"status": match details.status { Some(1) => "active", Some(2) => "closed", _ => "unknown" },
				"metadata": {
					"questionText": metadata.question_text.unwrap_or_default(),
					"options": metadata.options.into_iter().map(|option| json!({
						"optionText": option.option_text.unwrap_or_default(),
						"tally": option.tally.unwrap_or_default().to_string(),
					})).collect::<Vec<_>>(),
				},
			});
		}
		Some(Content::GiftDetails(details)) => {
			snippet["giftEventDetails"] = json!({
				"giftMetadata": {
					"giftName": details.gift_name.unwrap_or_default(),
					"jewelsAmount": details.jewels_amount.unwrap_or_default(),
					"giftUrl": details.gift_url.unwrap_or_default(),
					"altText": details.alt_text.unwrap_or_default(),
					"language": details.language.unwrap_or_default(),
					"hasVisualEffect": details.has_visual_effect.unwrap_or_default(),
				},
				"comboCount": details.combo_count.unwrap_or_default(),
			});
			if let Some(duration) = details.gift_duration {
				snippet["giftEventDetails"]["giftMetadata"]["giftDuration"] =
					format!("{}.{:09}s", duration.seconds, duration.nanos)
						.into();
			}
		}
		None => {}
	}
	let mut result = json!({ "id": id, "snippet": snippet });
	if let Some(author) = value.author_details {
		result["authorDetails"] = json!({
			"channelId": author.channel_id.unwrap_or_default(),
			"channelUrl": author.channel_url.unwrap_or_default(),
			"displayName": author.display_name.unwrap_or_default(),
			"profileImageUrl": author.profile_image_url.unwrap_or_default(),
			"isVerified": author.is_verified.unwrap_or_default(),
			"isChatOwner": author.is_chat_owner.unwrap_or_default(),
			"isChatSponsor": author.is_chat_sponsor.unwrap_or_default(),
			"isChatModerator": author.is_chat_moderator.unwrap_or_default(),
		});
	}
	Some(result)
}

fn event_type(code: i32) -> &'static str {
	match code {
		1 => "textMessageEvent",
		2 => "tombstone",
		3 => "fanFundingEvent",
		4 => "chatEndedEvent",
		5 => "sponsorOnlyModeStartedEvent",
		6 => "sponsorOnlyModeEndedEvent",
		7 => "newSponsorEvent",
		10 => "userBannedEvent",
		15 => "superChatEvent",
		16 => "superStickerEvent",
		17 => "memberMilestoneChatEvent",
		18 => "membershipGiftingEvent",
		19 => "giftMembershipReceivedEvent",
		20 => "pollEvent",
		21 => "giftEvent",
		_ => "unknownEvent",
	}
}
