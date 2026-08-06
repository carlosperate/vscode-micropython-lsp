import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Prebuilt pyright worker, vendored from the pinned `browser-basedpyright`. */
export const PYRIGHT_WORKER = path.join(
	here,
	'node_modules',
	'browser-basedpyright',
	'dist',
	'pyright.worker.js'
);

const SHARED = {
	bundle: true,
	platform: 'browser',
	target: 'es2020',
	mainFields: ['module', 'main'],
	external: ['vscode'],
	sourcemap: true,
	logLevel: 'warning',
	// Resolve from here, not the host project's cwd.
	absWorkingDir: here,
};

/**
 * Build targets this extension produces, rooted at `outDir`: one bundle and
 * one verbatim copy. Exported so a host project can build it from source
 * without a VSIX. The layout is load-bearing: the client builds the worker URL
 * from `context.extensionUri`, so `assets/` must land where it expects.
 *
 * @param {string} outDir directory to assemble into
 * @returns {import('esbuild').BuildOptions[]}
 */
export function getBuildTargets(outDir = here) {
	return [
		{
			...SHARED,
			// CJS: the extension host `require()`s this.
			entryPoints: [path.join(here, 'client', 'src', 'browserClientMain.ts')],
			format: 'cjs',
			alias: { path: 'path-browserify' },
			outfile: path.join(outDir, 'client', 'dist', 'browserClientMain.js'),
		},
		{
			// Copied verbatim, never bundled: the polyfill loads it with
			// `importScripts`, and byte-identity with the pinned package is what
			// makes the undocumented worker protocol auditable across bumps.
			absWorkingDir: here,
			entryPoints: [PYRIGHT_WORKER],
			loader: { '.js': 'copy' },
			outfile: path.join(outDir, 'assets', 'pyright.worker.js'),
			logLevel: 'warning',
		},
	];
}

/** Build every bundle into `outDir`. */
export async function build(outDir = here) {
	await Promise.all(getBuildTargets(outDir).map((options) => esbuild.build(options)));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	build().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
