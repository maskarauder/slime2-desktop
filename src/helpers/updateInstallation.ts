import {
	discardPreparedUpdate,
	getUpdateSupport,
	installPreparedUpdate,
	prepareReleaseUpdate,
} from './commands';
import { flushQueuedSaves } from './json/queueSaveJson';
import { safeLogText } from './safeLog';
import {
	checkForUpdate,
	getAvailableUpdate,
	type AvailableUpdate,
	type UpdateChannel,
} from './updates';

export type InstallationStatus = {
	phase:
		'idle' | 'checking' | 'downloading' | 'saving' | 'installing' | 'error';
	tag?: string;
	message: string;
	percent?: number;
};
let status: InstallationStatus = { phase: 'idle', message: '' };
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const getUpdateInstallation = () => status;
export function subscribeInstallation(callback: () => void) {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}
function publish(next: InstallationStatus) {
	status = next;
	listeners.forEach(callback => callback());
}
export function installationBusy(value = status) {
	return value.phase !== 'idle' && value.phase !== 'error';
}

// A single app-owned job survives settings navigation and coalesces double clicks.
// Failure is visible, logged once, and retried only by an explicit user action.
export function installUpdate(update: AvailableUpdate): Promise<void> {
	if (inFlight) return inFlight;
	if (installationBusy()) return Promise.resolve();
	publish({
		phase: 'checking',
		tag: update.tag,
		message: 'Checking the signed installer…',
	});
	inFlight = performInstallation(update).finally(() => {
		inFlight = null;
	});
	return inFlight;
}
async function performInstallation(update: AvailableUpdate) {
	let token: string | undefined;
	try {
		if (!update.hasManifest)
			throw Error(
				'This release has no automatic-update manifest. Use View release to install it manually.',
			);
		const support = await getUpdateSupport();
		if (!support.supported)
			throw Error(
				support.reason ??
					'Automatic installation is unavailable for this build.',
			);
		const prepared = await prepareReleaseUpdate(update.tag, progress => {
			if (
				progress.stage !== 'downloading' ||
				status.tag !== update.tag ||
				(status.phase !== 'checking' && status.phase !== 'downloading')
			)
				return;
			const percent =
				progress.total && progress.total > 0
					? Math.min(
							100,
							Math.floor(
								(progress.downloaded / progress.total) * 100,
							),
						)
					: undefined;
			publish({
				phase: 'downloading',
				tag: update.tag,
				percent,
				message: `Downloading Slime2 ${update.tag}${percent === undefined ? '…' : ` (${percent}%)…`}`,
			});
		});
		token = prepared.token;
		publish({
			phase: 'saving',
			tag: update.tag,
			message: 'Saving settings before installation…',
		});
		// Windows installation exits the process; a failed save must prevent that.
		await flushQueuedSaves();
		publish({
			phase: 'installing',
			tag: update.tag,
			message: 'Installing the update. Slime2 will close and relaunch…',
		});
		console.info(`Installing Slime2 update ${update.tag}.`);
		await installPreparedUpdate(token);
		token = undefined;
	} catch (error) {
		const message = safeLogText(
			error instanceof Error ? error.message : error,
		);
		console.warn('Slime2 update failed:', message);
		publish({
			phase: 'error',
			tag: update.tag,
			message: `Update failed: ${message}`,
		});
	} finally {
		if (token) {
			try {
				await discardPreparedUpdate(token);
			} catch {
				console.warn(
					'Unable to discard the prepared update; it will expire automatically.',
				);
			}
		}
	}
}

export async function runStartupUpdate(
	version: string,
	settings: {
		checkUpdatesOnStart: boolean;
		autoInstallUpdates: boolean;
		updateChannel: UpdateChannel;
	},
	signal: AbortSignal,
) {
	if (
		signal.aborted ||
		(!settings.checkUpdatesOnStart && !settings.autoInstallUpdates)
	)
		return;
	await checkForUpdate(version, settings.updateChannel, signal);
	if (signal.aborted || !settings.autoInstallUpdates) return;
	const update = getAvailableUpdate();
	if (update?.channel === settings.updateChannel) await installUpdate(update);
}
