import esbuild from 'esbuild';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This script lives in config/, but every path below (node_modules, client/src,
// assets/) is repo-root-relative, so `root` steps back up out of config/.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** Generated device stubs. Built by `stubs/assemble.mjs`, not by esbuild. */
const STUBS = path.join(root, 'assets', 'stubs');

/** What a stub asset can be, and the only extensions the copy target will take. */
const STUB_LOADERS = { '.json': 'copy', '.md': 'copy' };

/** Prebuilt pyright worker, vendored from the pinned `browser-basedpyright`. */
export const PYRIGHT_WORKER = path.join(
	root,
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
	// Resolve from the project root, not the host project's cwd.
	absWorkingDir: root,
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
export function getBuildTargets(outDir = root) {
	// Checked on every build, copied only when the output is somewhere else:
	// `stubs/assemble.mjs` writes these into `assets/stubs/` in place, and esbuild
	// refuses to overwrite a file it was given as input.
	const stubs = stubFiles();
	const copyStubs = path.resolve(outDir) !== root;

	return [
		{
			...SHARED,
			// CJS: the extension host `require()`s this.
			entryPoints: [path.join(root, 'client', 'src', 'browserClientMain.ts')],
			format: 'cjs',
			alias: { path: 'path-browserify' },
			outfile: path.join(outDir, 'client', 'dist', 'browserClientMain.js'),
		},
		{
			...SHARED,
			// IIFE: this is loaded with `importScripts`, by VS Code's nested-worker
			// polyfill, and it loads the engine the same way. See `engine-host.ts`.
			entryPoints: [path.join(root, 'client', 'src', 'engineWorkerMain.ts')],
			format: 'iife',
			outfile: path.join(outDir, 'client', 'dist', 'engineWorkerMain.js'),
		},
		{
			// Copied verbatim, never bundled: the engine ships as published, and
			// byte-identity with the pinned package is what makes its undocumented
			// worker protocol auditable across bumps. Everything we need to change
			// about its behaviour happens in `engineWorkerMain.js` before it loads.
			absWorkingDir: root,
			entryPoints: [PYRIGHT_WORKER],
			loader: { '.js': 'copy' },
			outfile: path.join(outDir, 'assets', 'pyright.worker.js'),
			logLevel: 'warning',
		},
		...(copyStubs
			? [
					{
						// The generated stub layers, copied rather than bundled. One target
						// with many entry points, not one target each: the catalogue reaches
						// 646 board files and esbuild would otherwise run once per board.
						absWorkingDir: root,
						entryPoints: stubs,
						loader: STUB_LOADERS,
						outdir: path.join(outDir, 'assets', 'stubs'),
						outbase: STUBS,
						logLevel: 'warning',
					},
			  ]
			: []),
	];
}

/**
 * Every generated stub asset, as absolute paths.
 *
 * Missing means the build was never run, and the failure it causes is silent and
 * late: the extension reads a catalogue that is not there, falls back to the
 * engine's CPython typeshed, and offers a learner `subprocess`. So this refuses
 * to build rather than shipping an extension with no device types in it.
 */
function stubFiles() {
	if (!existsSync(STUBS)) {
		throw new Error('assets/stubs/ is missing. Run `npm run stubs` in micropython-lsp/ first.');
	}
	const walk = (dir) =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
		);

	// Filtered, not passed whole: esbuild fails a build outright on an entry point
	// whose extension has no loader, so one `.DS_Store` from a Finder visit would
	// otherwise break every out-of-tree build.
	const files = walk(STUBS).filter((file) => STUB_LOADERS[path.extname(file)]);
	if (files.length === 0) {
		throw new Error('assets/stubs/ holds no stub assets. Run `npm run stubs` in micropython-lsp/ first.');
	}
	return files;
}

/** Build every bundle into `outDir`. */
export async function build(outDir = root) {
	await Promise.all(getBuildTargets(outDir).map((options) => esbuild.build(options)));
}

// `pathToFileURL`, not a template string: only it produces the percent-encoding
// and the `file:///C:/` shape `import.meta.url` carries on Windows.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	build().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
