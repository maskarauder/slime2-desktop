import type { Account, Accounts } from './json/accounts';
import type { WidgetMeta } from './json/widgetMeta';

export function resolveWidgetAccounts(
	widgetId: string,
	meta: WidgetMeta,
	accounts: Accounts,
): (Account | null)[] {
	return meta.accounts.map((slot, index) => {
		const compatible = Object.values(accounts).filter(
			account =>
				account.service === slot.service && account.type === slot.type,
		);
		// Never silently route a different channel when an explicit account needs
		// reauthorization. Wait for that selection to be repaired or removed.
		const selected = compatible.find(
			account => account.widgets[widgetId] === index,
		);
		if (selected) return selected.reauthorize ? null : selected;
		return (
			compatible.find(
				account => account.default && !account.reauthorize,
			) ?? null
		);
	});
}

export function relatedWidgetIds(
	account: Account,
	accounts: Accounts,
	metas: Record<string, WidgetMeta>,
): string[] {
	return Object.entries(metas)
		.filter(([id, meta]) =>
			resolveWidgetAccounts(id, meta, accounts).some(
				selected => selected?.id === account.id,
			),
		)
		.map(([id]) => id);
}
