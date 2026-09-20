import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

// Import the generated route tree
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

// Create a new router instance
const router = createRouter({ routeTree });

// Register the router instance for type safety
declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}

let bootRequests = 0;
const bootRequest: typeof globalThis.slime2.request = async (
	...args: any[]
) => {
	if (bootRequests >= 64)
		throw new Error('Too many pending Slime2 widget requests.');
	bootRequests++;
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => finish(new Error('Slime2 is not connected.')),
				15000,
			);
			function finish(error?: Error) {
				clearTimeout(timer);
				removeEventListener('slime2:connected', connected);
				if (error) reject(error);
				else resolve();
			}
			function connected() {
				finish();
			}
			addEventListener('slime2:connected', connected);
		});
		return (
			globalThis.slime2.request as (...values: any[]) => Promise<unknown>
		)(...args);
	} finally {
		bootRequests--;
	}
};

// Setup slime2 global var for the widget to use
globalThis.slime2 = {
	request: bootRequest,
	widgetId: null,
};

// Render the app
const rootElement = document.getElementById('root')!;
if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(
		<StrictMode>
			<RouterProvider router={router} />
		</StrictMode>,
	);
}
