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
 * Build targets this extension produces, rooted at `outDir`: two bundles and one
 * verbatim copy. Exported so a host project can build it from source without a
 * VSIX. The layout is load-bearing: the client builds both worker URLs from
 * `context.extensionUri`, so these paths are a contract with `activate`.
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
			...SHARED,
			// IIFE: this is loaded with `importScripts`, by VS Code's nested-worker
			// polyfill, and it loads the engine the same way. See `engine-host.ts`.
			entryPoints: [path.join(here, 'client', 'src', 'engineWorkerMain.ts')],
			format: 'iife',
			outfile: path.join(outDir, 'client', 'dist', 'engineWorkerMain.js'),
		},
		{
			// Copied verbatim, never bundled: the engine ships as published, and
			// byte-identity with the pinned package is what makes its undocumented
			// worker protocol auditable across bumps. Everything we need to change
			// about its behaviour happens in `engineWorkerMain.js` before it loads.
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
