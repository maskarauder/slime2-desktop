import { z } from 'zod/mini';
import { safeLogText } from './safeLog';

export default function logZodError(error: unknown, _data?: unknown) {
	if (error instanceof z.core.$ZodError) {
		const formattedError = z.prettifyError(error);

		// Avoid logging rejected values; paths and messages identify the schema issue.
		const safe = safeLogText(formattedError);
		console.error(safe);
		return safe;
	} else {
		const safe = safeLogText(error);
		console.error(safe);
		return safe;
	}
}
