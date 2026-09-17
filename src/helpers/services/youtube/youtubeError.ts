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
		return { message: error.message };
	}

	if (typeof error === 'string') {
		return { message: error };
	}

	return { message: 'An unknown error occurred.' };
}
