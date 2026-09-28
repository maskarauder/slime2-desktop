import { invoke } from '@tauri-apps/api/core';
import { flushSync } from 'react-dom';
import type { Accounts } from './json/accounts';
import { mainConfigPath, tileFolderPath } from './json/jsonPaths';
import { flushQueuedSaves, pauseQueuedSaves } from './json/queueSaveJson';
import { WidgetMetaSchema, type WidgetMeta } from './json/widgetMeta';
import {
	WidgetSettingsSchema,
	type WidgetSettings as Settings,
} from './json/widgetSettings';
import { WidgetValuesZ, type WidgetValues } from './json/widgetValues';
import { queryClient } from './queryClient';
import {
	replaceWidgetAccountSlots,
	widgetAccountSlotMap,
	type WidgetAccountSlots,
} from './widgetAccountMigration';
import {
	migrateWidgetSettings,
	selectWidgetMigration,
} from './widgetSettingsMigration';
import { sendWidgetCoreChange } from './widgetMessage';
import { beginWidgetUpdate, isWidgetUpdating } from './widgetUpdateState';

type NativePreview = {
	token: string;
	meta: unknown;
	settings: unknown;
	migrations: unknown;
	widgets: {
		widgetId: string;
		meta: unknown;
		settings: unknown;
		values: unknown;
	}[];
};
type UpdatePlan = {
	widgetId: string;
	meta: WidgetMeta;
	values: WidgetValues;
	slotMap: (number | null)[];
	added: string[];
	removed: string[];
	renamed: string[];
	warnings: string[];
};
export type WidgetUpdatePreview = {
	token: string;
	meta: WidgetMeta;
	settings: Settings;
	widgets: UpdatePlan[];
};
export type AppliedWidgetUpdate = {
	widgets: {
		widgetId: string;
		meta: WidgetMeta;
		settings: Settings;
		values: WidgetValues;
	}[];
	accountSlots: WidgetAccountSlots;
};
const consumed = new WeakSet<WidgetUpdatePreview>();
export class WidgetUpdateCompletionError extends Error {
	readonly installed = true;
}

export async function discardWidgetUpdate(token: string): Promise<void> {
	await invoke('discard_widget_update', { token });
}
export function hasWidgetUpdateBackup(widgetId: string): Promise<boolean> {
	return invoke('get_widget_update_status', { widgetId });
}
export async function previewWidgetUpdate(
	zipPath: string,
	widgetIds: string[],
): Promise<WidgetUpdatePreview> {
	if (!widgetIds.length || widgetIds.some(isWidgetUpdating))
		throw new Error('Select an available widget to update.');
	await flushQueuedSaves();
	const prepared = await invoke<NativePreview>('prepare_widget_update', {
		zipPath,
		widgetIds,
	});
	try {
		const meta = WidgetMetaSchema.parse(prepared.meta);
		const settings = WidgetSettingsSchema.parse(prepared.settings);
		const widgets = prepared.widgets.map(widget => {
			const oldMeta = WidgetMetaSchema.parse(widget.meta);
			const oldSettings = WidgetSettingsSchema.parse(widget.settings);
			const values = WidgetValuesZ.parse(widget.values);
			const migration = selectWidgetMigration(
				prepared.migrations,
				oldMeta.version,
				meta.version,
			);
			const migrated = migrateWidgetSettings(
				oldSettings,
				settings,
				values,
				migration,
			);
			const slotMap = widgetAccountSlotMap(oldMeta, meta);
			return {
				widgetId: widget.widgetId,
				meta: oldMeta,
				...migrated,
				slotMap,
			};
		});
		return { token: prepared.token, meta, settings, widgets };
	} catch (error) {
		await discardWidgetUpdate(prepared.token).catch(() => {});
		throw error;
	}
}

