import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- plain .mjs config, no types
import { build, getBuildTargets, PYRIGHT_WORKER } from '../config/esbuild.config.mjs';
import { LOAD_ENGINE } from '../client/src/engine-host';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

/** One build for the whole file: it copies 17.8 MB, so three would be felt. */
let outDir: string;
let client: Buffer;
let host: Buffer;
let worker: Buffer;

beforeAll(async () => {
	outDir = await mkdtemp(path.join(tmpdir(), 'micropython-lsp-build-'));
	await build(outDir);
	[client, host, worker] = await Promise.all([
		readFile(path.join(outDir, 'client', 'dist', 'browserClientMain.js')),
		readFile(path.join(outDir, 'client', 'dist', 'engineWorkerMain.js')),
		readFile(path.join(outDir, 'assets', 'pyright.worker.js')),
	]);
}, 60_000);

afterAll(async () => {
	await rm(outDir, { recursive: true, force: true });
});

/**
 * Output paths of the targets that emit one named file.
 *
 * The stub layers are a many-entry copy target addressed by `outdir`, so they
 * have no `outfile` and are not what these assertions are about.
 */
function singleFileTargets(): string[] {
	return getBuildTargets(outDir)
		.map((target: { outfile?: string }) => target.outfile)
		.filter((out: string | undefined): out is string => out !== undefined);
}

/** Every `BackgroundAnalysisBase` request that awaits a reply port upstream. */
const AWAITED_REQUESTS = ['analyzeFile', 'analyzeFileAndGetDiagnostics', 'writeBaseline', 'writeTypeStub'];

/** Both workers are loaded with `importScripts`, which cannot take a module. */
function expectClassicScript(source: string): void {
	expect(source).not.toMatch(/^\s*export\s/m);
	expect(source).not.toMatch(/^\s*import\s.*\sfrom\s/m);
}

// Guards constraints VS Code imposes that are invisible in the source: the host
// `require()`s the client, and the client builds the worker URLs from
// `context.extensionUri`, so the asset paths are a contract between the two.
describe('extension bundles', () => {
	it('emits the client as CommonJS so the extension host can require it', () => {
		const source = client.toString('utf8');
		expect(source).toMatch(/module\.exports/);
		expect(source).toMatch(/activate/);
		expect(source).not.toMatch(/^\s*export\s/m);
	});

	// A target that moves without the client moving with it is a 404 at runtime
	// and green everywhere else.
	it('keeps the client and both worker paths in agreement', () => {
		const workers = singleFileTargets().filter((out) => !out.endsWith('browserClientMain.js'));
		expect(workers).toHaveLength(2);
		const source = client.toString('utf8');
		for (const out of workers) {
			expect(source).toContain(path.relative(outDir, out).split(path.sep).join('/'));
		}
	});

	it('points the manifest `browser` field at a bundle the build emits', async () => {
		const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
		const emitted = singleFileTargets().map((out) => './' + path.relative(outDir, out).split(path.sep).join('/'));
		expect(emitted).toContain(manifest.browser);
	});

	// Every asset the manifest names has to be one the build emits. The icon was
	// declared and not copied, which VS Code shows as a placeholder in the
	// Extensions view and reports nowhere, and only an out-of-tree build like this
	// one can see it: in-tree the file is already sitting where the manifest says.
	it('emits every file the manifest points at', async () => {
		const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
		for (const asset of [manifest.icon, manifest.browser]) {
			expect((await stat(path.join(outDir, ...asset.split('/')))).isFile(), asset).toBe(true);
		}
	});

	// The stub layers, which are copied rather than bundled and are addressed by
	// directory. The client builds this path from `context.extensionUri`, so it is
	// the same coupling the worker paths above are guarding.
	it('assembles the stub catalogue where the client looks for it', async () => {
		const catalogue = path.join(outDir, 'assets', 'stubs', 'catalogue.json');
		expect((await stat(catalogue)).isFile()).toBe(true);
		expect(client.toString('utf8')).toContain('assets/stubs');

		const { targets } = JSON.parse(await readFile(catalogue, 'utf8'));
		const ids = targets.map((t: { id: string }) => t.id);
		// `auto` is the default the setting ships with, so a catalogue without it
		// sends every first-time user down the no-stubs fallback.
		expect(ids).toContain('auto');
		expect(ids).toContain('microbit');

		for (const target of targets) {
			for (const layer of target.layers) {
				expect((await stat(path.join(outDir, 'assets', 'stubs', ...layer.split('/')))).isFile()).toBe(true);
			}
		}
	});

	// The dropdown in Settings is generated from the catalogue by `assemble.mjs`,
	// but the manifest is committed, so the two drift the moment someone edits one
	// and does not rebuild. A stale list offers a board that resolves to nothing.
	it('keeps the target dropdown in step with the catalogue', async () => {
		const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
		const setting = manifest.contributes.configuration.properties['micropython-lsp.target'];
		const { targets } = JSON.parse(
			await readFile(path.join(outDir, 'assets', 'stubs', 'catalogue.json'), 'utf8')
		);

		expect(setting.enum).toEqual(targets.map((t: { id: string }) => t.id));
		expect(setting.enumItemLabels).toEqual(targets.map((t: { label: string }) => t.label));
		// The default has to be one of the options, or every new user starts on a
		// value the dropdown says is invalid.
		expect(setting.enum).toContain(setting.default);
	});
});

