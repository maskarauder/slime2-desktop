import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function harness(t, fail = false) {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'slime2 verify '));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const cli = path.join(directory, 'mock npm.mjs');
	const calls = path.join(directory, 'calls.jsonl');
	writeFileSync(calls, '');
	writeFileSync(
		cli,
		`import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.SLIME2_TEST_CALLS, JSON.stringify(args) + '\\n');
if (process.env.SLIME2_TEST_FAIL === 'yes' && args[0] === 'test') process.exitCode = 7;
`,
	);
	return {
		run: args =>
			spawnSync(
				process.execPath,
				[
					fileURLToPath(
						new URL('../scripts/verify.mjs', import.meta.url),
					),
					...args,
				],
				{
					env: {
						...process.env,
						npm_execpath: cli,
						SLIME2_TEST_CALLS: calls,
						SLIME2_TEST_FAIL: fail ? 'yes' : 'no',
					},
					encoding: 'utf8',
				},
			),
		calls: () =>
			readFileSync(calls, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map(line => JSON.parse(line)),
	};
}

test('verification launches npm paths with spaces and explicitly reports omitted native checks', t => {
	const h = harness(t);
	const result = h.run(['--web-only']);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Rust checks explicitly omitted/);
	assert.deepEqual(h.calls(), [
		['run', 'version:check'],
		['test'],
		['run', 'before:build'],
	]);
});

test('verification preserves a failed step exit code and does not build after failing tests', t => {
	const h = harness(t, true);
	const result = h.run(['--web-only']);
	assert.equal(result.status, 7);
	assert.match(result.stderr, /stopping verification/);
	assert.deepEqual(h.calls(), [['run', 'version:check'], ['test']]);
});

test('verification rejects mistyped or contradictory options before executing checks', t => {
	const h = harness(t);
	for (const args of [['--deskotp'], ['--desktop', '--web-only']])
		assert.equal(h.run(args).status, 1);
	assert.deepEqual(h.calls(), []);
});
