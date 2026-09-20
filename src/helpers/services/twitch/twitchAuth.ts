import axios from 'axios';
import {
	type Account,
	getTokens,
	setTokens,
	type Tokens,
} from '../../json/accounts';
import {
	TWITCH_BOT_SCOPES,
	TWITCH_CLIENT_ID,
	TWITCH_READ_SCOPES,
} from './twitchConstants';

const VALIDATION_INTERVAL = 1000 * 60 * 55; // in milliseconds

const twitchAuthAxios = axios.create({
	baseURL: 'https://id.twitch.tv/oauth2',
	timeout: 15_000,
});

export class TwitchReauthorizationError extends Error {}
const startupValidated = new Set<string>();

function invalidRefresh(error: unknown) {
	if (!axios.isAxiosError(error)) return false;
	const status = error.response?.status;
	const data = error.response?.data as
		{ message?: string; error?: string } | undefined;
	return (
		(status === 400 || status === 401) &&
		(data?.error === 'invalid_grant' ||
			/invalid refresh token/i.test(data?.message ?? ''))
	);
}

const validationPromises = new Map<
	string,
	{ promise: Promise<Tokens>; rejected?: string }
>();

function accountScopes(type: Account['type']) {
	switch (type) {
		case 'read':
			return TWITCH_READ_SCOPES;
		case 'bot':
			return TWITCH_BOT_SCOPES;
		case 'mod':
		default:
			throw new Error('Unhandled account type!');
	}
}

// DCF = Device Code Grant Flow
// https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow

const twitchAuth = {
	async startDCF(type: Account['type']) {
		return twitchAuthAxios.post<{
			device_code: string;
			expires_in: number;
			interval: number;
			user_code: string;
			verification_uri: string;
		}>('/device', undefined, {
			params: {
				client_id: TWITCH_CLIENT_ID,
				scopes: accountScopes(type).join(' '),
			},
		});
	},

	async obtainDCFTokens(type: Account['type'], deviceCode: string) {
		return twitchAuthAxios.post<{
			access_token: string;
			refresh_token: string;
			expires_in: number;
			scope: string[];
			token_type: string;
		}>('/token', undefined, {
			params: {
				client_id: TWITCH_CLIENT_ID,
				scopes: accountScopes(type).join(' '),
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: deviceCode,
			},
		});
	},

	async validateAccessToken(accessToken: string) {
		return twitchAuthAxios.get<{
			client_id: string;
			login: string;
			scopes: string[];
			user_id: string;
			expires_in: number;
		}>('/validate', {
			headers: {
				Authorization: `OAuth ${accessToken}`,
			},
		});
	},

	async refreshAccessToken(refreshToken: string) {
		return twitchAuthAxios.post<{
			access_token: string;
			refresh_token: string;
			scope: string[];
			token_type: string;
		}>('/token', undefined, {
			params: {
				client_id: TWITCH_CLIENT_ID,
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
			},
		});
	},

	async getValidTokens(
		accountId: string,
		rejectedAccessToken?: string,
	): Promise<Tokens> {
		const existing = validationPromises.get(accountId);
		if (existing) {
			const result = await existing.promise;
			if (
				rejectedAccessToken &&
				result.accessToken === rejectedAccessToken &&
				existing.rejected !== rejectedAccessToken
			)
				return twitchAuth.getValidTokens(
					accountId,
					rejectedAccessToken,
				);
			return result;
		}
		const promise = (async () => {
			let tokens = await getTokens(accountId);
			// A concurrent request may already have rotated the rejected token.
			const rejected = rejectedAccessToken === tokens.accessToken;
			if (
				!rejected &&
				startupValidated.has(accountId) &&
				Date.now() - tokens.validatedAt < VALIDATION_INTERVAL
			)
				return tokens;
			if (!rejected) {
				try {
					await twitchAuth.validateAccessToken(tokens.accessToken);
					tokens = await setTokens(
						accountId,
						tokens.accessToken,
						tokens.refreshToken,
						{
							clientId: tokens.clientId,
							clientSecret: tokens.clientSecret,
							expiresAt: tokens.expiresAt,
						},
					);
					startupValidated.add(accountId);
					return tokens;
				} catch (error) {
					if (
						!axios.isAxiosError(error) ||
						error.response?.status !== 401
					)
						throw error;
				}
			}
			try {
				const { data } = await twitchAuth.refreshAccessToken(
					tokens.refreshToken,
				);
				tokens = await setTokens(
					accountId,
					data.access_token,
					data.refresh_token,
					{
						clientId: tokens.clientId,
						clientSecret: tokens.clientSecret,
						expiresAt: tokens.expiresAt,
					},
				);
				startupValidated.add(accountId);
				return tokens;
			} catch (error) {
				if (invalidRefresh(error))
					throw new TwitchReauthorizationError(
						'Twitch rejected the refresh token. Reconnect this account.',
					);
				throw error;
			}
		})();
		validationPromises.set(accountId, {
			promise,
			rejected: rejectedAccessToken,
		});
		try {
			return await promise;
		} finally {
			if (validationPromises.get(accountId)?.promise === promise)
				validationPromises.delete(accountId);
		}
	},
};

export default twitchAuth;
