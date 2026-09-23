import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save, confirm } from '@tauri-apps/plugin-dialog';
import { ToolButton, ToolSection } from '@/components/ToolControls';
import useAccounts from '@/contexts/accounts/useAccounts';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import useAppVersionQuery from '@/hooks/useAppVersionQuery';
import { saveJson } from '@/helpers/commands';
import { buildDiagnostics } from '@/helpers/diagnostics';
import { flushQueuedSaves } from '@/helpers/json/queueSaveJson';
import { safeLogText } from '@/helpers/safeLog';
export default function DataTools() {
	const accounts = useAccounts(),
		widgets = useWidgetMetas(),
		version = useAppVersionQuery().data ?? 'unknown';
	const [busy, setBusy] = useState(false),
		[message, setMessage] = useState('');
	async function run(task: () => Promise<void>) {
		if (busy) return;
		setBusy(true);
		setMessage('');
		try {
			await task();
		} catch (e) {
			setMessage(safeLogText(e));
		} finally {
			setBusy(false);
		}
	}
	async function diagnostics() {
		const destination = await save({
			title: 'Export diagnostics',
			defaultPath: 'slime2-diagnostics.json',
			filters: [{ name: 'JSON', extensions: ['json'] }],
		});
		if (!destination) return;
		const logs = await invoke<string>('read_recent_log');
		await saveJson(
			buildDiagnostics(version, accounts, widgets, logs),
			destination,
		);
		setMessage('Diagnostics exported.');
	}
	async function backup() {
		const destination = await save({
			title: 'Save Slime2 backup',
			defaultPath: 'slime2-backup.zip',
			filters: [{ name: 'Slime2 backup', extensions: ['zip'] }],
		});
		if (!destination) return;
		await flushQueuedSaves();
		await invoke('export_app_backup', { destination });
		setMessage(
			'Backup saved. Keep this file private; it includes your widget configuration and media.',
		);
	}
	async function restore() {
		const source = await open({
			title: 'Restore Slime2 backup',
			multiple: false,
			directory: false,
			filters: [{ name: 'Slime2 backup', extensions: ['zip'] }],
		});
		if (typeof source !== 'string') return;
		const preview = await invoke<{
			token: string;
			files: number;
			bytes: number;
			appVersion: string;
		}>('preview_app_restore', { source });
		const accepted = await confirm(
			`Restore ${preview.files} files (${(preview.bytes / 1024 / 1024).toFixed(1)} MiB) from Slime2 ${preview.appVersion}?\n\nThis replaces current widgets, configuration and media, then restarts Slime2. Make a backup first to keep the current setup. You must sign in to restored accounts again. Only restore backups you trust; widgets contain executable scripts.`,
			{ title: 'Restore and restart?', kind: 'warning' },
		);
		if (!accepted) {
			await invoke('cancel_app_restore', { token: preview.token });
			return;
		}
		await flushQueuedSaves();
		await invoke('restore_app_backup', { token: preview.token });
	}
	return (
		<>
			<ToolSection title='Diagnostics'>
				<p>
					Export recent logs, connection states, app version and
					installed widget versions. Credentials and widget settings
					are excluded. Logs can contain usernames or chat text;
					review the file before sharing.
				</p>
				<ToolButton
					disabled={busy}
					onClick={() => void run(diagnostics)}
				>
					Export diagnostics
				</ToolButton>
			</ToolSection>
			<ToolSection title='Backup and restore'>
				<p>
					Includes widgets, settings, layouts, media, account
					assignments and persistent shared data. Sign-in credentials
					stay in the OS credential store. Avoid editing widgets while
					a backup is being created.
				</p>
				<div className='flex flex-wrap gap-2'>
					<ToolButton
						disabled={busy}
						onClick={() => void run(backup)}
					>
						Create backup
					</ToolButton>
					<ToolButton
						disabled={busy}
						onClick={() => void run(restore)}
					>
						Restore backup…
					</ToolButton>
				</div>
			</ToolSection>
			{busy && <p role='status'>Working…</p>}
			{message && (
				<p role='status' className='rounded-1 bg-white p-3'>
					{message}
				</p>
			)}
		</>
	);
}
