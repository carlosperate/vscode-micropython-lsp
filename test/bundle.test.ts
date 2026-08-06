import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- plain .mjs config, no types
import { build, getBuildTargets, PYRIGHT_WORKER } from '../esbuild.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

// Guards constraints VS Code imposes that are invisible in the source: the host
// `require()`s the client, and the client builds the worker URL from
// `context.extensionUri`, so the asset path is a contract between the two.
describe('extension bundles', () => {
	let outDir: string;
	let client: string;

	beforeAll(async () => {
		outDir = await mkdtemp(path.join(tmpdir(), 'python-lsp-build-'));
		await build(outDir);
		client = await readFile(path.join(outDir, 'client', 'dist', 'browserClientMain.js'), 'utf8');
	}, 60_000);

	afterAll(async () => {
		await rm(outDir, { recursive: true, force: true });
	});

	it('emits the client as CommonJS so the extension host can require it', () => {
		expect(client).toMatch(/module\.exports/);
		expect(client).toMatch(/activate/);
		expect(client).not.toMatch(/^\s*export\s/m);
	});

	it('keeps the client and the copied worker path in agreement', async () => {
		const workerTarget = getBuildTargets(outDir).find((t: { outfile: string }) =>
			t.outfile.endsWith('pyright.worker.js')
		);
		const relative = path.relative(outDir, workerTarget.outfile).split(path.sep).join('/');
		expect(client).toContain(relative);
	});

	it('points the manifest `browser` field at a bundle the build emits', async () => {
		const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
		const emitted = getBuildTargets(outDir).map((t: { outfile: string }) =>
			'./' + path.relative(outDir, t.outfile).split(path.sep).join('/')
		);
		expect(emitted).toContain(manifest.browser);
	});
});

// The pyright worker is a prebuilt vendor artefact, not something we compile.
// Its protocol is undocumented and the package is CI-auto-published, so the
// build must reproduce it byte-for-byte from the pinned version; anything else
// means we are shipping something we did not audit.
describe('vendored pyright worker', () => {
	let outDir: string;
	let worker: Buffer;

	beforeAll(async () => {
		outDir = await mkdtemp(path.join(tmpdir(), 'python-lsp-asset-'));
		await build(outDir);
		worker = await readFile(path.join(outDir, 'assets', 'pyright.worker.js'));
	}, 60_000);

	afterAll(async () => {
		await rm(outDir, { recursive: true, force: true });
	});

	it('copies the worker verbatim from the pinned package', async () => {
		expect(worker.equals(await readFile(PYRIGHT_WORKER))).toBe(true);
	});

	it('stays a classic script so `importScripts` can load it', () => {
		// Only the head and tail matter: embedded typeshed `.pyi` text is full of
		// Python `import` lines that a whole-file regex would trip over.
		const head = worker.subarray(0, 4096).toString('utf8');
		const tail = worker.subarray(worker.length - 4096).toString('utf8');
		expect(head).toMatch(/^\(\(\)=>\{/);
		for (const edge of [head, tail]) {
			expect(edge).not.toMatch(/^\s*export\s/m);
			expect(edge).not.toMatch(/^\s*import\s.*\sfrom\s/m);
		}
	});

	it('does not ship the 2.67 MB source map', async () => {
		await expect(stat(path.join(outDir, 'assets', 'pyright.worker.js.map'))).rejects.toThrow();
	});

	it('is not inlined into the client bundle', async () => {
		const client = await readFile(path.join(outDir, 'client', 'dist', 'browserClientMain.js'));
		// A stray `import` of the worker would balloon the client and break the
		// contract that it stays a separately-fetched classic script.
		expect(client.includes('PyrightBrowserServer')).toBe(false);
		expect(worker.byteLength).toBeGreaterThan(10_000_000);
		// Generous: inlining would put the whole 17.8 MB worker in here.
		expect(client.byteLength).toBeLessThan(5_000_000);
	});
});
