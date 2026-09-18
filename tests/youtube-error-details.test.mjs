import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import axios from 'axios';

const source = readFileSync(
	new URL('../src/helpers/services/youtube/youtubeError.ts', import.meta.url),
	'utf8',
);
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText;
const exports = {};
const context = {
	exports,
	structuredClone,
	require(name) {
		if (name === 'axios') return { default: axios, ...axios };
		throw new Error(`Unexpected import: ${name}`);
	},
};
vm.createContext(context);
vm.runInContext(compiled, context);

test('parses safe Rust OAuth errors even when Tauri wraps them in Error', () => {
	const serialized = JSON.stringify({
		source: 'google-oauth',
		status: 400,
		code: 'invalid_grant',
		message: 'Google OAuth token request failed: invalid_grant (HTTP 400).',
	});
	assert.deepEqual(JSON.parse(JSON.stringify(exports.getYouTubeErrorDetails(serialized))), {
		message: 'Google OAuth token request failed: invalid_grant (HTTP 400).',
		status: 400,
		code: 'invalid_grant',
	});
	const wrappedError = vm.runInContext(`new Error(${JSON.stringify(serialized)})`, context);
	assert.deepEqual(JSON.parse(JSON.stringify(exports.getYouTubeErrorDetails(wrappedError))), {
		message: 'Google OAuth token request failed: invalid_grant (HTTP 400).',
		status: 400,
		code: 'invalid_grant',
	});
});

test('does not expose Axios request headers in the safe details', () => {
	const error = new axios.AxiosError('Request failed', 'ERR_BAD_REQUEST', {
		headers: { Authorization: 'Bearer secret-access-token' },
	});
	error.response = {
		status: 500,
		data: { error: { message: 'temporary failure', errors: [{ reason: 'backendError' }] } },
		statusText: 'Server Error',
		headers: {},
		config: error.config,
	};
	const details = exports.getYouTubeErrorDetails(error);
	assert.deepEqual(JSON.parse(JSON.stringify(details)), {
		message: 'temporary failure',
		status: 500,
		code: 'ERR_BAD_REQUEST',
		reason: 'backendError',
	});
	assert(!JSON.stringify(details).includes('secret-access-token'));
});
