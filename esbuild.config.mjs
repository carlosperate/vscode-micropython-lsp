import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Two bundles with different module formats, so two esbuild invocations.
// Settings mirror the upstream sample's webpack config.
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
 * Bundles this extension produces, rooted at `outDir`. Exported so a host
 * project can build it from source without a VSIX. Layout is load-bearing:
 * the client hardcodes the server's path.
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
			// IIFE, never ESM: VS Code's nested-worker polyfill loads this with
			// `importScripts`, which needs a classic script. See test/bundle.test.ts.
			entryPoints: [path.join(here, 'server', 'src', 'browserServerMain.ts')],
			format: 'iife',
			globalName: 'serverExportVar',
			outfile: path.join(outDir, 'server', 'dist', 'browserServerMain.js'),
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
