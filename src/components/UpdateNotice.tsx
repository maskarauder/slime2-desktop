import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSettings } from '@/contexts/settings/useSettings';
import useAppVersionQuery from '@/hooks/useAppVersionQuery';
import {
	checkForUpdate,
	getAvailableUpdate,
	subscribeUpdates,
} from '@/helpers/updates';
import { openUrl } from '@/helpers/commands';
import { safeLogText } from '@/helpers/safeLog';
export default function UpdateNotice() {
	const { settings } = useSettings(),
		version = useAppVersionQuery().data;
	const update = useSyncExternalStore(subscribeUpdates, getAvailableUpdate),
		[dismissed, setDismissed] = useState(''),
		attempted = useRef('');
	useEffect(() => {
		if (!version || !settings.checkUpdatesOnStart) return;
		const key = `${version}:${settings.updateChannel}`;
		if (attempted.current === key) return;
		const controller = new AbortController();
		void Promise.resolve().then(async () => {
			if (controller.signal.aborted) return;
			attempted.current = key;
			try {
				await checkForUpdate(
					version,
					settings.updateChannel,
					controller.signal,
				);
			} catch (error) {
				if (!controller.signal.aborted)
					console.warn('Update check:', safeLogText(error));
			}
		});
		return () => controller.abort();
	}, [version, settings.updateChannel, settings.checkUpdatesOnStart]);
	if (
		!update ||
		update.channel !== settings.updateChannel ||
		dismissed === update.tag
	)
		return null;
	return (
		<aside
			aria-label='Update available'
			className='flex items-center justify-between gap-3 bg-lime-100 px-5 py-2 text-zinc-900'
		>
			<p>Slime2 {update.tag} is available.</p>
			<div className='flex gap-4'>
				<button
					className='font-bold underline'
					onClick={() =>
						void openUrl(update.url).catch(e =>
							console.warn(safeLogText(e)),
						)
					}
				>
					View release
				</button>
				<button onClick={() => setDismissed(update.tag)}>
					Dismiss
				</button>
			</div>
		</aside>
	);
}
