import ExternalLink from '@/components/ExternalLink';
import TextField from '@/components/input_fields/TextField';
import YoutubeSvg from '@/components/svg/YoutubeSvg';
import useAccounts from '@/contexts/accounts/useAccounts';
import { useAccountsDispatch } from '@/contexts/accounts/useAccountsDispatch';
import { usePage } from '@/contexts/pages/usePage';
import { usePageContext } from '@/contexts/pages/usePageContext';
import { useSettings } from '@/contexts/settings/useSettings';
import { startYouTubeOAuth } from '@/helpers/commands';
import {
	type Account,
	generateAccountId,
	setTokens,
} from '@/helpers/json/accounts';
import youtubeApi from '@/helpers/services/youtube/youtubeApi';
import youtubeAuth from '@/helpers/services/youtube/youtubeAuth';
import { YOUTUBE_READ_SCOPE } from '@/helpers/services/youtube/youtubeConstants';
import { useState } from 'react';
import type { AuthenticationContext, AuthenticationPages } from '.';
import DialogCancelButton from '../DialogButton/DialogCancelButton';
import DialogConfirmButton from '../DialogButton/DialogConfirmButton';

const SERVICE: Account['service'] = 'youtube';

export default function YouTubeAuthPage() {
	const { type, accountId, setAccountId } =
		usePageContext<AuthenticationContext>();
	const { setPage } = usePage<AuthenticationPages>();
	const accounts = useAccounts();
	const { addAccount } = useAccountsDispatch();
	const { settings, setSettings } = useSettings();
	const [clientId, setClientId] = useState(settings.youtubeClientId);
	const [connecting, setConnecting] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string>();

	async function connect() {
		const normalizedClientId = clientId.trim();
		if (!normalizedClientId.endsWith('.apps.googleusercontent.com')) {
			setErrorMessage(
				'Enter a Google OAuth client ID for a Desktop app.',
			);
			return;
		}

		if (type !== 'read') {
			setErrorMessage('YouTube bot accounts are not supported yet.');
			return;
		}

		setConnecting(true);
		setErrorMessage(undefined);
		setSettings({ ...settings, youtubeClientId: normalizedClientId });

		try {
			const codeVerifier = randomUrlSafeString(64);
			const codeChallenge = await sha256UrlSafe(codeVerifier);
			const state = randomUrlSafeString(32);
			const callback = await startYouTubeOAuth(
				normalizedClientId,
				codeChallenge,
				state,
				YOUTUBE_READ_SCOPE,
			);
			const tokenResponse = await youtubeAuth.exchangeAuthorizationCode(
				normalizedClientId,
				callback.code,
				codeVerifier,
				callback.redirectUri,
			);
			const {
				access_token,
				expires_in,
				refresh_token,
				scope = YOUTUBE_READ_SCOPE,
			} = tokenResponse;

			if (!refresh_token) {
				throw new Error(
					'Google did not return a refresh token. Revoke the existing Slime2 grant and try again.',
				);
			}

			const grantedScopes = scope.split(' ');
			if (!grantedScopes.includes(YOUTUBE_READ_SCOPE)) {
				throw new Error(
					'YouTube read access was not granted. Reconnect and allow the requested permission.',
				);
			}

			const channelResponse =
				await youtubeApi.getMyChannelWithAccessToken(access_token);
			const channel = channelResponse.data.items?.[0];
			if (!channel) {
				throw new Error(
					'No YouTube channel was found for this Google account.',
				);
			}

			const newAccountId = generateAccountId(SERVICE, type, channel.id);
			const existingAccount =
				accounts[newAccountId] ?? accounts[accountId];
			await setTokens(newAccountId, access_token, refresh_token, {
				clientId: normalizedClientId,
				expiresAt: Date.now() + expires_in * 1000,
			});

			const account: Account = {
				id: newAccountId,
				type,
				service: SERVICE,
				serviceId: channel.id,
				username:
					channel.snippet.customUrl?.replace(/^@/, '') ?? channel.id,
				displayName: channel.snippet.title,
				image:
					channel.snippet.thumbnails?.high?.url ??
					channel.snippet.thumbnails?.medium?.url ??
					channel.snippet.thumbnails?.default?.url ??
					'',
				scopes: grantedScopes,
				reauthorize: false,
				default: existingAccount?.default ?? false,
				widgets: existingAccount?.widgets ?? {},
			};

			addAccount(account);
			setAccountId(newAccountId);
			setPage('success');
		} catch (error) {
			console.error('YouTube authentication failed:', error);
			setErrorMessage(
				error instanceof Error
					? error.message
					: 'YouTube authentication failed. Please try again.',
			);
		} finally {
			setConnecting(false);
		}
	}

	return (
		<div className='flex w-full flex-1 flex-col gap-5'>
			<div className='flex flex-col gap-3 rounded-2 border-2 border-zinc-300 bg-white p-3 text-3.5'>
				<p>
					This fork needs a Google Cloud OAuth client so Google can
					identify the desktop app.
				</p>
				<ol className='list-decimal pl-4'>
					<li>
						Enable the YouTube Data API v3 in your Google Cloud
						project.
					</li>
					<li>
						Create an OAuth client with application type “Desktop
						app”.
					</li>
					<li>Paste its client ID below, then connect.</li>
				</ol>
				<ExternalLink
					href='https://console.cloud.google.com/auth/clients'
					className='self-start font-bold text-green-600 underline'
				>
					Open Google Cloud OAuth clients
				</ExternalLink>
			</div>

			<TextField
				label='Desktop OAuth Client ID'
				value={clientId}
				onChange={setClientId}
				placeholder='1234567890-abc.apps.googleusercontent.com'
				onEnterKey={() => {
					if (!connecting) connect();
				}}
			/>

			{connecting && (
				<p className='px-2 text-3.5'>
					Complete authorization in your browser. This window will
					continue automatically.
				</p>
			)}
			{errorMessage && (
				<p className='rounded-2 border-2 border-red-300 bg-red-50 px-3 py-2 text-3.5 text-red-800'>
					{errorMessage}
				</p>
			)}

			<div className='mt-auto flex justify-end gap-4'>
				<DialogCancelButton />
				<DialogConfirmButton
					disabled={connecting || clientId.trim().length === 0}
					icon={<YoutubeSvg className='size-4.5' />}
					onClick={connect}
				>
					{connecting ? 'Connecting…' : 'Connect YouTube'}
				</DialogConfirmButton>
			</div>
		</div>
	);
}

function randomUrlSafeString(byteLength: number) {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	return bytesToUrlSafeBase64(bytes);
}

async function sha256UrlSafe(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	);
	return bytesToUrlSafeBase64(new Uint8Array(digest));
}

function bytesToUrlSafeBase64(bytes: Uint8Array) {
	let binary = '';
	bytes.forEach(byte => {
		binary += String.fromCharCode(byte);
	});
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}
