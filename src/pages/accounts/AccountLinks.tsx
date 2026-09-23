import { useEffect, useRef, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import useAccounts from '@/contexts/accounts/useAccounts';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import {
	ToolButton,
	ToolSection,
	toolInputClass,
	platformNames,
} from '@/components/ToolControls';
import {
	readLinkedIdentities,
	writeLinkedIdentities,
	type LinkedIdentity,
	type LinkEditorDefinition,
} from '@/helpers/accountLinkEditor';
import {
	getSharedWidgetStorage,
	setSharedWidgetStorage,
	broadcastSharedWidgetStorageChange,
} from '@/helpers/json/widgetSharedStorage';
import { resolveWidgetAccounts } from '@/helpers/accountRouting';
import {
	resolveWidgetPlatformUser,
	type UserPlatform,
} from '@/helpers/services/platformUserLookup';
import { safeLogText } from '@/helpers/safeLog';
const platforms: UserPlatform[] = ['twitch', 'youtube', 'tiktok'];
const blank = () => ({ twitch: '', youtube: '', tiktok: '' });
export default function AccountLinks() {
	const widgets = useWidgetMetas(),
		choices = Object.entries(widgets).filter(
			([, m]) => m.storageNamespace && m.accountLinkEditor,
		);
	const [selected, setSelected] = useState(''),
		id = choices.some(([key]) => key === selected)
			? selected
			: choices[0]?.[0];
	return (
		<ToolSection title='Linked viewer accounts'>
			<p>
				Manage viewer identities shared by compatible widgets. Links do
				not verify ownership or grant moderator privileges.
			</p>
			{!id ? (
				<p>
					Install a widget that declares an account-link editor to
					manage its mappings here.
				</p>
			) : (
				<>
					<label>
						Widget
						<select
							className={toolInputClass}
							value={id}
							onChange={e => setSelected(e.target.value)}
						>
							{choices.map(([key, m]) => (
								<option key={key} value={key}>
									{m.name} · {key}
								</option>
							))}
						</select>
					</label>
					<LinkCollection
						key={id}
						widgetId={id}
						definition={widgets[id]!.accountLinkEditor!}
					/>
				</>
			)}
		</ToolSection>
	);
}
function LinkCollection({
	widgetId,
	definition,
}: {
	widgetId: string;
	definition: LinkEditorDefinition;
}) {
	const widgets = useWidgetMetas(),
		accounts = useAccounts(),
		alive = useRef(true);
	const [rows, setRows] = useState<LinkedIdentity[]>([]),
		[revision, setRevision] = useState<number>(),
		[selected, setSelected] = useState<string>();
	const [search, setSearch] = useState(''),
		[identity, setIdentity] = useState(''),
		[inputs, setInputs] = useState(blank),
		[busy, setBusy] = useState(false),
		[message, setMessage] = useState('');
	function edit(row?: LinkedIdentity) {
		setSelected(row?.id);
		setIdentity(row?.id ?? '');
		setInputs(
			Object.fromEntries(
				platforms.map(p => [
					p,
					row?.accounts
						.filter(a => a.platform === p)
						.map(a => a.account)
						.join(', ') ?? '',
				]),
			) as ReturnType<typeof blank>,
		);
	}
	async function load() {
		setBusy(true);
		setMessage('');
		try {
			const result = await getSharedWidgetStorage(
				widgetId,
				'persistent',
				definition.key,
			);
			if (!alive.current) return;
			setRows(readLinkedIdentities(result.value, definition));
			setRevision(result.revision);
			edit();
		} catch (error) {
			if (alive.current) setMessage(safeLogText(error));
		} finally {
			if (alive.current) setBusy(false);
		}
	}
	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
		};
	}, [widgetId]);
	async function persist(next: LinkedIdentity[]) {
		const values = writeLinkedIdentities(next, definition),
			saved = await setSharedWidgetStorage(
				widgetId,
				'persistent',
				definition.key,
				JSON.stringify(values),
				'compare-and-set',
				undefined,
				revision,
			);
		if (saved.conflict)
			throw Error(
				'Links changed in another layout or command. Reload before saving; your draft has not overwritten them.',
			);
		await broadcastSharedWidgetStorageChange(saved);
		if (!alive.current) return;
		setRows(readLinkedIdentities(saved.value, definition));
		setRevision(saved.revision);
		edit();
		setMessage('Saved for all widgets sharing this namespace.');
	}
	async function save() {
		if (busy || revision === undefined) return;
		setBusy(true);
		setMessage('');
		try {
			const id = identity.trim().toLowerCase();
			if (!/^[a-z0-9_-]{1,80}$/.test(id))
				throw Error(
					'Use an identity key of 1–80 letters, numbers, underscores or hyphens.',
				);
			if (!selected && rows.some(row => row.id.toLowerCase() === id))
				throw Error('Select the existing identity to edit it.');
			const resolved: LinkedIdentity['accounts'] = [];
			for (const platform of platforms) {
				const tokens = inputs[platform]
					.split(',')
					.map(v => v.trim())
					.filter(Boolean);
				if (tokens.length > 16)
					throw Error('Use at most 16 accounts per platform.');
				for (const token of tokens) {
					const isId =
						platform === 'youtube'
							? /^UC[-_a-zA-Z0-9]{22}$/.test(token)
							: /^\d{1,32}$/.test(token);
					let account = token;
					if (!isId) {
						const assigned = resolveWidgetAccounts(
							widgetId,
							widgets[widgetId]!,
							accounts,
						).find(
							a => a?.type === 'read' && a.service === platform,
						);
						if (!assigned)
							throw Error(
								`Assign a connected ${platform} read account to look up usernames.`,
							);
						account = (
							await resolveWidgetPlatformUser(
								widgetId,
								accounts,
								{
									account_id: assigned.id,
									platform,
									username: token,
								},
							)
						).id;
					}
					resolved.push({ platform, account });
				}
			}
			if (!resolved.length)
				throw Error('Add a platform account, or use Unlink identity.');
			await persist([
				...rows.filter(row => row.id !== selected),
				{
					id,
					accounts: resolved,
					original:
						rows.find(row => row.id === selected)?.original ?? {},
				},
			]);
		} catch (error) {
			if (alive.current) setMessage(safeLogText(error));
		} finally {
			if (alive.current) setBusy(false);
		}
	}
	async function unlink() {
		if (busy || !selected) return;
		setBusy(true);
		try {
			if (
				await confirm(
					`Unlink all platform accounts from ${selected}? Its saved widget data will remain.`,
					{ title: 'Unlink identity', kind: 'warning' },
				)
			)
				await persist(rows.filter(row => row.id !== selected));
		} catch (error) {
			if (alive.current) setMessage(safeLogText(error));
		} finally {
			if (alive.current) setBusy(false);
		}
	}
	return (
		<div className='flex flex-col gap-3'>
			<div className='flex gap-2'>
				<input
					aria-label='Search linked accounts'
					placeholder='Search identities, platforms or IDs'
					className={toolInputClass}
					value={search}
					onChange={e => setSearch(e.target.value)}
				/>
				<ToolButton disabled={busy} onClick={() => void load()}>
					Reload
				</ToolButton>
			</div>
			<div className='max-h-48 overflow-y-auto rounded-1 border border-zinc-200'>
				{rows
					.filter(row =>
						`${row.id} ${row.accounts.map(a => `${a.platform}:${a.account}`).join(' ')}`
							.toLowerCase()
							.includes(search.toLowerCase()),
					)
					.map(row => (
						<button
							key={row.id}
							disabled={busy}
							onClick={() => edit(row)}
							className={`block w-full border-b border-zinc-200 p-2 text-left ${selected === row.id ? 'bg-lime-100' : ''}`}
						>
							<strong>{row.id}</strong>
							<span className='block text-3.5 break-all'>
								{row.accounts
									.map(a => `${a.platform}:${a.account}`)
									.join(' · ')}
							</span>
						</button>
					))}
				{!rows.length && (
					<p className='p-2'>No saved linked identities.</p>
				)}
			</div>
			<ToolButton disabled={busy} onClick={() => edit()}>
				New identity
			</ToolButton>
			<label>
				Identity key
				<input
					className={toolInputClass}
					maxLength={80}
					disabled={busy || !!selected}
					value={identity}
					onChange={e => setIdentity(e.target.value)}
				/>
			</label>
			{platforms.map(platform => (
				<label key={platform}>
					{platformNames[platform]} usernames or IDs (comma separated)
					<input
						className={toolInputClass}
						disabled={busy}
						value={inputs[platform]}
						onChange={e =>
							setInputs({ ...inputs, [platform]: e.target.value })
						}
					/>
				</label>
			))}
			<p className='text-3.5'>
				Use @ for an all-numeric username. Identity keys stay fixed to
				preserve saved widget data.
			</p>
			<div className='flex gap-2'>
				<ToolButton
					disabled={busy || revision === undefined}
					onClick={() => void save()}
				>
					Resolve and save links
				</ToolButton>
				{selected && (
					<ToolButton disabled={busy} onClick={() => void unlink()}>
						Unlink identity
					</ToolButton>
				)}
			</div>
			{message && <p role='status'>{message}</p>}
		</div>
	);
}
