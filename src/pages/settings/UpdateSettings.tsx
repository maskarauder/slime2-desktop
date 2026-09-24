import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSettings } from '@/contexts/settings/useSettings';
import useAppVersionQuery from '@/hooks/useAppVersionQuery';
import {
	ToolSection,
	ToolButton,
	toolInputClass,
} from '@/components/ToolControls';
import {
	checkForUpdate,
	getAvailableUpdate,
	subscribeUpdates,
	type UpdateChannel,
} from '@/helpers/updates';
import {
	getUpdateInstallation,
	installationBusy,
	installUpdate,
	subscribeInstallation,
} from '@/helpers/updateInstallation';
import { useUpdateSupport } from '@/hooks/useUpdateSupport';
import { openUrl } from '@/helpers/commands';
import { safeLogText } from '@/helpers/safeLog';
export default function UpdateSettings() {
	const { settings, setSettings } = useSettings(),
		version = useAppVersionQuery().data;
	const update = useSyncExternalStore(subscribeUpdates, getAvailableUpdate),
		installation = useSyncExternalStore(
			subscribeInstallation,
			getUpdateInstallation,
		),
		{ data: support, error: supportError } = useUpdateSupport();
	const installing = installationBusy(installation);
	const [busy, setBusy] = useState(false),
		[message, setMessage] = useState(''),
		[link, setLink] = useState<string>();
	const active = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			active.current?.abort();
			active.current = null;
		},
		[],
	);
	async function check() {
		if (!version || active.current || installing) return;
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setLink(undefined);
		setMessage('Checking GitHub releases…');
		try {
			const result = await checkForUpdate(
				version,
				settings.updateChannel,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			setMessage(
				!result.release
					? 'No published release with downloads was found on this channel.'
					: result.newer
						? `Version ${result.release.tag_name} is available.`
						: 'You are up to date on this channel.',
			);
			if (result.newer) setLink(result.release?.html_url);
		} catch (error) {
			if (!controller.signal.aborted) setMessage(safeLogText(error));
		} finally {
			if (active.current === controller) {
				active.current = null;
				setBusy(false);
			}
		}
	}
	return (
		<ToolSection title='Updates'>
			<label>
				Release channel
				<select
					className={toolInputClass}
					disabled={busy || installing}
					value={settings.updateChannel}
					onChange={e => {
						setSettings({
							...settings,
							updateChannel: e.target.value as UpdateChannel,
						});
						setLink(undefined);
						setMessage('');
					}}
				>
					<option value='stable'>Stable</option>
					<option value='test'>Test (includes prereleases)</option>
				</select>
			</label>
			<label className='flex items-center gap-2'>
				<input
					type='checkbox'
					checked={
						settings.checkUpdatesOnStart ||
						settings.autoInstallUpdates
					}
					disabled={installing || settings.autoInstallUpdates}
					onChange={e =>
						setSettings({
							...settings,
							checkUpdatesOnStart: e.target.checked,
						})
					}
				/>
				Check once when Slime2 starts
			</label>
			<label className='flex items-center gap-2'>
				<input
					type='checkbox'
					checked={settings.autoInstallUpdates}
					disabled={
						installing ||
						(!support?.supported && !settings.autoInstallUpdates)
					}
					onChange={e =>
						setSettings({
							...settings,
							autoInstallUpdates: e.target.checked,
							checkUpdatesOnStart:
								e.target.checked ||
								settings.checkUpdatesOnStart,
						})
					}
				/>
				Automatically install the latest update at startup
			</label>
			<p className='text-3.5'>
				Takes effect next launch. Updates use the selected release
				channel and restart Slime2, briefly interrupting chat and
				widgets. Windows may request administrator approval.
			</p>
			{!support?.supported && (
				<p className='text-3.5'>
					{support?.reason ??
						(supportError
							? 'Unable to check automatic installation support.'
							: 'Checking automatic installation support…')}
				</p>
			)}
			<div className='flex gap-2'>
				<ToolButton
					disabled={busy || installing || !version}
					onClick={() => void check()}
				>
					Check for updates
				</ToolButton>
				{update?.channel === settings.updateChannel &&
					update.hasManifest &&
					support?.supported && (
						<ToolButton
							disabled={busy || installing}
							onClick={() => void installUpdate(update)}
						>
							Install and restart
						</ToolButton>
					)}
				{link && (
					<ToolButton
						onClick={() =>
							void openUrl(link).catch(e =>
								setMessage(safeLogText(e)),
							)
						}
					>
						Open release downloads
					</ToolButton>
				)}
			</div>
			{message && <p role='status'>{message}</p>}
			{installation.phase !== 'idle' && (
				<p role='status'>{installation.message}</p>
			)}
		</ToolSection>
	);
}
