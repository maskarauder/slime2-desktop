import { readFileSync } from 'node:fs';

// Return a fresh copy so one scenario cannot mutate a later test's fixture.
export function fixture(name) {
	return JSON.parse(
		readFileSync(
			new URL(`../fixtures/${name}.json`, import.meta.url),
			'utf8',
		),
	);
}
