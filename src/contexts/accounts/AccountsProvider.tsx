import {
	type Account,
	type Accounts,
	deleteTokens,
	loadAccounts,
} from '@/helpers/json/accounts';
import twitchApi from '@/helpers/services/twitch/twitchApi';
import youtubeApi from '@/helpers/services/youtube/youtubeApi';
import { YouTubeReauthorizationError } from '@/helpers/services/youtube/youtubeAuth';
import axios from 'axios';
import { useEffect, useReducer } from 'react';
import { AccountsContext } from './useAccounts';
import {
	AccountsDispatchContext,
	accountsReducer,
} from './useAccountsDispatch';

export default function AccountsProvider({ children }: Props.WithChildren) {
	const [accounts, dispatch] = useReducer(accountsReducer, {});

	function setAccounts(accounts: Accounts) {
		dispatch({ type: 'set', accounts });
	}

	function updateAccount(account: Account) {
		dispatch({ type: 'add', account });
	}

	useEffect(() => {
		async function getAccounts() {
			const accounts = await loadAccounts();
			setAccounts(accounts);
		}

		getAccounts();
	}, []);

	useEffect(() => {
		Promise.all(
			Object.values(accounts).map(async account => {
				if (account.reauthorize) return;

				try {
					if (account.service === 'twitch') {
						// update user details
						const response = await twitchApi.getUser(
							account.id,
							account.serviceId,
						);
						const user = response.data.data[0];
						if (!user)
							throw new Error(
								'Twitch user not found while updating!',
							);

						if (
							account.username !== user.login ||
							account.displayName !== user.display_name ||
							account.image !== user.profile_image_url
						) {
							updateAccount({
								...account,
								username: user.login,
								displayName: user.display_name,
								image: user.profile_image_url,
							});
						}
					} else if (account.service === 'youtube') {
						const response = await youtubeApi.getMyChannel(
							account.id,
						);
						const channel = response.data.items?.[0];
						if (!channel) {
							throw new Error(
								'YouTube channel not found while updating!',
							);
						}

						const username =
							channel.snippet.customUrl?.replace(/^@/, '') ??
							channel.id;
						const image =
							channel.snippet.thumbnails?.high?.url ??
							channel.snippet.thumbnails?.medium?.url ??
							channel.snippet.thumbnails?.default?.url ??
							'';
						if (
							account.username !== username ||
							account.displayName !== channel.snippet.title ||
							account.image !== image
						) {
							updateAccount({
								...account,
								username,
								displayName: channel.snippet.title,
								image,
							});
						}
					}
				} catch (error) {
					console.error(
						`Unable to update ${account.service} account:`,
						error,
					);
					if (
						account.service === 'youtube' &&
						!(error instanceof YouTubeReauthorizationError) &&
						!(
							axios.isAxiosError(error) &&
							error.response?.status === 401
						)
					) {
						return;
					}

					updateAccount({ ...account, reauthorize: true });

					try {
						await deleteTokens(account.id);
					} catch (deleteError) {
						console.error(deleteError);
					}
				}
			}),
		);
	}, [accounts]);

	return (
		<AccountsContext value={accounts}>
			<AccountsDispatchContext value={dispatch}>
				{children}
			</AccountsDispatchContext>
		</AccountsContext>
	);
}
