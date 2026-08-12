/**
 * Which stubs the engine is seeded with, and where they land in its filesystem.
 *
 * A target is one board's world: the modules its firmware actually has, and
 * nothing else. Boards are never merged, and that is a correctness rule rather
 * than a size one. At one MicroPython release `machine` has seven distinct port
 * variants and they are not supersets of each other, so any merge silently picks
 * a winner and offers a Pico user `machine.TouchPad`.
 *
 * Seeds are layered rather than pre-composed because pre-composition does not
 * fit: 628 CircuitPython boards each carrying their own copy of the core is
 * 435 MB. A shared base plus one board overlay, merged when the target loads,
 * is 2.8 MB.
 *
 * No `vscode` import: the one impure step, reading an asset, arrives as an
 * injected `ReadStub`, so the catalogue, the merge and the re-keying are all
 * unit-testable in Node.
 */

/**
 * Where a target's stubs are seeded, as a POSIX path in the engine's in-memory
 * filesystem. It is never a path on anyone's disk, on any platform.
 *
 * Deliberately not `/typeshed`: `initialize` merges the engine's own embedded
 * CPython typeshed into that root unconditionally, so seeding there would put
 * `subprocess` and the rest of desktop Python back beside the board's modules.
 * Pointing the engine at a separate root is the whole of the bypass.
 */
export const TARGET_TYPESHED = '/mp-typeshed';

/** The same root as a URI, which is the shape `typeshedPaths` takes. */
export const TARGET_TYPESHED_URI = `file://${TARGET_TYPESHED}`;

/**
 * The default, and a real catalogue entry rather than a special case here: the
 * flavour-neutral stdlib with no board modules. Everything resolves it through
 * the same lookup, and "the user has not chosen a board yet" stays a plain
 * comparison for whatever wants to fill it in.
 */
export const AUTO_TARGET = 'auto';

/** The catalogue's own name, inside whichever folder `ReadStub` addresses. */
export const CATALOGUE = 'catalogue.json';

/** One entry of the shipped catalogue. */
export interface Target {
	readonly id: string;
	readonly label: string;
	/** Chip family, so a 628-entry picker can be grouped. */
	readonly group?: string;
	/** Layer files to merge, in order, addressed from the catalogue's own folder. */
	readonly layers: readonly string[];
}

export interface Catalogue {
	readonly targets: readonly Target[];
}

/** One layer file: a slice of a typeshed root. */
export interface Layer {
	/** Paths relative to the typeshed root, mapped to file content. */
	readonly files: Readonly<Record<string, string>>;
}

/** Reads one stub asset, addressed from the folder the catalogue lives in. */
export type ReadStub = (path: string) => Promise<string>;

/** A loaded target: what the engine is seeded with, and what it turned out to be. */
export interface Seed {
	/** What actually loaded, which is `auto` when the requested id is unknown. */
	readonly id: string;
	readonly label: string;
	/** Keyed on paths in the engine's filesystem, the shape `initializationOptions.files` takes. */
	readonly files: Record<string, string>;
}

export function findTarget(catalogue: Catalogue, id: string): Target | undefined {
	return catalogue.targets.find((target) => target.id === id);
}

/**
 * Read one target's layers and merge them into the files to seed.
 *
 * Pure over the reader, so the whole catalogue path is unit-testable: the caller
 * supplies one that reads through `vscode.workspace.fs`, which is the only
 * portable way to reach a bundled asset. Reading it with `fetch` works in a
 * browser and fails on desktop, where the extension URI is `file:`.
 *
 * An unknown id falls back to `auto` and says so through `Seed.id`, because a
 * stale setting naming a board that has since left the catalogue should still
 * analyse Python. Everything else throws: a missing or malformed asset is a
 * broken build, and the caller has to be able to tell the two apart.
 */
export async function loadTarget(read: ReadStub, id: string): Promise<Seed> {
	const catalogue = await readAsset(read, CATALOGUE, parseCatalogue);
	const target = findTarget(catalogue, id) ?? findTarget(catalogue, AUTO_TARGET);
	if (!target) throw new Error(`the stub catalogue has no "${AUTO_TARGET}" entry to fall back to`);

	const layers = await Promise.all(target.layers.map((path) => readAsset(read, path, parseLayer)));
	return { id: target.id, label: target.label, files: composeSeed(layers) };
}

/** Every failure names its file: 646 targets share these parsers. */
async function readAsset<T>(read: ReadStub, path: string, parse: (text: string) => T): Promise<T> {
	try {
		return parse(await read(path));
	} catch (error) {
		throw new Error(`stub asset "${path}": ${String(error)}`);
	}
}

/**
 * Merge layers left to right into the files the engine is seeded with.
 *
 * Later layers win a collision; the build is where an unexpected one is caught,
 * since by here there is nothing useful left to say about it.
 */
export function composeSeed(layers: readonly Layer[], root: string = TARGET_TYPESHED): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const layer of layers) {
		for (const [path, content] of Object.entries(layer.files)) merged[layerPath(path)] = content;
	}

	const base = root.endsWith('/') ? root.slice(0, -1) : root;
	return Object.fromEntries(Object.entries(merged).map(([path, content]) => [`${base}/${path}`, content]));
}

export function parseCatalogue(text: string): Catalogue {
	const catalogue = JSON.parse(text) as Catalogue;
	const targets = catalogue?.targets;
	if (!Array.isArray(targets)) throw new Error('the stub catalogue has no "targets" array');
	for (const target of targets) {
		if (typeof target?.id !== 'string') throw new Error(`a catalogue entry has no "id": ${JSON.stringify(target)}`);
		if (typeof target.label !== 'string') throw new Error(`catalogue entry "${target.id}" has no "label"`);
		if (!Array.isArray(target.layers)) throw new Error(`catalogue entry "${target.id}" has no "layers" array`);
	}
	return { targets };
}

export function parseLayer(text: string): Layer {
	const layer = JSON.parse(text) as Layer;
	if (!layer?.files || typeof layer.files !== 'object') throw new Error('a stub layer has no "files" object');
	return layer;
}

/**
 * Layer paths address a typeshed root, so an absolute one or a `..` segment
 * would seed outside it, and the root immediately above is `/typeshed` itself.
 */
function layerPath(path: string): string {
	if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error(`a stub layer path must be relative to the typeshed root, and "${path}" is not`);
	}
	return path;
}
