import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
	console.log(
		'npm run verify [--desktop | --web-only]\nDefault: versions, JS tests, both frontend builds/typechecks, transport and gRPC Rust tests.\n--desktop: also compile/test the Tauri app (requires OS build dependencies).\n--web-only: explicitly omit Rust checks.',
	);
} else {
	try {
		if (
			args.length > 1 ||
			args.some(arg => !['--desktop', '--web-only'].includes(arg))
		)
			throw new Error(
				'Unknown or incompatible options; use npm run verify -- --help.',
			);
		// Launch npm through Node: npm.cmd is not executable with shell:false on Windows.
		const npmCli = process.env.npm_execpath;
		if (!npmCli) throw new Error('Run this script with npm run verify.');
		const steps = [
			[
				'Version consistency',
				process.execPath,
				[npmCli, 'run', 'version:check'],
			],
			[
				'JavaScript regression tests and fixtures',
				process.execPath,
				[npmCli, 'test'],
			],
			[
				'Frontend typechecks, builds and generated icons/resources',
				process.execPath,
				[npmCli, 'run', 'before:build'],
			],
		];
		if (!args.includes('--web-only')) {
			for (const crate of [
				'native-tests/',
				'youtube-stream/',
				...(args.includes('--desktop') ? [''] : []),
			])
				steps.push([
					`Rust tests: ${crate || 'desktop'}`,
					'cargo',
					[
						'test',
						'--locked',
						'--manifest-path',
						`src-tauri/${crate}Cargo.toml`,
					],
				]);
		}
		for (const [label, command, commandArgs] of steps) {
			console.log(`\n[verify] ${label}`);
			const result = spawnSync(command, commandArgs, {
				cwd: root,
				stdio: 'inherit',
				shell: false,
			});
			if (result.error)
				throw new Error(
					`${label}: ${result.error.message}. Install the prerequisites in docs/DEVELOPMENT.md.`,
				);
			if (result.status !== 0) {
				process.exitCode = result.status || 1;
				throw new Error(
					`${label} failed${result.signal ? ` (${result.signal})` : ''}; stopping verification.`,
				);
			}
		}
		console.log(
			`\n[verify] Passed${args.includes('--web-only') ? ' (Rust checks explicitly omitted)' : ''}.`,
		);
	} catch (error) {
		console.error(`[verify] ${error.message}`);
		process.exitCode ||= 1;
	}
}
