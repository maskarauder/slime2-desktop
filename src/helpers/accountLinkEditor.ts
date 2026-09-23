import type { WidgetMeta } from './json/widgetMeta';
import type { UserPlatform } from './services/platformUserLookup';
export type LinkEditorDefinition = NonNullable<WidgetMeta['accountLinkEditor']>;
export type LinkedIdentity = {
	id: string;
	accounts: { platform: UserPlatform; account: string }[];
	original: Record<string, unknown>;
};
export function readLinkedIdentities(
	value: unknown,
	definition: LinkEditorDefinition,
): LinkedIdentity[] {
	if (value === null) return [];
	if (!Array.isArray(value) || value.length > 1000)
		throw Error(
			'Invalid account-link collection. Existing data was not changed.',
		);
	const ids = new Set<string>(),
		owners = new Map<string, string>();
	return value.map(raw => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			throw Error('Invalid account-link record.');
		const id = raw[definition.idField];
		if (
			typeof id !== 'string' ||
			!/^[a-z0-9_-]{1,80}$/i.test(id) ||
			ids.has(id.toLowerCase())
		)
			throw Error(
				'Identity keys must be unique and use letters, numbers, underscores or hyphens.',
			);
		ids.add(id.toLowerCase());
		if (!Array.isArray(raw[definition.accountsField]))
			throw Error('Invalid linked-account list.');
		const accounts = raw[definition.accountsField].map(
			(entry: Record<string, unknown>) => {
				const platform = entry?.[
						definition.platformField
					] as UserPlatform,
					account = entry?.[definition.accountField];
				if (
					!['twitch', 'youtube', 'tiktok'].includes(platform) ||
					typeof account !== 'string' ||
					!account ||
					account.length > 200 ||
					/[\s|]/.test(account)
				)
					throw Error('Invalid linked platform account.');
				const alias = `${platform}:${platform === 'youtube' ? account : account.toLowerCase()}`,
					owner = owners.get(alias);
				if (owner && owner !== id.toLowerCase())
					throw Error(
						`${platform}:${account} is already linked to ${owner}.`,
					);
				owners.set(alias, id.toLowerCase());
				return { platform, account };
			},
		);
		return { id, accounts, original: raw };
	});
}
export function writeLinkedIdentities(
	rows: LinkedIdentity[],
	definition: LinkEditorDefinition,
) {
	const values = rows.map(row => ({
		...row.original,
		[definition.idField]: row.id,
		[definition.accountsField]: row.accounts.map(a => ({
			[definition.platformField]: a.platform,
			[definition.accountField]: a.account,
		})),
	}));
	readLinkedIdentities(values, definition);
	return values;
}
