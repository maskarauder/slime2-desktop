import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSettings } from '@/contexts/settings/useSettings';
import useAppVersionQuery from '@/hooks/useAppVersionQuery';
import { useSettingsQuery } from '@/hooks/useSettingsQuery';
import { useUpdateSupport } from '@/hooks/useUpdateSupport';
import { getAvailableUpdate, subscribeUpdates } from '@/helpers/updates';
import {
	getUpdateInstallation,
	installationBusy,
	installUpdate,
	runStartupUpdate,
	subscribeInstallation,
} from '@/helpers/updateInstallation';
import { openUrl } from '@/helpers/commands';
import { safeLogText } from '@/helpers/safeLog';
export default function UpdateNotice() {
	const { settings } = useSettings(),
		{ data: savedSettings } = useSettingsQuery(),
		version = useAppVersionQuery().data,
		{ data: support } = useUpdateSupport();
	const update = useSyncExternalStore(subscribeUpdates, getAvailableUpdate),
		installation = useSyncExternalStore(
			subscribeInstallation,
			getUpdateInstallation,
		),
		[dismissed, setDismissed] = useState(''),
		attempted = useRef(false);
	const busy = installationBusy(installation);
	useEffect(() => {
		if (!version || !savedSettings || attempted.current) return;
		const controller = new AbortController();
		void Promise.resolve().then(async () => {
			if (controller.signal.aborted) return;
			attempted.current = true;
			try {
				// Use settings loaded at launch. Changing the checkbox takes effect
				// next launch, rather than interrupting an ongoing stream.
				await runStartupUpdate(
					version,
					savedSettings,
					controller.signal,
				);
			} catch (error) {
				if (!controller.signal.aborted)
					console.warn('Update check:', safeLogText(error));
			}
		});
		return () => controller.abort();
	}, [version, savedSettings]);
	const visibleUpdate =
		update?.channel === settings.updateChannel ? update : null;
	if (!busy && (!visibleUpdate || dismissed === visibleUpdate.tag))
		return null;
	return (
		<aside
			aria-label='Slime2 updates'
			className='flex items-center justify-between gap-3 bg-lime-100 px-5 py-2 text-zinc-900'
		>
			<div role='status'>
				<p>
					{busy ||
					(installation.phase === 'error' &&
						installation.tag === visibleUpdate?.tag)
						? installation.message
						: `Slime2 ${visibleUpdate?.tag} is available.`}
				</p>
				{!busy &&
					visibleUpdate &&
					(!visibleUpdate.hasManifest || !support?.supported) && (
						<p className='text-3.5'>
							{!visibleUpdate.hasManifest
								? 'This release requires a manual download.'
								: (support?.reason ??
									'Checking automatic installation support…')}
						</p>
					)}
			</div>
			<div className='flex shrink-0 gap-4'>
				{!busy && visibleUpdate?.hasManifest && support?.supported && (
					<button
						className='font-bold underline'
						onClick={() => void installUpdate(visibleUpdate)}
					>
						Install and restart
					</button>
				)}
				{visibleUpdate && (
					<button
						className='font-bold underline'
						onClick={() =>
							void openUrl(visibleUpdate.url).catch(e =>
								console.warn(safeLogText(e)),
							)
						}
					>
						View release
					</button>
				)}
				{!busy && visibleUpdate && (
					<button onClick={() => setDismissed(visibleUpdate.tag)}>
						Dismiss
					</button>
				)}
			</div>
		</aside>
	);
}
