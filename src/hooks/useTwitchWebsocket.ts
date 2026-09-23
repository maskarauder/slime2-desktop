import useAccounts from '@/contexts/accounts/useAccounts';
import { useAccountsDispatch } from '@/contexts/accounts/useAccountsDispatch';
import { useEventsLogDispatch } from '@/contexts/events_log/useEventsLogDispatch';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import { relatedWidgetIds } from '@/helpers/accountRouting';
import { getEventLogId } from '@/helpers/json/eventsLog';
import twitchAuth, {
	TwitchReauthorizationError,
} from '@/helpers/services/twitch/twitchAuth';
import { startTwitchSession } from '@/helpers/services/twitch/twitchSession';
import { sendTwitchEvent } from '@/helpers/widgetMessage';
import { safeLogText } from '@/helpers/safeLog';
import { useEffect, useRef } from 'react';
import { beginConnection } from '@/helpers/connectionStatus';
import { useReconnectRequest } from './useReconnectRequest';

export default function useTwitchWebsocket() {
	const accounts = useAccounts();
	const widgetMetas = useWidgetMetas();
	const { addAccount: updateAccount } = useAccountsDispatch();
	const { logEvent } = useEventsLogDispatch();
	const latest = useRef({ accounts, widgetMetas, updateAccount, logEvent });
	latest.current = { accounts, widgetMetas, updateAccount, logEvent };
	const sessions = useRef(new Map<string, { stop: () => void }>());
	const reconnectRevision = useReconnectRequest(id => {
		if (latest.current.accounts[id]?.service !== 'twitch') return false;
		sessions.current.get(id)?.stop();
		sessions.current.delete(id);
		return true;
	});
	function reauthorize(id: string) {
		const account = latest.current.accounts[id];
		if (account && !account.reauthorize)
			latest.current.updateAccount({ ...account, reauthorize: true });
	}
	async function notification(
		id: string,
		notificationMessage: Twitch.WebsocketMessage.Notification,
	) {
		const account = latest.current.accounts[id];
		if (!account || account.reauthorize) return;
		const related = relatedWidgetIds(
			account,
			latest.current.accounts,
			latest.current.widgetMetas,
		);
		const { subscription_type, message_timestamp: timestamp } =
			notificationMessage.metadata;
		const { event } = notificationMessage.payload;
		const eventLogId = getEventLogId(account);
		const logEvent = latest.current.logEvent;
		switch (subscription_type) {
			case 'channel.follow': {
				const followEvent = event as Twitch.WebsocketEvent.Follow;
				logEvent(eventLogId, {
					type: 'follow',
					timestamp,
					data: {
						user_id: followEvent.user_id,
						user_login: followEvent.user_login,
						user_name: followEvent.user_name,
					},
				});
				break;
			}

			case 'channel.subscribe': {
				const subEvent = event as Twitch.WebsocketEvent.Subscribe;

				// don't log individual subs from a gift sub
				if (!subEvent.is_gift) {
					logEvent(eventLogId, {
						type: 'sub',
						timestamp,
						data: {
							user_id: subEvent.user_id,
							user_login: subEvent.user_login,
							user_name: subEvent.user_name,
							tier: subEvent.tier,
						},
					});
				}
				break;
			}

			case 'channel.subscription.message': {
				const resubEvent =
					event as Twitch.WebsocketEvent.SubscriptionMessage;

				logEvent(eventLogId, {
					type: 'resub',
					timestamp,
					data: {
						user_id: resubEvent.user_id,
						user_login: resubEvent.user_login,
						user_name: resubEvent.user_name,
						tier: resubEvent.tier,
						cumulative_months: resubEvent.cumulative_months,
						streak_months: resubEvent.streak_months,
					},
				});
				break;
			}

			case 'channel.subscription.gift': {
				const subGiftEvent =
					event as Twitch.WebsocketEvent.SubscriptionGift;

				logEvent(eventLogId, {
					type: 'sub_gift',
					timestamp,
					data: {
						user_id: subGiftEvent.user_id,
						user_login: subGiftEvent.user_login,
						user_name: subGiftEvent.user_name,
						is_anonymous: subGiftEvent.is_anonymous,
						tier: subGiftEvent.tier,
						total: subGiftEvent.total,
						cumulative_total: subGiftEvent.cumulative_total,
					},
				});
				break;
			}

			case 'channel.raid': {
				const raidEvent = event as Twitch.WebsocketEvent.Raid;
				logEvent(eventLogId, {
					type: 'raid',
					timestamp,
					data: {
						user_id: raidEvent.from_broadcaster_user_id,
						user_login: raidEvent.from_broadcaster_user_login,
						user_name: raidEvent.from_broadcaster_user_name,
						viewers: raidEvent.viewers,
					},
				});

				break;
			}

			case 'channel.cheer': {
				const cheerEvent = event as Twitch.WebsocketEvent.Cheer;
				logEvent(eventLogId, {
					type: 'cheer',
					timestamp,
					data: {
						user_id: cheerEvent.user_id,
						user_login: cheerEvent.user_login,
						user_name: cheerEvent.user_name,
						bits: cheerEvent.bits,
					},
				});

				break;
			}
		}
		await Promise.all(
			related.map(widgetId =>
				sendTwitchEvent(
					account.id,
					widgetId,
					notificationMessage.metadata.message_id,
					subscription_type,
					notificationMessage.metadata.subscription_version,
					timestamp,
					event,
				),
			),
		);
	}
	useEffect(() => {
		const needed = Object.values(accounts).filter(
			account =>
				!account.reauthorize &&
				account.service === 'twitch' &&
				account.type === 'read' &&
				relatedWidgetIds(account, accounts, widgetMetas).length,
		);
		const ids = new Set(needed.map(account => account.id));
		for (const [id, session] of sessions.current)
			if (!ids.has(id)) {
				session.stop();
				sessions.current.delete(id);
			}
		for (const account of needed) {
			if (sessions.current.has(account.id)) continue;
			const status = beginConnection(account.id);
			const session = startTwitchSession({
				account,
				onStatus: status.update,
				onNotification: message => notification(account.id, message),
				onReauthorize: () => reauthorize(account.id),
			});
			sessions.current.set(account.id, {
				stop() {
					session.stop();
					status.dispose();
				},
			});
		}
	}, [accounts, widgetMetas, reconnectRevision]);
	// Validate on startup and during quiet chats; failures are retried without deleting credentials.
	useEffect(() => {
		let disposed = false;
		let running = false;
		async function validate() {
			if (running || disposed) return;
			running = true;
			try {
				for (const account of Object.values(latest.current.accounts)) {
					if (disposed) break;
					if (account.service !== 'twitch' || account.reauthorize)
						continue;
					try {
						await twitchAuth.getValidTokens(account.id);
					} catch (error) {
						if (disposed) break;
						if (error instanceof TwitchReauthorizationError)
							reauthorize(account.id);
						else
							console.warn(
								'Twitch token validation will retry:',
								account.id,
								safeLogText(error),
							);
					}
				}
			} finally {
				running = false;
			}
		}
		void validate();
		const timer = setInterval(() => void validate(), 60_000);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, []);
	useEffect(() => {
		const active = sessions.current;
		return () => {
			for (const session of active.values()) session.stop();
			active.clear();
		};
	}, []);
}
