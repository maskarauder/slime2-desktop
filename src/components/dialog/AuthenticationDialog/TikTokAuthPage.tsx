import ExternalLink from '@/components/ExternalLink';
import TextField from '@/components/input_fields/TextField';
import MusicNotesSvg from '@/components/svg/MusicNoteSvg';
import useAccounts from '@/contexts/accounts/useAccounts';
import { useAccountsDispatch } from '@/contexts/accounts/useAccountsDispatch';
import { usePage } from '@/contexts/pages/usePage';
import { usePageContext } from '@/contexts/pages/usePageContext';
import {
	type Account,
	generateAccountId,
	setTokens,
} from '@/helpers/json/accounts';
import {
	TIKTOK_ACCOUNT_IMAGE,
	TIKTOK_LIVE_READ_SCOPE,
} from '@/helpers/services/tiktok/tiktokConstants';
import { useState } from 'react';
import type { AuthenticationContext, AuthenticationPages } from '.';
import DialogCancelButton from '../DialogButton/DialogCancelButton';
import DialogConfirmButton from '../DialogButton/DialogConfirmButton';

const SERVICE: Account['service'] = 'tiktok';

export default function TikTokAuthPage() {
	const { type, accountId, setAccountId } =
		usePageContext<AuthenticationContext>();
	const { setPage } = usePage<AuthenticationPages>();
	const accounts = useAccounts();
	const { addAccount } = useAccountsDispatch();
	const existingAccount = accounts[accountId];
	const [username, setUsername] = useState(existingAccount?.username ?? '');
	const [apiKey, setApiKey] = useState('');
	const [connecting, setConnecting] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string>();

	async function connect() {
		const normalizedUsername = normalizeTikTokUsername(username);
		const normalizedApiKey = apiKey.trim();

		if (type !== 'read') {
			setErrorMessage('TikTok bot accounts are not supported.');
			return;
		}

		if (
			!normalizedUsername ||
			normalizedUsername.length > 24 ||
			/\s/.test(normalizedUsername)
		) {
			setErrorMessage('Enter a valid TikTok username without spaces.');
			return;
		}

		if (!normalizedApiKey) {
			setErrorMessage('Enter your Euler Stream API key.');
			return;
		}

		setConnecting(true);
		setErrorMessage(undefined);

		try {
			const newAccountId =
				accountId ||
				generateAccountId(
					SERVICE,
					type,
					normalizedUsername.toLowerCase(),
				);
			const previousAccount = accounts[newAccountId] ?? existingAccount;

			await setTokens(newAccountId, normalizedApiKey, '');

			const account: Account = {
				id: newAccountId,
				type,
				service: SERVICE,
				serviceId: normalizedUsername,
				username: normalizedUsername,
				displayName: `@${normalizedUsername}`,
				image: TIKTOK_ACCOUNT_IMAGE,
				scopes: [TIKTOK_LIVE_READ_SCOPE],
				reauthorize: false,
				default: previousAccount?.default ?? false,
				widgets: previousAccount?.widgets ?? {},
			};

			addAccount(account);
			setAccountId(newAccountId);
			setPage('success');
		} catch (error) {
			console.error('TikTok LIVE connection setup failed:', error);
			setErrorMessage(
				error instanceof Error
					? error.message
					: 'TikTok LIVE setup failed. Please try again.',
			);
		} finally {
			setConnecting(false);
		}
	}

	return (
		<div className='flex w-full flex-1 flex-col gap-5'>
			<div className='flex flex-col gap-3 rounded-2 border-2 border-amber-300 bg-amber-50 p-3 text-3.5 text-amber-950'>
				<p className='font-bold'>Experimental, read-only integration</p>
				<p>
					TikTok does not provide an official public LIVE chat API.
					This connection uses the third-party Euler Stream gateway
					and may stop working if TikTok changes its internal service.
				</p>
				<p>
					Create an Euler Stream API key, then enter the public
					broadcaster username. No TikTok password or session cookie
					is used.
				</p>
				<ExternalLink
					href='https://www.eulerstream.com/'
					className='self-start font-bold text-green-700 underline'
				>
					Open Euler Stream
				</ExternalLink>
			</div>

			<TextField
				label='TikTok LIVE broadcaster'
				value={username}
				onChange={setUsername}
				placeholder='@username'
				description='The public account whose LIVE chat Slime2 should read.'
			/>

			<TextField
				type='password'
				label='Euler Stream API key'
				value={apiKey}
				onChange={setApiKey}
				placeholder='Paste your API key'
				description='Stored in your operating system credential store, not accounts.json.'
				onEnterKey={() => {
					if (!connecting) connect();
				}}
			/>

			{errorMessage && (
				<p className='rounded-2 border-2 border-red-300 bg-red-50 px-3 py-2 text-3.5 text-red-800'>
					{errorMessage}
				</p>
			)}

			<div className='mt-auto flex justify-end gap-4'>
				<DialogCancelButton />
				<DialogConfirmButton
					disabled={
						connecting ||
						username.trim().length === 0 ||
						apiKey.trim().length === 0
					}
					icon={<MusicNotesSvg className='size-4.5' />}
					onClick={connect}
				>
					{connecting ? 'Saving…' : 'Connect TikTok LIVE'}
				</DialogConfirmButton>
			</div>
		</div>
	);
}

function normalizeTikTokUsername(value: string) {
	return value
		.trim()
		.replace(/^https?:\/\/(?:www\.)?tiktok\.com\//i, '')
		.replace(/^@/, '')
		.replace(/\/live(?:[/?#].*)?$/i, '')
		.split(/[/?#]/, 1)[0]!
		.trim();
}
