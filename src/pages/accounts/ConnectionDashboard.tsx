import useAccounts from '@/contexts/accounts/useAccounts';
import { useDialog } from '@/contexts/dialog/useDialog';
import AuthenticationDialog from '@/components/dialog/AuthenticationDialog';
import {
	ToolSection,
	ToolButton,
	platformNames,
} from '@/components/ToolControls';
import {
	getConnections,
	reconnectNow,
	subscribeConnections,
} from '@/helpers/connectionStatus';
import { useEffect, useState, useSyncExternalStore } from 'react';
const labels = {
	connecting: 'Connecting',
	connected: 'Connected',
	waiting: 'Waiting for a live stream',
	reconnecting: 'Reconnecting',
	paused: 'Paused',
	reauthorize: 'Sign in again',
	error: 'Stopped',
};
export default function ConnectionDashboard() {
	const accounts = useAccounts(),
		states = useSyncExternalStore(subscribeConnections, getConnections);
	const { openDialog } = useDialog();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const readers = Object.values(accounts).filter(a => a.type === 'read');
	if (!readers.length) return null;
	return (
		<ToolSection title='Chat connections'>
			{readers.map(account => {
				const status = states[account.id],
					state = account.reauthorize ? 'reauthorize' : status?.state;
				return (
					<div
						key={account.id}
						className='flex flex-wrap items-center justify-between gap-2'
					>
						<div>
							<p className='font-semibold'>
								{platformNames[account.service]} ·{' '}
								{account.displayName}
							</p>
							<p>
								{state
									? labels[state]
									: 'Idle — assign this account to a widget'}
								{!account.reauthorize &&
									status?.transport &&
									` · ${status.transport.toUpperCase()}`}
							</p>
							{!account.reauthorize && status?.detail && (
								<p className='text-3.5 text-zinc-600'>
									{status.detail}
								</p>
							)}
							{!account.reauthorize && status?.retryAt && (
								<p className='text-3.5'>
									Next attempt in{' '}
									{Math.max(
										0,
										Math.ceil(
											(status.retryAt - now) / 1000,
										),
									)}
									s
								</p>
							)}
						</div>
						{account.reauthorize ? (
							<ToolButton
								onClick={() =>
									openDialog(
										'Reconnect account',
										<AuthenticationDialog
											reauth={account}
										/>,
									)
								}
							>
								Sign in again
							</ToolButton>
						) : (
							<ToolButton
								disabled={!status || state === 'connecting'}
								onClick={() => reconnectNow(account.id)}
							>
								Reconnect now
							</ToolButton>
						)}
					</div>
				);
			})}
		</ToolSection>
	);
}
