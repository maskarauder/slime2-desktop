const SECRET_KEY =
	/^(?:authorization|proxyauthorization|cookie|setcookie|accesstoken|refreshtoken|clientsecret|apikey|xapikey|token|password|secret|codeverifier|devicecode|usercode)$/i;
const MAX_TEXT = 2048;

function cleanText(text: string): string {
	return text
		.replace(/\b(Bearer|OAuth|Basic)\s+[^\s"',;]+/gi, '$1 [REDACTED]')
		.replace(
			/((?:[?&#]|\b)(?:access_token|refresh_token|client_secret|(?:x[-_]?)?api[-_]?key|token|code|code_verifier|device_code)=)[^\s&#"']+/gi,
			'$1[REDACTED]',
		)
		.replace(
			/(["']?(?:access_?token|refresh_?token|client_?secret|(?:x[-_]?)?api[-_]?key|password|secret|authorization|cookie|device_?code|code_?verifier)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
			'$1[REDACTED]',
		)
		.slice(0, MAX_TEXT);
}

export function safeLogValue(value: unknown): unknown {
	const seen = new WeakSet<object>();
	function visit(item: unknown, depth: number): unknown {
		if (typeof item === 'string') {
			// Serialized JSON needs the same key-level filtering as objects.
			if (item.length <= 64_000 && /^[\s]*[\[{]/.test(item)) {
				try {
					return visit(JSON.parse(item), depth + 1);
				} catch {
					/* text */
				}
			}
			return cleanText(item);
		}
		if (typeof item === 'bigint' || typeof item === 'symbol')
			return String(item);
		if (typeof item === 'function') return '[Function]';
		if (item == null || typeof item !== 'object') return item;
		if (seen.has(item)) return '[Circular]';
		if (depth > 5) return '[Depth limit]';
		seen.add(item);
		const record = item as Record<string, unknown>;
		// HTTP errors contain request headers, request bodies and response objects.
		// Only diagnostic fields are allowed through, never config/request/response.
		if (item instanceof Error || record.isAxiosError === true) {
			const response = record.response as
				| {
						status?: unknown;
						data?: { error?: { code?: unknown; status?: unknown } };
				  }
				| undefined;
			return {
				name: cleanText(String(record.name ?? 'Error')),
				message: cleanText(String(record.message ?? 'Request failed')),
				code: visit(record.code, depth + 1),
				status: visit(response?.status ?? record.status, depth + 1),
			};
		}
		if (Array.isArray(item))
			return item.slice(0, 50).map(value => visit(value, depth + 1));
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(record).slice(0, 50)) {
			result[key] = SECRET_KEY.test(key.replace(/[-_\s]/g, ''))
				? '[REDACTED]'
				: visit(entry, depth + 1);
		}
		return result;
	}
	try {
		return visit(value, 0);
	} catch {
		return '[Unserializable diagnostic]';
	}
}

export function safeLogText(...values: unknown[]): string {
	return values
		.map(value => {
			const safe = safeLogValue(value);
			return typeof safe === 'string'
				? safe
				: (JSON.stringify(safe) ?? String(safe));
		})
		.join(' ')
		.slice(0, 8192);
}
