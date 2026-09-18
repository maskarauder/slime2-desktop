import {
	exchangeYouTubeOAuthCode,
	refreshYouTubeOAuthToken,
} from '@/helpers/commands';
import { getTokens, setTokens, type Tokens } from '../../json/accounts';
import { getYouTubeErrorDetails } from './youtubeError';

const ACCESS_TOKEN_EXPIRY_BUFFER = 60 * 1000;

const validationPromises = new Map<
	string,
	{
		promise: Promise<Tokens>;
		forced: boolean;
	}
>();

export class YouTubeReauthorizationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'YouTubeReauthorizationError';
	}
}

const youtubeAuth = {
	async exchangeAuthorizationCode(
		clientId: string,
		clientSecret: string,
		code: string,
		codeVerifier: string,
		redirectUri: string,
	) {
		return exchangeYouTubeOAuthCode(
			clientId,
			clientSecret,
			code,
			codeVerifier,
			redirectUri,
		);
	},

	async refreshAccessToken(
		clientId: string,
		clientSecret: string,
		refreshToken: string,
	) {
		return refreshYouTubeOAuthToken(clientId, clientSecret, refreshToken);
	},

	async getValidTokens(
		accountId: string,
		rejectedAccessToken?: string,
	): Promise<Tokens> {
		const existing = validationPromises.get(accountId);
		if (existing) {
			const tokens = await existing.promise;
			if (
				!rejectedAccessToken ||
				existing.forced ||
				tokens.accessToken !== rejectedAccessToken
			) {
				return tokens;
			}
			// A normal validation was already running when another API request
			// rejected that token. Follow it with one shared forced refresh.
			return youtubeAuth.getValidTokens(accountId, rejectedAccessToken);
		}

		async function validateToken(): Promise<Tokens> {
			const tokens = await getTokens(accountId);
			const expiresAt = tokens.expiresAt ?? 0;

			if (
				tokens.accessToken !== rejectedAccessToken &&
				Date.now() < expiresAt - ACCESS_TOKEN_EXPIRY_BUFFER
			) {
				return tokens;
			}

			if (
				!tokens.clientId ||
				!tokens.clientSecret ||
				!tokens.refreshToken
			) {
				throw new YouTubeReauthorizationError(
					'This YouTube account is missing its Desktop OAuth credentials and must be reconnected.',
				);
			}

			let response;
			try {
				response = await youtubeAuth.refreshAccessToken(
					tokens.clientId,
					tokens.clientSecret,
					tokens.refreshToken,
				);
			} catch (error) {
				const { code, status } = getYouTubeErrorDetails(error);
				if (
					(status === 400 || status === 401) &&
					code &&
					[
						'invalid_grant',
						'invalid_client',
						'unauthorized_client',
						'deleted_client',
					].includes(code)
				) {
					throw new YouTubeReauthorizationError(
						`Google rejected the saved YouTube authorization (${code}). Reconnect this account.`,
						{ cause: error },
					);
				}
				// A timeout, offline network, 429, or Google 5xx is retryable.
				// Retain the refresh token and do not mark the account disconnected.
				throw error;
			}
			const { access_token, expires_in, refresh_token } = response;
			if (
				!access_token ||
				!Number.isFinite(expires_in) ||
				expires_in <= 0
			) {
				throw new Error(
					'Google returned an invalid OAuth token response. Retrying without replacing saved credentials.',
				);
			}
			return setTokens(
				accountId,
				access_token,
				refresh_token ?? tokens.refreshToken,
				{
					clientId: tokens.clientId,
					clientSecret: tokens.clientSecret,
					expiresAt: Date.now() + expires_in * 1000,
				},
			);
		}

		const promise = validateToken().finally(() => {
			validationPromises.delete(accountId);
		});
		validationPromises.set(accountId, {
			promise,
			forced: rejectedAccessToken !== undefined,
		});
		return promise;
	},
};

export default youtubeAuth;
