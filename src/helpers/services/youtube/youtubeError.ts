import axios from 'axios';

type GoogleApiError = {
	error?: {
		code?: number;
		message?: string;
		errors?: Array<{
			message?: string;
			reason?: string;
		}>;
	};
};

export type YouTubeErrorDetails = {
	message: string;
	status?: number;
	code?: string;
	reason?: string;
};

/**
 * Convert an API failure to a small, safe object for both logs and UI messages.
 * Axios errors retain the complete request configuration, including the OAuth
 * Authorization header, so they must never be written to the application log.
 */
export function getYouTubeErrorDetails(error: unknown): YouTubeErrorDetails {
	if (axios.isAxiosError<GoogleApiError>(error)) {
		const apiError = error.response?.data?.error;
		const details: YouTubeErrorDetails = {
			message: apiError?.message ?? error.message,
		};

		if (error.response?.status !== undefined) {
			details.status = error.response.status;
		}
		if (error.code) details.code = error.code;

		const reason = apiError?.errors?.[0]?.reason;
		if (reason) details.reason = reason;

		return details;
	}

	if (error instanceof Error) {
		if ('grpcCode' in error && typeof error.grpcCode === 'number') {
			return { message: error.message, code: `GRPC_${error.grpcCode}` };
		}
		return (
			parseGoogleOAuthError(error.message) ?? { message: error.message }
		);
	}

	if (typeof error === 'string') {
		return parseGoogleOAuthError(error) ?? { message: error };
	}

	return { message: 'An unknown error occurred.' };
}

function parseGoogleOAuthError(value: string): YouTubeErrorDetails | undefined {
	// Rust token requests send a deliberately small JSON error, never the
	// request, OAuth credentials, token response, or arbitrary HTTP body.
	try {
		const details = JSON.parse(value);
		if (
			details?.source !== 'google-oauth' ||
			typeof details.message !== 'string'
		) {
			return undefined;
		}
		return {
			message: details.message,
			...(typeof details.code === 'string' ? { code: details.code } : {}),
			...(Number.isInteger(details.status)
				? { status: details.status }
				: {}),
		};
	} catch {
		// Older builds and network failures return plain strings.
		return undefined;
	}
}