async function holdUpdateFiles(ids: string[]) {
	const finish = beginWidgetUpdate(ids);
	try {
		const accountsPath = await mainConfigPath('accounts');
		const paths = await Promise.all(
			ids.map(async id => {
				const root = await tileFolderPath(id);
				return {
					id,
					values: `${root}/config/values`,
					meta: `${root}/core/config/meta`,
					settings: `${root}/core/config/settings`,
				};
			}),
		);
		await Promise.all(
			ids.map(id =>
				queryClient.cancelQueries({
					queryKey: ['widgetSettings', id],
					exact: true,
				}),
			),
		);
		await flushQueuedSaves();
		const release = pauseQueuedSaves([
			accountsPath,
			...paths.flatMap(p => [p.values, p.meta, p.settings]),
		]);
		return {
			async release(applied?: AppliedWidgetUpdate) {
				try {
					await release(
						applied
							? (path, value) => {
									if (path === accountsPath)
										return replaceWidgetAccountSlots(
											value as Accounts,
											applied.accountSlots,
										);
									for (const p of paths) {
										const widget = applied.widgets.find(
											w => w.widgetId === p.id,
										)!;
										if (path === p.values)
											return widget.values;
										if (path === p.meta) return widget.meta;
										if (path === p.settings)
											return widget.settings;
									}
									return value;
								}
							: undefined,
					);
				} finally {
					finish();
				}
			},
		};
	} catch (error) {
		finish();
		throw error;
	}
}

function publishInstalled(applied: AppliedWidgetUpdate) {
	// Commit disk state before rendering or reloading. Synchronous hydration
	// prevents an old mounted form from saving its pre-update values afterward.
	flushSync(() => {
		for (const widget of applied.widgets)
			queryClient.setQueryData(
				['widgetSettings', widget.widgetId],
				widget.settings,
			);
		dispatchEvent(
			new CustomEvent<AppliedWidgetUpdate>('widget-update-applied', {
				detail: applied,
			}),
		);
	});
}
async function reloadWidgets(ids: string[]) {
	for (const id of ids) {
		try {
			await sendWidgetCoreChange(id);
		} catch {
			console.warn(
				'Widget update saved; reload its browser source to load the new version.',
			);
		}
	}
}

export async function applyWidgetUpdate(
	preview: WidgetUpdatePreview,
): Promise<void> {
	if (consumed.has(preview))
		throw new Error(
			'Please select the ZIP again for a fresh update preview.',
		);
	consumed.add(preview);
	let held: Awaited<ReturnType<typeof holdUpdateFiles>> | undefined;
	let applied: AppliedWidgetUpdate | undefined;
	let failure: unknown;
	try {
		held = await holdUpdateFiles(preview.widgets.map(w => w.widgetId));
		const result = await invoke<{
			widgetIds: string[];
			accountSlots: WidgetAccountSlots;
		}>('commit_widget_update', {
			token: preview.token,
			updates: preview.widgets.map(({ widgetId, values, slotMap }) => ({
				widgetId,
				values,
				slotMap,
			})),
		});
		applied = {
			widgets: preview.widgets.map(w => ({
				widgetId: w.widgetId,
				values: w.values,
				meta: preview.meta,
				settings: preview.settings,
			})),
			accountSlots: result.accountSlots,
		};
		publishInstalled(applied);
	} catch (error) {
		failure = error;
	} finally {
		try {
			await held?.release(applied);
		} catch (error) {
			failure ??= error;
		}
		await discardWidgetUpdate(preview.token).catch(() => {});
	}
	if (applied) await reloadWidgets(preview.widgets.map(w => w.widgetId));
	if (failure) {
		if (applied)
			throw new WidgetUpdateCompletionError(
				'The widget update was installed, but Slime2 could not finish refreshing or saving its configuration. Restart Slime2 before changing more settings.',
			);
		throw failure;
	}
}

export async function restoreWidgetUpdate(widgetId: string): Promise<void> {
	const held = await holdUpdateFiles([widgetId]);
	let applied: AppliedWidgetUpdate | undefined;
	let failure: unknown;
	try {
		const result = await invoke<{
			widgetId: string;
			meta: unknown;
			settings: unknown;
			values: unknown;
			accountSlots: Record<string, number>;
		}>('restore_widget_update', { widgetId });
		applied = {
			widgets: [
				{
					widgetId,
					meta: WidgetMetaSchema.parse(result.meta),
					settings: WidgetSettingsSchema.parse(result.settings),
					values: WidgetValuesZ.parse(result.values),
				},
			],
			accountSlots: { [widgetId]: result.accountSlots },
		};
		publishInstalled(applied);
	} catch (error) {
		failure = error;
	} finally {
		try {
			await held.release(applied);
		} catch (error) {
			failure ??= error;
		}
	}
	if (applied) await reloadWidgets([widgetId]);
	if (failure) {
		if (applied)
			throw new WidgetUpdateCompletionError(
				'The previous version was restored, but Slime2 could not finish refreshing or saving its configuration. Restart Slime2 before changing more settings.',
			);
		throw failure;
	}
}
