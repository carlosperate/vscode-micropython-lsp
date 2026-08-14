import esbuild from 'esbuild';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This script lives in config/, but every path below (node_modules, client/src,
// assets/) is repo-root-relative, so `root` steps back up out of config/.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** Everything the manifest points at that esbuild does not compile. */
const ASSETS = path.join(root, 'assets');

/** Generated device stubs. Built by `stubs/assemble.mjs`, not by esbuild. */
const STUBS = path.join(ASSETS, 'stubs');

/** The icon `package.json` names. Committed, unlike the rest of `assets/`. */
const ICON = path.join(ASSETS, 'icon.png');

/** What a copied asset can be, and the only extensions the copy target will take. */
const ASSET_LOADERS = { '.json': 'copy', '.md': 'copy', '.png': 'copy' };

/** Inputs the stub catalogue is generated from, so a stale one can be spotted. */
const STUB_SOURCES = [path.join(root, 'stubs', 'config.json'), path.join(root, 'stubs', 'assemble.mjs')];

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
	const assets = assetFiles();
	const copyAssets = path.resolve(outDir) !== root;

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
		...(copyAssets
			? [
					{
						// Everything the manifest names, copied rather than bundled. One
						// target with many entry points, not one target each: the catalogue
						// reaches 646 board files and esbuild would otherwise run once per
						// board.
						absWorkingDir: root,
						entryPoints: assets,
						loader: ASSET_LOADERS,
						outdir: path.join(outDir, 'assets'),
						outbase: ASSETS,
						logLevel: 'warning',
					},
			  ]
			: []),
	];
}

/**
 * Every asset the manifest points at, as absolute paths: the icon, then the
 * generated stub layers.
 *
 * Called on every build, not only the ones that copy, because it is where the
 * guards live and a missing asset is worth refusing an in-tree build over too.
 * A missing catalogue fails silently and late otherwise: the extension reads one
 * that is not there, falls back to the engine's CPython typeshed, and offers a
 * learner `subprocess`. A missing icon is only a 404 in the Extensions view, but
 * it is the same class of thing, a manifest naming a file nothing wrote.
 */
function assetFiles() {
	if (!existsSync(STUBS)) {
		throw new Error('assets/stubs/ is missing. Run `npm run stubs` in micropython-lsp/ first.');
	}
	if (!existsSync(ICON)) {
		throw new Error('assets/icon.png is missing. Run `npm run build:icon` in micropython-lsp/ first.');
	}

	// Existence is not currency. Our own `build` script runs `npm run stubs`
	// first, but a host project builds this by importing `getBuildTargets()`
	// directly and skips that half, so an edited catalogue would otherwise be
	// copied from the previous run and ship a board list nobody asked for.
	const catalogue = statSync(path.join(STUBS, 'catalogue.json')).mtimeMs;
	const edited = STUB_SOURCES.filter((source) => statSync(source).mtimeMs > catalogue);
	if (edited.length) {
		const names = edited.map((source) => path.relative(root, source)).join(', ');
		throw new Error(`assets/stubs/ is older than ${names}. Run \`npm run stubs\` in micropython-lsp/ first.`);
	}
	const walk = (dir) =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
		);

	// Filtered, not passed whole: esbuild fails a build outright on an entry point
	// whose extension has no loader, so one `.DS_Store` from a Finder visit would
	// otherwise break every out-of-tree build.
	const stubs = walk(STUBS).filter((file) => ASSET_LOADERS[path.extname(file)]);
	if (stubs.length === 0) {
		throw new Error('assets/stubs/ holds no stub assets. Run `npm run stubs` in micropython-lsp/ first.');
	}
	return [ICON, ...stubs];
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
