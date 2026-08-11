import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- plain .mjs config, no types
import { build, getBuildTargets, PYRIGHT_WORKER } from '../esbuild.config.mjs';
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
		const workers = getBuildTargets(outDir).filter(
			(t: { outfile: string }) => !t.outfile.endsWith('browserClientMain.js')
		);
		expect(workers).toHaveLength(2);
		const source = client.toString('utf8');
		for (const target of workers) {
			expect(source).toContain(path.relative(outDir, target.outfile).split(path.sep).join('/'));
		}
	});

	it('points the manifest `browser` field at a bundle the build emits', async () => {
		const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
		const emitted = getBuildTargets(outDir).map(
			(t: { outfile: string }) => './' + path.relative(outDir, t.outfile).split(path.sep).join('/')
		);
		expect(emitted).toContain(manifest.browser);
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
