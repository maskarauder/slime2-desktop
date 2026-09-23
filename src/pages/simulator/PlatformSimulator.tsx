import { useEffect, useRef, useState } from 'react';
import useWidgetMetas from '@/contexts/widget_metas/useWidgetMetas';
import {
	ToolSection,
	ToolButton,
	toolInputClass,
} from '@/components/ToolControls';
import {
	simulateBurst,
	type SimulationPlatform,
	type SimulationKind,
} from '@/helpers/simulator';
import { safeLogText } from '@/helpers/safeLog';
export default function PlatformSimulator() {
	const widgets = useWidgetMetas(),
		[platform, setPlatform] = useState<SimulationPlatform>('youtube'),
		[kind, setKind] = useState<SimulationKind>('chat');
	const [name, setName] = useState('Sample Viewer'),
		[text, setText] = useState('Hello from the simulator!'),
		[target, setTarget] = useState('*'),
		[count, setCount] = useState(1),
		[interval, setIntervalMs] = useState(1000),
		[busy, setBusy] = useState(false),
		[message, setMessage] = useState('');
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	const targets = Object.entries(widgets).filter(
		([, m]) =>
			m.type.includes('overlay') &&
			m.accounts.some(a => a.type === 'read' && a.service === platform),
	);
	const kinds: [SimulationKind, string][] = [
		['chat', 'Chat message'],
		['emote', 'Inline emote'],
	];
	if (platform === 'youtube')
		kinds.push(
			['superChat', 'Super Chat'],
			['superSticker', 'Super Sticker'],
			['membership', 'New membership'],
			['membershipGift', 'Gift memberships'],
		);
	if (platform === 'tiktok') kinds.push(['gift', 'Gift']);
	async function send() {
		if (controller.current) return;
		const widgetIds = targets
			.filter(([id]) => target === '*' || id === target)
			.map(([id]) => id);
		if (!widgetIds.length) {
			setMessage('Install an overlay that supports this platform first.');
			return;
		}
		const active = new AbortController();
		controller.current = active;
		setBusy(true);
		try {
			await simulateBurst({
				platform,
				kind,
				name,
				text,
				widgetIds,
				count,
				interval,
				signal: active.signal,
				onProgress: sent =>
					setMessage(
						`Sent ${sent} simulated event(s) to ${widgetIds.length} overlay(s).`,
					),
			});
			if (active.signal.aborted) setMessage('Simulation stopped.');
		} catch (error) {
			setMessage(safeLogText(error));
		} finally {
			if (controller.current === active) {
				controller.current = null;
				setBusy(false);
			}
		}
	}
	return (
		<ToolSection title='Cross-platform chat test'>
			<p className='text-3.5'>
				Sends local test events to overlays without live chat API
				requests or bot replies. Emote images may load from their image
				host.
			</p>
			<fieldset
				disabled={busy}
				className='grid grid-cols-2 gap-3 disabled:opacity-60'
			>
				<label>
					Platform
					<select
						aria-label='Platform'
						className={toolInputClass}
						value={platform}
						onChange={e => {
							setPlatform(e.target.value as SimulationPlatform);
							setKind('chat');
							setTarget('*');
						}}
					>
						<option value='twitch'>Twitch</option>
						<option value='youtube'>YouTube</option>
						<option value='tiktok'>TikTok</option>
					</select>
				</label>
				<label>
					Event
					<select
						aria-label='Event'
						className={toolInputClass}
						value={kind}
						onChange={e =>
							setKind(e.target.value as SimulationKind)
						}
					>
						{kinds.map(([id, label]) => (
							<option key={id} value={id}>
								{label}
							</option>
						))}
					</select>
				</label>
				<label className='col-span-2'>
					Send to
					<select
						aria-label='Send to'
						className={toolInputClass}
						value={target}
						onChange={e => setTarget(e.target.value)}
					>
						<option value='*'>
							All compatible overlays ({targets.length})
						</option>
						{targets.map(([id, m]) => (
							<option key={id} value={id}>
								{m.name} · {id}
							</option>
						))}
					</select>
				</label>
				<label>
					Viewer name
					<input
						className={toolInputClass}
						maxLength={60}
						value={name}
						onChange={e => setName(e.target.value)}
					/>
				</label>
				<label>
					Message
					<input
						className={toolInputClass}
						maxLength={500}
						value={text}
						onChange={e => setText(e.target.value)}
					/>
				</label>
				<label>
					Messages (1–100)
					<input
						type='number'
						min={1}
						max={100}
						className={toolInputClass}
						value={count}
						onChange={e => setCount(e.target.valueAsNumber)}
					/>
				</label>
				<label>
					Interval in milliseconds (100–30000)
					<input
						type='number'
						min={100}
						max={30000}
						step={100}
						className={toolInputClass}
						value={interval}
						onChange={e => setIntervalMs(e.target.valueAsNumber)}
					/>
				</label>
			</fieldset>
			<div className='flex gap-2'>
				<ToolButton
					disabled={busy || !targets.length}
					onClick={() => void send()}
				>
					Send test
				</ToolButton>
				<ToolButton
					disabled={!busy}
					onClick={() => controller.current?.abort()}
				>
					Stop
				</ToolButton>
			</div>
			{message && <p role='status'>{message}</p>}
		</ToolSection>
	);
}
