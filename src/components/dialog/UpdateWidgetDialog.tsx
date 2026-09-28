import { useDialog } from '@/contexts/dialog/useDialog';
import useTileMetas from '@/contexts/tile_metas/useTileMetas';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import { openZip } from '@/helpers/openFile';
import {
	applyWidgetUpdate,
	discardWidgetUpdate,
	hasWidgetUpdateBackup,
	previewWidgetUpdate,
	restoreWidgetUpdate,
	type WidgetUpdatePreview,
} from '@/helpers/widgetUpdater';
import { useEffect, useRef, useState } from 'react';
import DialogActionButton from './DialogButton/DialogActionButton';
import DialogConfirmButton from './DialogButton/DialogConfirmButton';
import DialogContent from './DialogContent';

type PreparedUpdate = {
	preview: WidgetUpdatePreview;
	consumed: boolean;
};

const neutralButton =
	'border-zinc-100 bg-zinc-200 from-zinc-200 to-zinc-300 text-zinc-700 outline-zinc-400 over:bg-lime-200 over:text-lime-800 over:outline-lime-600';

export default function UpdateWidgetDialog({ widgetId }: { widgetId: string }) {
	const { closeDialog } = useDialog();
	const widgetMetas = useWidgetMetas();
	const tileMetas = useTileMetas();
	const currentMeta = widgetMetas[widgetId];
	const matchingIds = Object.keys(widgetMetas).filter(
		id =>
			id === widgetId ||
			(Boolean(currentMeta?.id.trim()) &&
				widgetMetas[id]?.id === currentMeta?.id),
	);
	const [allMatching, setAllMatching] = useState(false);
	const [zipPath, setZipPath] = useState<string>();
	const [previewAttempt, setPreviewAttempt] = useState(0);
	const [preview, setPreview] = useState<WidgetUpdatePreview>();
	const [loadingPreview, setLoadingPreview] = useState(false);
	const [operation, setOperation] = useState<
		'choose' | 'update' | 'restore'
	>();
	const [error, setError] = useState('');
	const [hasBackup, setHasBackup] = useState(false);
	const [backupError, setBackupError] = useState(false);
	const [backupCheck, setBackupCheck] = useState(0);
	const [confirmRestore, setConfirmRestore] = useState(false);
	const mounted = useRef(false);
	const operationRef = useRef(false);
	const preparedRef = useRef<PreparedUpdate | undefined>(undefined);
	const selectionKey = JSON.stringify(
		allMatching ? matchingIds.sort() : [widgetId],
	);
	const busy = Boolean(operation) || loadingPreview;

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		setHasBackup(false);
		setBackupError(false);
		void hasWidgetUpdateBackup(widgetId).then(
			available => {
				if (!cancelled) setHasBackup(available);
			},
			() => {
				if (!cancelled) setBackupError(true);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [widgetId, backupCheck]);

	useEffect(() => {
		let cancelled = false;
		let prepared: PreparedUpdate | undefined;
		setPreview(undefined);
		setLoadingPreview(Boolean(zipPath));
		if (!zipPath) return;
		setError('');

		void previewWidgetUpdate(
			zipPath,
			JSON.parse(selectionKey) as string[],
		).then(
			result => {
				if (cancelled) {
					void discardWidgetUpdate(result.token).catch(() => {});
					return;
				}
				prepared = { preview: result, consumed: false };
				preparedRef.current = prepared;
				setPreview(result);
				setLoadingPreview(false);
			},
			failure => {
				if (!cancelled) {
					setError(errorMessage(failure));
					setLoadingPreview(false);
				}
			},
		);

		return () => {
			cancelled = true;
			if (preparedRef.current === prepared)
				preparedRef.current = undefined;
			// Once applying, the service owns the token and must finish even if
			// this dialog closes or the widget's metadata changes.
			if (prepared && !prepared.consumed) {
				void discardWidgetUpdate(prepared.preview.token).catch(
					() => {},
				);
			}
		};
	}, [zipPath, selectionKey, previewAttempt]);

	async function chooseZip() {
		if (operationRef.current || loadingPreview) return;
		operationRef.current = true;
		setOperation('choose');
		setError('');
		try {
			const selectedPath = await openZip({
				title: 'Update Widget from ZIP',
			});
			if (!mounted.current || !selectedPath) return;
			preparedRef.current = undefined;
			setPreview(undefined);
			setZipPath(selectedPath);
			setPreviewAttempt(attempt => attempt + 1);
		} catch (failure) {
			if (mounted.current) setError(errorMessage(failure));
		} finally {
			operationRef.current = false;
			if (mounted.current) setOperation(undefined);
		}
	}

	async function applyUpdate() {
		const prepared = preparedRef.current;
		if (
			operationRef.current ||
			loadingPreview ||
			!prepared ||
			prepared.consumed
		)
			return;
		operationRef.current = true;
		prepared.consumed = true;
		setOperation('update');
		setError('');
		try {
			await applyWidgetUpdate(prepared.preview);
			if (mounted.current) closeDialog();
		} catch (failure) {
			if (mounted.current) {
				preparedRef.current = undefined;
				setPreview(undefined);
				if (wasInstalled(failure)) {
					setError(errorMessage(failure));
					setBackupCheck(check => check + 1);
				} else {
					setError(
						`${errorMessage(failure)} Choose the ZIP again to review a fresh update.`,
					);
				}
			}
		} finally {
			operationRef.current = false;
			if (mounted.current) setOperation(undefined);
		}
	}

	async function restore() {
		if (operationRef.current || loadingPreview) return;
		operationRef.current = true;
		setOperation('restore');
		preparedRef.current = undefined;
		setPreview(undefined);
		setZipPath(undefined);
		setError('');
		try {
			await restoreWidgetUpdate(widgetId);
			if (mounted.current) closeDialog();
		} catch (failure) {
			if (mounted.current) {
				setError(errorMessage(failure));
				if (wasInstalled(failure)) {
					setConfirmRestore(false);
					setBackupCheck(check => check + 1);
				}
			}
		} finally {
			operationRef.current = false;
			if (mounted.current) setOperation(undefined);
		}
	}

	return (
		<DialogContent className='flex w-140 max-w-[calc(100vw-2rem)] flex-col gap-4 p-4'>
			<div
				className='flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1'
				aria-busy={busy}
			>
				{confirmRestore ? (
					<div className='flex flex-col gap-3'>
						<p className='font-medium'>
							Restore the previous version of{' '}
							{tileMetas[widgetId]?.name ||
								currentMeta?.name ||
								'this widget'}
							?
						</p>
						<p>
							This replaces this widget’s code and settings with
							the backup from before its last update. Settings
							changes made since then will be lost.
						</p>
						<p>
							The OBS URL stays the same. Account assignments also
							return to the backup. Other widgets are not
							restored.
						</p>
					</div>
				) : (
					<>
						<p>
							Choose a widget ZIP to update this widget in place.
							Existing settings, account assignments, and the OBS
							URL are preserved. New fields use their defaults;
							removed fields are retired.
						</p>
						<div className='flex items-center gap-3'>
							<DialogActionButton
								onClick={chooseZip}
								disabled={busy}
								className={neutralButton}
							>
								Choose ZIP
							</DialogActionButton>
							{zipPath && (
								<span className='min-w-0 flex-1 text-3.5 break-all text-zinc-600'>
									{zipPath.split(/[\\/]/).pop()}
								</span>
							)}
						</div>
						{matchingIds.length > 1 && (
							<label className='flex items-start gap-2 font-medium'>
								<input
									type='checkbox'
									className='mt-1 size-4 accent-lime-700'
									checked={allMatching}
									disabled={busy}
									onChange={event => {
										preparedRef.current = undefined;
										setPreview(undefined);
										setAllMatching(event.target.checked);
									}}
								/>
								<span>
									Update all matching widgets (
									{matchingIds.length})
								</span>
							</label>
						)}
						{preview && (
							<div className='flex flex-col gap-3'>
								<p className='font-bold'>
									{preview.meta.name} · {preview.meta.version}
								</p>
								{preview.widgets.map(widget => (
									<div
										key={widget.widgetId}
										className='rounded-2 border border-zinc-300 bg-white p-3'
									>
										<p className='font-medium'>
											{tileMetas[widget.widgetId]?.name ||
												widget.meta.name}
										</p>
										<p className='text-3.5 text-zinc-600'>
											{widget.meta.version} →{' '}
											{preview.meta.version}
											{widget.meta.version ===
											preview.meta.version
												? ' (reinstall)'
												: ''}
										</p>
										<details className='mt-2 text-3.5'>
											<summary className='cursor-pointer'>
												{widget.added.length} added ·{' '}
												{widget.removed.length} removed
												· {widget.renamed.length}{' '}
												renamed settings
											</summary>
											<ul className='mt-2 list-inside list-disc break-words text-zinc-600'>
												{widget.added.map(field => (
													<li key={`add-${field}`}>
														Add: {field}
													</li>
												))}
												{widget.removed.map(field => (
													<li key={`remove-${field}`}>
														Remove: {field}
													</li>
												))}
												{widget.renamed.map(field => (
													<li key={`rename-${field}`}>
														Rename: {field}
													</li>
												))}
											</ul>
										</details>
										{widget.warnings.length > 0 && (
											<ul className='mt-2 list-inside list-disc text-3.5 text-amber-900'>
												{widget.warnings.map(
													(warning, index) => (
														<li key={index}>
															{warning}
														</li>
													),
												)}
											</ul>
										)}
									</div>
								))}
								<p className='text-3.5 text-zinc-600'>
									A backup is saved before each update.
									Connected browser sources reload
									automatically.
								</p>
							</div>
						)}
					</>
				)}
				{busy && (
					<p role='status'>
						{operation === 'update'
							? 'Updating widgets…'
							: operation === 'restore'
								? 'Restoring previous version…'
								: operation === 'choose'
									? 'Choosing ZIP…'
									: 'Checking ZIP and settings…'}
					</p>
				)}
				{error && (
					<p
						role='alert'
						className='rounded-2 border border-rose-300 bg-rose-50 p-3 text-rose-900'
					>
						{error}
					</p>
				)}
				{backupError && (
					<p className='text-3.5 text-zinc-600'>
						Could not check for a previous version. Reopen this
						dialog to check again.
					</p>
				)}
			</div>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<div>
					{hasBackup && !confirmRestore && (
						<button
							type='button'
							className='rounded px-1 py-2 text-3.5 font-medium text-zinc-600 underline disabled:opacity-50 over:text-green-800'
							disabled={busy}
							onClick={() => {
								setError('');
								setConfirmRestore(true);
							}}
						>
							Restore previous version
						</button>
					)}
				</div>
				<div className='flex gap-3'>
					<DialogActionButton
						className={neutralButton}
						disabled={busy}
						onClick={() => {
							if (confirmRestore) {
								setConfirmRestore(false);
								setError('');
							} else closeDialog();
						}}
					>
						{confirmRestore ? 'Back' : 'Cancel'}
					</DialogActionButton>
					<DialogConfirmButton
						disabled={busy || (!confirmRestore && !preview)}
						onClick={confirmRestore ? restore : applyUpdate}
					>
						{confirmRestore
							? 'Restore'
							: preview && preview.widgets.length > 1
								? `Update ${preview.widgets.length} widgets`
								: 'Update widget'}
					</DialogConfirmButton>
				</div>
			</div>
		</DialogContent>
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === 'string'
			? error
			: 'The widget update could not be completed.';
}

function wasInstalled(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'installed' in error &&
		error.installed === true
	);
}
