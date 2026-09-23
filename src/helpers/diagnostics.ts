import { safeLogText } from './safeLog';
import type { Accounts } from './json/accounts';
import type { WidgetMeta } from './json/widgetMeta';
import { getConnections } from './connectionStatus';
export function redactDiagnosticLog(text: string) {
	return text
		.split(/\r?\n/)
		.slice(-2000)
		.map(line =>
			safeLogText(line).replace(/https?:\/\/[^\s"<>]+/gi, url => {
				try {
					const parsed = new URL(url);
					if (
						[
							'localhost',
							'127.0.0.1',
							'[::1]',
							'tauri.localhost',
						].includes(parsed.hostname)
					)
						return '[local URL omitted]';
					parsed.username = '';
					parsed.password = '';
					parsed.search = '';
					parsed.hash = '';
					return parsed.toString();
				} catch {
					return '[URL omitted]';
				}
			}),
		)
		.join('\n');
}
export function buildDiagnostics(
	version: string,
	accounts: Accounts,
	widgets: Record<string, WidgetMeta>,
	logs: string,
) {
	const connections = getConnections();
	return {
		format: 'slime2-diagnostics-v1',
		createdAt: new Date().toISOString(),
		version,
		accounts: Object.values(accounts).map(a => ({
			service: a.service,
			type: a.type,
			reauthorize: a.reauthorize,
			connection: a.reauthorize
				? { state: 'reauthorize' }
				: (connections[a.id] ?? { state: 'idle' }),
		})),
		widgets: Object.values(widgets).map(w => ({
			name: safeLogText(w.name),
			version: safeLogText(w.version),
			type: w.type,
		})),
		logs: redactDiagnosticLog(logs),
	};
}
