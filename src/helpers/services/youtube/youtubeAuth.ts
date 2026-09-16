import {
	exchangeYouTubeOAuthCode,
	refreshYouTubeOAuthToken,
} from '@/helpers/commands';
import {
	deleteTokens,
	getTokens,
	setTokens,
	type Tokens,
} from '../../json/accounts';

const ACCESS_TOKEN_EXPIRY_BUFFER = 60 * 1000;

const validationPromises = new Map<string, Promise<Tokens>>();

export class YouTubeReauthorizationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'YouTubeReauthorizationError';
	}
}

const youtubeAuth = {
	async exchangeAuthorizationCode(
		clientId: string,
		code: string,
		codeVerifier: string,
		redirectUri: string,
	) {
		return exchangeYouTubeOAuthCode(
			clientId,
			code,
			codeVerifier,
			redirectUri,
		);
	},

	async refreshAccessToken(clientId: string, refreshToken: string) {
		return refreshYouTubeOAuthToken(clientId, refreshToken);
	},

	async getValidTokens(accountId: string): Promise<Tokens> {
		const existingPromise = validationPromises.get(accountId);
		if (existingPromise) return existingPromise;

		async function validateToken(): Promise<Tokens> {
			let tokens = await getTokens(accountId);
			const expiresAt = tokens.expiresAt ?? 0;

			if (Date.now() < expiresAt - ACCESS_TOKEN_EXPIRY_BUFFER) {
				return tokens;
			}

			if (!tokens.clientId) {
				throw new YouTubeReauthorizationError(
					'This YouTube account predates desktop OAuth support and must be reconnected.',
				);
			}

			try {
				const response = await youtubeAuth.refreshAccessToken(
					tokens.clientId,
					tokens.refreshToken,
				);
				const { access_token, expires_in, refresh_token } = response;

				tokens = await setTokens(
					accountId,
					access_token,
					refresh_token ?? tokens.refreshToken,
					{
						clientId: tokens.clientId,
						expiresAt: Date.now() + expires_in * 1000,
					},
				);
				return tokens;
			} catch (error) {
				await deleteTokens(accountId);
				throw new YouTubeReauthorizationError(
					'The YouTube authorization could not be refreshed.',
					{ cause: error },
				);
			}
		}

		const promise = validateToken().finally(() => {
			validationPromises.delete(accountId);
		});
		validationPromises.set(accountId, promise);
		return promise;
	},
};

export default youtubeAuth;