// Our own worker entry, which VS Code's nested-worker polyfill boots with
// `importScripts` and which then loads the engine the same way. Both halves of
// that only work if it stays a classic script that does not contain the engine.
describe('engine worker entry', () => {
	it('is a classic script, so `importScripts` can load it', () => {
		expectClassicScript(host.toString('utf8'));
	});

	it('carries the load protocol, and so does the end that sends it', () => {
		// It is all this worker knows before the engine exists, and the two ends of
		// it are compiled into separate bundles.
		expect(host.toString('utf8')).toContain(LOAD_ENGINE);
		expect(client.toString('utf8')).toContain(LOAD_ENGINE);
	});

	it('loads the engine rather than containing it', () => {
		expect(host.includes('PyrightBrowserServer')).toBe(false);
		// It is a handful of statements. A bundle anywhere near the engine's size
		// means an import pulled it in.
		expect(host.byteLength).toBeLessThan(100_000);
	});
});

// The pyright worker is a prebuilt vendor artefact, not something we compile.
// Its protocol is undocumented and the package is CI-auto-published, so the
// build must reproduce it byte-for-byte from the pinned version; anything else
// means we are shipping something we did not audit.
describe('vendored pyright worker', () => {
	it('copies the worker verbatim from the pinned package', async () => {
		expect(worker.equals(await readFile(PYRIGHT_WORKER))).toBe(true);
	});

	it('stays a classic script so `importScripts` can load it', () => {
		// Only the head and tail matter: embedded typeshed `.pyi` text is full of
		// Python `import` lines that a whole-file regex would trip over.
		const head = worker.subarray(0, 4096).toString('utf8');
		expect(head).toMatch(/^\(\(\)=>\{/);
		expectClassicScript(head);
		expectClassicScript(worker.subarray(worker.length - 4096).toString('utf8'));
	});

	// Whether `startPortsOnListen` is still doing anything. All four, not just the
	// one that costs us diagnostics, because this gets fixed a call site at a time
	// and a narrow fix would otherwise read here as "safe to delete".
	it('still leaves reply ports unstarted, so the port fix is still needed', () => {
		const source = worker.toString('utf8');

		const unstarted = AWAITED_REQUESTS.filter((request) => {
			const site = source.indexOf(`requestType:"${request}",data:`);
			expect(site, `no request site for ${request}: the background analysis protocol moved`).toBeGreaterThan(-1);

			// Back to the head of the method, so this reads the real call site rather
			// than a fixed window of minified text. Spanning past it would borrow the
			// previous method's `start()`, and a missing anchor would slice nothing and
			// read as "no waiter" rather than as the moved marker it is.
			const head = source.lastIndexOf('createMessageChannel)()', site);
			expect(head, `${request} no longer opens its own message channel`).toBeGreaterThan(-1);
			const method = source.slice(head, site);
			expect(method, `${request} shares a message channel with an earlier call`).not.toContain('requestType:"');
			expect(method, `${request} no longer awaits a reply port`).toContain('getBackgroundWaiter');
			return !method.includes('.start()');
		});

		expect(
			unstarted,
			'every awaited reply port is started upstream now, so startPortsOnListen in engine-host.ts ' +
				'is redundant and can go, with its test and this one'
		).not.toEqual([]);
	});

	it('does not ship the 2.67 MB source map', async () => {
		await expect(stat(path.join(outDir, 'assets', 'pyright.worker.js.map'))).rejects.toThrow();
	});

	it('is not inlined into the client bundle', () => {
		// A stray `import` of the worker would balloon the client and break the
		// contract that it stays a separately-fetched classic script.
		expect(client.includes('PyrightBrowserServer')).toBe(false);
		expect(worker.byteLength).toBeGreaterThan(10_000_000);
		// Generous: inlining would put the whole 17.8 MB worker in here.
		expect(client.byteLength).toBeLessThan(5_000_000);
	});
});
