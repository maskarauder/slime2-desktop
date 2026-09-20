import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
export function loadTs(filename, mocks = {}, globals = {}) {
	const modules = new Map();
	function load(file) {
		if (modules.has(file)) return modules.get(file).exports;
		const module = { exports: {} };
		modules.set(file, module);
		const code = ts.transpileModule(readFileSync(file, 'utf8'), {
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
		}).outputText;
		vm.runInNewContext(
			code,
			{
				module,
				exports: module.exports,
				Error,
				Date,
				URL,
				URLSearchParams,
				AbortController,
				TextEncoder,
				structuredClone,
				console,
				setTimeout,
				clearTimeout,
				setInterval,
				clearInterval,
				crypto,
				...globals,
				require(name) {
					if (Object.hasOwn(mocks, name)) return mocks[name];
					if (name.startsWith('.') || name.startsWith('@/')) {
						let next = name.startsWith('@/')
							? path.join(root, 'src', name.slice(2))
							: path.resolve(path.dirname(file), name);
						next =
							[
								next,
								next + '.ts',
								next + '.tsx',
								path.join(next, 'index.ts'),
							].find(
								candidate =>
									existsSync(candidate) &&
									!candidate.endsWith('/index'),
							) ?? next;
						return load(next);
					}
					return require(name);
				},
			},
			{ filename: file },
		);
		return module.exports;
	}
	return load(path.resolve(root, filename));
}
