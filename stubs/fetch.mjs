/**
 * Download each pinned stub source into `.cache/stubs/`.
 *
 * Node only, no shell: `tar`, `curl` and `git` are not spelled the same way on
 * every platform a contributor might build this on, and a build step that works
 * on one of them is worse than one that works nowhere.
 *
 * **The cache holds the archive exactly as it was served**, one file per source
 * rather than an unpacked tree. CircuitPython alone would otherwise be several
 * thousand files and directories, and keeping the bytes upstream sent is what
 * makes them auditable later. Unpacking is cheap and happens in memory, here and
 * again in `assemble.mjs`.
 *
 * Two modes per source, the same shape the host project uses for its VS Code
 * bundle. **Locked** when `sha256` is set: the downloaded archive must match, or
 * the build fails. **Tracking** when it is `null`: the checksum is printed for
 * pasting into `config.json`, which is how a source is pinned in the first place
 * and how a deliberate bump is re-pinned.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { digest, extractArchive, selectTree, verifyArchive } from './archive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(here, 'config.json');
/** Beside the project's other downloads, not under `stubs/`, which is source. */
const CACHE = path.join(here, '..', '.cache', 'stubs');

/** Where a source's archive is cached, and what `assemble.mjs` reads. */
export function cachedArchive(id, source) {
	return path.join(CACHE, `${id}.${source.format}`);
}

/** The files a source contributes, from the archive as downloaded. */
export function sourceTree(archive, source) {
	return selectTree(extractArchive(archive, source.format, upstreamName(source.url)), source);
}

/**
 * What a `raw` source's one file is called upstream, and so here too. Ignored by
 * every other format, whose names come from inside the archive.
 */
const upstreamName = (url) => url.split('?')[0].split('/').filter(Boolean).pop();

export async function readConfig() {
	return JSON.parse(await readFile(CONFIG, 'utf8'));
}

/**
 * @param {string[]} [only] source ids to fetch; all of them when empty
 * @returns {Promise<Record<string, string>>} the digest of each source's tree
 */
export async function fetchStubs(only = []) {
	const { sources } = await readConfig();
	const wanted = only.length ? only : Object.keys(sources);

	const digests = {};
	for (const id of wanted) {
		const source = sources[id];
		if (!source) throw new Error(`no stub source "${id}" in ${path.relative(here, CONFIG)}`);
		digests[id] = await fetchSource(id, source);
	}
	return digests;
}

async function fetchSource(id, source) {
	const file = cachedArchive(id, source);

	// Hashed on the way in rather than trusted from a stamp file: this is build
	// output, and a run interrupted mid-write leaves a file that exists and is
	// not what it claims. One read and one hash, no unpacking.
	if (existsSync(file)) {
		const cached = digest(await readFile(file));
		if (cached === source.sha256) {
			console.log(`[stubs] ${id}: cached (${cached.slice(0, 12)})`);
			return cached;
		}
		console.log(`[stubs] ${id}: cache does not match the pin, re-fetching`);
	}

	console.log(`[stubs] ${id}: downloading ${source.url}`);
	const archive = await download(id, source.url);
	const sha256 = digest(archive);

	// Before anything is written: a download that fails its pin must not be left
	// on disk looking like a cache hit for the next run.
	if (source.sha256) verifyArchive(id, archive, source.sha256);
	else console.log(`[stubs] ${id}: NOT PINNED. Set "sha256": "${sha256}" in stubs/config.json`);

	// Unpacked here only to report the count and to fail now rather than in
	// `assemble.mjs` if `include` no longer names anything.
	const files = sourceTree(archive, source);

	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, archive);
	console.log(`[stubs] ${id}: ${files.size} files at ${source.version} (${sha256.slice(0, 12)})`);
	return sha256;
}

/** One attempt: a glitch is a re-run away, and a re-run is a cache hit for everything already there. */
async function download(id, url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${id}: could not download ${url}: ${response.status} ${response.statusText}`);
	}
	return Buffer.from(await response.arrayBuffer());
}

// `pathToFileURL`, not a template string: only it produces the percent-encoding
// and the `file:///C:/` shape `import.meta.url` carries on Windows.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	fetchStubs(process.argv.slice(2)).catch((error) => {
		console.error(String(error));
		process.exit(1);
	});
}
