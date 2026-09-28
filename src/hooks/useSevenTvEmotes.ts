import useAccounts from '@/contexts/accounts/useAccounts';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import { relatedWidgetIds } from '@/helpers/accountRouting';
import sevenTvApi, {
	type SevenTvUpdate,
} from '@/helpers/services/emotes/sevenTV';
import { sendEmoteCatalogUpdate } from '@/helpers/widgetMessage';
import { useEffect, useRef } from 'react';

/** One app-owned catalog connection, shared by every assigned widget. */
export default function useSevenTvEmotes() {
	const accounts = useAccounts();
	const widgetMetas = useWidgetMetas();
	const latest = useRef({ accounts, widgetMetas });
	latest.current = { accounts, widgetMetas };

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const pending = new Map<string, SevenTvUpdate>();
		const unsubscribe = sevenTvApi.subscribe(update => {
			pending.set(`${update.platform}:${update.serviceId}`, update);
			if (timer !== undefined) return;
			// Coalesce a burst of edits into one replacement per catalog/layout.
			timer = setTimeout(() => {
				timer = undefined;
				const updates = [...pending.values()];
				pending.clear();
				const { accounts: currentAccounts, widgetMetas: currentMetas } =
					latest.current;
				for (const update of updates) {
					for (const account of Object.values(currentAccounts)) {
						if (
							account.type !== 'read' ||
							account.reauthorize ||
							account.service !== update.platform ||
							account.serviceId !== update.serviceId
						)
							continue;
						for (const widgetId of relatedWidgetIds(
							account,
							currentAccounts,
							currentMetas,
						)) {
							void sendEmoteCatalogUpdate(widgetId, {
								provider: 'seventv',
								platform: update.platform,
								account_id: account.id,
								emotes: update.emotes,
								revision: update.revision,
							}).catch(() => {
								console.warn(
									'Unable to deliver a 7TV catalog update; the widget will reload its catalog on reconnect.',
								);
							});
						}
					}
				}
			}, 50);
		});
		return () => {
			unsubscribe();
			clearTimeout(timer);
			pending.clear();
			sevenTvApi.dispose();
		};
	}, []);

	useEffect(() => {
		sevenTvApi.setAccounts(
			Object.values(accounts).flatMap(account =>
				account.type === 'read' &&
				!account.reauthorize &&
				(account.service === 'twitch' ||
					account.service === 'youtube') &&
				relatedWidgetIds(account, accounts, widgetMetas).length > 0
					? [
							{
								id: account.id,
								service: account.service,
								serviceId: account.serviceId,
							},
						]
					: [],
			),
		);
	}, [accounts, widgetMetas]);
}
