import type { WidgetMeta } from './json/widgetMeta';
import type { Accounts } from './json/accounts';

export type WidgetAccountSlots = Record<string, Record<string, number>>;

export function widgetAccountSlotMap(oldMeta: WidgetMeta, newMeta: WidgetMeta) {
	const oldSlots = oldMeta.accounts,
		newSlots = newMeta.accounts;
	for (const slots of [oldSlots, newSlots]) {
		const ids = slots.flatMap(slot => (slot.id ? [slot.id] : []));
		if (new Set(ids).size !== ids.length)
			throw new Error('Widget account slot IDs must be unique.');
	}
	return oldSlots.map((old, index) => {
		const candidates = newSlots.flatMap((slot, i) =>
			slot.service === old.service && slot.type === old.type ? [i] : [],
		);
		if (old.id) {
			const found = newSlots.findIndex(slot => slot.id === old.id);
			if (found >= 0) {
				if (!candidates.includes(found))
					throw new Error(
						`Account slot ${old.id} changed platform or account type.`,
					);
				return found;
			}
			return null;
		}
		if (!candidates.length) return null;
		const previous = oldSlots.filter(
			slot => slot.service === old.service && slot.type === old.type,
		);
		if (previous.length === 1 && candidates.length === 1)
			return candidates[0]!;
		// Legacy duplicate slots have no identity beyond their index. Only an
		// unchanged list can preserve those assignments without guessing.
		if (JSON.stringify(oldSlots) === JSON.stringify(newSlots)) return index;
		throw new Error(
			'This package changes duplicate legacy account slots whose identities cannot be matched safely. Keep their definitions unchanged for this upgrade.',
		);
	});
}

/** Apply only the affected widget assignments to the latest account metadata. */
export function replaceWidgetAccountSlots(
	accounts: Accounts,
	slots: WidgetAccountSlots,
): Accounts {
	const result = structuredClone(accounts);
	for (const [widgetId, assignments] of Object.entries(slots)) {
		for (const account of Object.values(result)) {
			delete account.widgets[widgetId];
			const index = assignments[account.id];
			if (Number.isSafeInteger(index) && index! >= 0)
				account.widgets[widgetId] = index!;
		}
	}
	return result;
}
