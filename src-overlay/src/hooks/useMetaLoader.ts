import { useLoaderData } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { cacheBust, createDataUrl } from '../helpers/serverUrl';
import type { Meta } from '../helpers/widgetApi';

export default function useMetaLoader() {
	const { meta, widgetId } = useLoaderData({ from: '/$' });
	const loadRef = useRef<Promise<void> | null>(null);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		let cancelled = false;
		if (!loadRef.current) {
			setTitle(meta);
			loadCSS(meta, widgetId);
			loadRef.current = loadJS(meta, widgetId);
		}
		void loadRef.current
			.then(() => {
				if (!cancelled) setReady(true);
			})
			.catch(() => {
				if (!cancelled)
					console.error(
						'Unable to load widget scripts. Reload this browser source to retry.',
					);
			});
		return () => {
			cancelled = true;
		};
	}, [meta, widgetId]);
	return ready;
}

// set tab title
function setTitle(meta: Meta) {
	let title = meta.name || 'Slime2 Overlay';
	if (meta.version) title = `${title} v${meta.version}`;
	if (meta.creator) title = `${title} by ${meta.creator}`;

	document.title = title;
}

function loadCSS(meta: Meta, widgetId: string) {
	meta.import?.css?.forEach(css => {
		const linkElement = document.createElement('link');
		linkElement.setAttribute('rel', 'stylesheet');
		linkElement.setAttribute('href', generateImportURL(css, widgetId));
		linkElement.setAttribute('type', 'text/css');
		document.head.appendChild(linkElement);
	});
}

async function loadJS(meta: Meta, widgetId: string) {
	for (const js of meta.import?.js ?? []) {
		const scriptElement = document.createElement('script');

		if (typeof js === 'string') {
			scriptElement.src = generateImportURL(js, widgetId);
		} else {
			Object.entries(js).forEach(([attribute, value]) => {
				if (attribute === 'src') {
					scriptElement.src = generateImportURL(value, widgetId);
				} else {
					scriptElement.setAttribute(attribute, value);
				}
			});
		}

		scriptElement.async = false;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => finish(new Error('Widget script load timed out.')),
				30000,
			);
			function finish(error?: Error) {
				clearTimeout(timer);
				scriptElement.onload = null;
				scriptElement.onerror = null;
				if (error) {
					scriptElement.remove();
					reject(error);
				} else resolve();
			}
			scriptElement.onload = () => finish();
			scriptElement.onerror = () =>
				finish(new Error('Widget script load failed.'));
			document.head.appendChild(scriptElement);
		});
	}
}

function generateImportURL(fileName: string, widgetId: string) {
	const url =
		fileName.startsWith('http://') || fileName.startsWith('https://')
			? fileName
			: createDataUrl(widgetId, `core/${fileName}`);

	return cacheBust(url);
}
