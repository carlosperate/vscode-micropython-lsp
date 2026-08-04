import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- plain .mjs config, no types
import { build, getBuildTargets } from '../esbuild.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

// Guards constraints VS Code imposes that are invisible in the source: the
// nested-worker polyfill loads the server via `importScripts` (classic only),
// the host `require()`s the client, and the client hardcodes the server path.
describe('extension bundles', () => {
	let outDir: string;
	let client: string;
	let server: string;

	beforeAll(async () => {
		outDir = await mkdtemp(path.join(tmpdir(), 'python-lsp-build-'));
		await build(outDir);
		client = await readFile(path.join(outDir, 'client', 'dist', 'browserClientMain.js'), 'utf8');
		server = await readFile(path.join(outDir, 'server', 'dist', 'browserServerMain.js'), 'utf8');
	}, 60_000);

	afterAll(async () => {
		await rm(outDir, { recursive: true, force: true });
	});

	it('emits the server as a classic script, not an ES module', () => {
		expect(server).toMatch(/^"use strict";\s*var serverExportVar = /);
		expect(server).not.toMatch(/^\s*export\s/m);
		expect(server).not.toMatch(/^\s*import\s.*\sfrom\s/m);
	});

	it('emits the client as CommonJS so the extension host can require it', () => {
		expect(client).toMatch(/module\.exports/);
		expect(client).toMatch(/activate/);
		expect(client).not.toMatch(/^\s*export\s/m);
	});

	it('keeps the client and the server output path in agreement', async () => {
		const [, serverTarget] = getBuildTargets(outDir);
		const serverRelative = path
			.relative(outDir, serverTarget.outfile)
			.split(path.sep)
			.join('/');
		expect(client).toContain(serverRelative);
	});

	it('points the manifest `browser` field at a bundle the build emits', async () => {
		const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
		const emitted = getBuildTargets(outDir).map((t: { outfile: string }) =>
			'./' + path.relative(outDir, t.outfile).split(path.sep).join('/')
		);
		expect(emitted).toContain(manifest.browser);
	});
});
