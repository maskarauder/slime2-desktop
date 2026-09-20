import useAccounts from '@/contexts/accounts/useAccounts';
import { useSettings } from '@/contexts/settings/useSettings';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import { resolveWidgetAccounts } from '@/helpers/accountRouting';
import { loadWidgetSettings } from '@/helpers/json/widgetSettings';
import { loadWidgetValues } from '@/helpers/json/widgetValues';
import {
	sendLogEvents,
	sendWidgetAccounts,
	sendWidgetValues,
} from '@/helpers/widgetMessage';
import logZodError from '@/helpers/zodError';
import { loadTileMeta } from '@@/json/tileMeta';
import { loadWidgetMeta } from '@@/json/widgetMeta';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod/mini';

export default function useWidgetRegistration() {
	const { settings } = useSettings();
	const logWidgetEvents = settings.devMode && settings.logWidgetEvents;
	const accounts = useAccounts();
	const widgetMetas = useWidgetMetas();
	const [registeredWidgets, setRegisteredWidgets] = useState(
		new Set<string>(),
	);
	const latest = useRef({ accounts, logWidgetEvents });
	latest.current = { accounts, logWidgetEvents };

	// sends widget values upon webhook registration / bot connection
	useEffect(() => {
		let disposed = false;
		async function registerWidget(widgetId: string) {
			const [settings, values, widgetMeta, tileMeta] = await Promise.all([
				loadWidgetSettings(widgetId),
				loadWidgetValues(widgetId),
				loadWidgetMeta(widgetId),
				loadTileMeta(widgetId),
			]);

			if (disposed) return;
			if (latest.current.logWidgetEvents) {
				await sendLogEvents(widgetId, true);
			}

			console.info(
				`${tileMeta.name}${widgetMeta.name !== tileMeta.name ? ` (${widgetMeta.name} v${widgetMeta.version})` : ''}: Widget connected`,
			);

			await sendWidgetValues(widgetId, settings, values);
			await sendWidgetAccounts(
				widgetId,
				resolveWidgetAccounts(
					widgetId,
					widgetMeta,
					latest.current.accounts,
				).map(
					account =>
						account && {
							id: account.id,
							type: account.type,
							service: account.service,
							serviceId: account.serviceId,
							username: account.username,
							displayName: account.displayName,
						},
				),
			);
			if (!disposed)
				setRegisteredWidgets(
					previous => new Set([...previous, widgetId]),
				);
		}

		// registration from bot
		function botRegistrationListener(
			event: CustomEventInit<{ widgetId: string }>,
		) {
			if (!event.detail?.widgetId) return;
			void registerWidget(event.detail.widgetId).catch(error =>
				logZodError(error, {}),
			);
		}

		addEventListener('bot-registration', botRegistrationListener);

		// registration from overlay
		const unlistenPromise =
			getCurrentWebviewWindow().listen<WidgetRegistration>(
				'websocket-registration',
				async event => {
					try {
						// just in case payload isn't formatted correctly
						const { id: widgetId } = WidgetRegistration.parse(
							event.payload,
						);
						await registerWidget(widgetId);
					} catch (error) {
						logZodError(error, event.payload);
					}
				},
			);

		return () => {
			disposed = true;
			removeEventListener('bot-registration', botRegistrationListener);

			unlistenPromise
				.then(unlisten => {
					if (unlisten) unlisten();
				})
				.catch(error => logZodError(error));
		};
	}, []);

	useEffect(() => {
		registeredWidgets.forEach(widgetId => {
			void sendLogEvents(widgetId, logWidgetEvents).catch(error =>
				logZodError(error),
			);
		});
	}, [settings.devMode, logWidgetEvents, registeredWidgets]);

	useEffect(() => {
		async function sendAllAccountData() {
			await Promise.all(
				[...registeredWidgets.values()].map(async widgetId => {
					const meta = widgetMetas[widgetId];
					if (!meta || !meta.accounts || meta.accounts.length === 0) {
						return;
					}

					const slottedAccounts = resolveWidgetAccounts(
						widgetId,
						meta,
						accounts,
					);

					const widgetAccountsData = await Promise.all(
						slottedAccounts.map(async account => {
							if (!account) return null;

							const accountData = {
								id: account.id,
								type: account.type,
								service: account.service,
								serviceId: account.serviceId,
								username: account.username,
								displayName: account.displayName,
							};

							if (
								account.type !== 'read' ||
								account.service !== 'twitch'
							) {
								return accountData;
							}

							return {
								...accountData,
								//* disable eventsLog for now
								// eventsLog: eventsLog[getEventLogId(account)] || [],
							};
						}),
					);

					if (widgetAccountsData.length > 0) {
						await sendWidgetAccounts(widgetId, widgetAccountsData);
					}
				}),
			);
		}

		void sendAllAccountData().catch(error => logZodError(error, {}));
	}, [registeredWidgets, accounts, widgetMetas]);
}

const WidgetRegistration = z.object({ id: z.string() });
type WidgetRegistration = z.infer<typeof WidgetRegistration>;
