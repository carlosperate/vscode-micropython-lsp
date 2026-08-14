/**
 * Turn the cached archives into `assets/stubs/`, the layers the extension ships.
 *
 * One layer file per slice of a typeshed root, plus a catalogue naming which
 * layers each target merges. The transforms are pure and unit-tested; the
 * orchestration at the bottom reads the cache and writes the output.
 *
 * Fetching is part of this rather than a step to remember: a build that silently
 * assembles a stale or absent cache is the failure the whole pin exists to
 * prevent.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cachedArchive, fetchStubs, readConfig, sourceTree } from './fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, '..', 'assets', 'stubs');

/**
 * micro:bit's board modules, as opposed to the standard library it also ships.
 *
 * Hand-written against a pinned upstream, which is why `splitDevice` throws when
 * one is missing rather than assuming the list is still right. The Easter eggs
 * (`antigravity`, `love`, `this`) are micro:bit's own, so they belong with the
 * board rather than in a flavour-neutral base.
 */
const MICROBIT_DEVICE = [
	'microbit',
	'machine',
	'music',
	'radio',
	'speech',
	'neopixel',
	'audio',
	'log',
	'power',
	'antigravity',
	'love',
	'this',
];

/** The default target, which is first in the dropdown rather than sorted into it. */
const AUTO_TARGET = 'auto';

/** The config key of the standard library every MicroPython board layers onto. */
export const MICROPYTHON_BASE = 'micropython-stdlib';

/** Where that base is written, and what every MicroPython target names first. */
const MICROPYTHON_BASE_LAYER = 'micropython/stdlib.json';

/**
 * How the MicroPython wheels are rearranged into one typeshed root.
 *
 * `stdlib/` and `stubs/` are already the shape a typeshed root wants.
 * `_mpy_shed` is not: it sits beside them at the wheel root, where the engine
 * has no import root pointing at it, and it carries the types six of the
 * standard library's own stubs and every board overlay import from. Left where
 * upstream puts it, those modules still resolve and their members quietly
 * become `Unknown`, which is the failure this phase could ship without noticing.
 */
const MICROPYTHON_BASE_MOVES = [
	{ from: 'stdlib/', to: 'stdlib/' },
	{ from: '_mpy_shed/', to: 'stdlib/_mpy_shed/' },
	{ from: 'stubs/', to: 'stubs/' },
];

/**
 * A cached source tree, rearranged into the layout a typeshed root wants.
 *
 * Each move rewrites one prefix to another; the first move a path matches wins,
 * and a path no move names is dropped, which is how packaging metadata and
 * licences stay out of a layer. Every move must match something, so a subtree
 * that has moved upstream fails here rather than writing a layer with a hole in
 * it.
 *
 * @param {Map<string, Buffer>} tree paths as they appear in the archive
 * @param {{from: string, to: string}[]} moves prefix rewrites, in priority order
 * @returns {{files: Record<string, string>}}
 */
export function toLayer(tree, moves) {
	const matched = new Set();
	const files = {};

	for (const [key, content] of tree) {
		const move = moves.find((candidate) => key.startsWith(candidate.from));
		if (!move) continue;
		matched.add(move.from);
		files[`${move.to}${key.slice(move.from.length)}`] = content.toString('utf8');
	}

	const missing = moves.filter((move) => !matched.has(move.from));
	if (missing.length) {
		throw new Error(`nothing under ${missing.map((move) => `"${move.from}"`).join(', ')} to build a layer from`);
	}

	// Sorted, because the archive's order is not something upstream promises and
	// this output is read in diffs.
	const paths = Object.keys(files).sort();
	return { files: Object.fromEntries(paths.map((key) => [key, files[key]])) };
}

/**
 * Every top-level entry of a wheel apart from its packaging metadata.
 *
 * A board wheel has no folder structure to preserve: it ships its stubs flat at
 * the root, so the moves that lift them into `stdlib/` have to be derived from
 * what is there. A directory keeps its trailing slash and a file does not,
 * which is what makes these safe as prefixes, and `.dist-info/` is left out
 * because its name carries the version and would otherwise have to be re-edited
 * in the config on every bump.
 *
 * @param {Map<string, Buffer>} tree
 * @returns {string[]}
 */
export function wheelRoots(tree) {
	const roots = new Set();
	for (const key of tree.keys()) {
		const slash = key.indexOf('/');
		roots.add(slash === -1 ? key : key.slice(0, slash + 1));
	}
	return [...roots].filter((root) => !root.endsWith('.dist-info/')).sort();
}

/**
 * A board overlay must only add to the standard library it layers onto.
 *
 * Layers merge with the later one winning and no complaint, so an overlap is
 * invisible at runtime. Upstream keeps the two apart, which is why we can ship
 * them as separate layers at all, and an overlap here means that separation
 * moved and the merge has started picking a winner nobody chose.
 *
 * @param {{files: Record<string, string>}} base
 * @param {{files: Record<string, string>}} overlay
 * @param {string} id the target the overlay belongs to, for the message
 */
export function assertDisjoint(base, overlay, id) {
	const clashes = Object.keys(overlay.files).filter((path) => path in base.files);
	if (clashes.length === 0) return;
	throw new Error(
		`${id} redefines ${clashes.length} file(s) the base layer already ships: ${clashes.slice(0, 5).join(', ')}`
	);
}

/** Where a board's overlay is written, and what its catalogue entry names. */
export function boardLayer(source) {
	const name = source.board ? `${source.port}-${source.board}` : source.port;
	return `micropython/boards/${name}.json`;
}

/**
 * One MicroPython board's catalogue entry.
 *
 * The label leads with the flavour so the dropdown sorts into one run per
 * language: the same board ships for CircuitPython too, and two bare "Raspberry
 * Pi Pico W" entries would be indistinguishable. The firmware release goes in
 * the description beside the id, taken from the pinned version rather than
 * hand-written, because a label saying 1.28 beside a 1.29 pin is a lie nothing
 * else would catch.
 */
export function micropythonTarget(source, layer = boardLayer(source)) {
	const board = source.board ? `${source.port}/${source.board}` : source.port;
	const id = `micropython/${board}`;
	return {
		id,
		label: `MicroPython: ${source.label}`,
		description: `${id} (MicroPython ${source.version.split('.').slice(0, 2).join('.')})`,
		group: source.port,
		layers: [MICROPYTHON_BASE_LAYER, layer],
	};
}

/**
 * A whole port's entry, sharing the layer of the one board it duplicates.
 *
 * Upstream publishes `micropython-<port>-stubs` byte-identical to that port's
 * flagship board, which is why the skip list drops it. Skipping the download was
 * right; skipping the *name* was not. The stubs a user with some other board of
 * the port needs are already here, but they are filed under "Raspberry Pi Pico
 * W", and someone holding an RP2040 that is not a Pico has no way to know that
 * is the entry to pick. Pointing this at the same layer costs nothing.
 *
 * @param {{duplicateOf: string, label: string}} entry a `skip` entry that names a generic
 * @param {object} source the config source it duplicates
 */
export function genericTarget(entry, source) {
	return micropythonTarget({ port: source.port, label: entry.label, version: source.version }, boardLayer(source));
}

/**
 * No two targets may answer to the same id.
 *
 * The ids become the `enum` of the Settings dropdown, and VS Code resolves the
 * current value with `indexOf`: the second of two options sharing a value can
 * never be selected, and always renders as the first. Nothing downstream would
 * notice, since the catalogue, the merge and the seed all work either way.
 *
 * @param {{id: string}[]} targets
 */
export function assertUniqueIds(targets) {
	const seen = new Set();
	const clashes = new Set();
	for (const { id } of targets) {
		if (seen.has(id)) clashes.add(id);
		seen.add(id);
	}
	if (clashes.size) throw new Error(`two catalogue targets share the id(s) ${[...clashes].join(', ')}`);
}

/**
 * Catalogue order, which is the order the Settings dropdown shows.
 *
 * `auto` first because it is the default, and "no board selected" is not a name
 * anyone looks up alphabetically. Everything else by label, so the user scans
 * one alphabetical run of board names rather than an order that only makes
 * sense to the build. Compared by code unit rather than `localeCompare`, since
 * this decides the bytes of a committed manifest and ICU differs between
 * platforms.
 */
export function orderTargets(targets) {
	const rest = targets.filter((target) => target.id !== AUTO_TARGET);
	rest.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
	return [...targets.filter((target) => target.id === AUTO_TARGET), ...rest];
}

/**
 * Split one typeshed into the standard library every target needs and the board
 * modules only that board has.
 *
 * It is what lets the default target be honest: `auto` gets the base alone, so
 * `sys` resolves and `microbit` does not, which is exactly what a user who has
 * not chosen a board should see.
 *
 * @param {{files: Record<string, string>}} layer
 * @param {readonly string[]} modules top-level module names that belong to the board
 */
export function splitDevice(layer, modules) {
	const wanted = new Set(modules);
	const seen = new Set();
	const base = {};
	const device = {};

	for (const [key, content] of Object.entries(layer.files)) {
		const name = moduleOf(key);
		if (name !== undefined && wanted.has(name)) {
			seen.add(name);
			device[key] = content;
		} else {
			base[key] = content;
		}
	}

	const missing = modules.filter((name) => !seen.has(name));
	if (missing.length) {
		throw new Error(`no stub for device module(s) ${missing.join(', ')}; the upstream layout changed`);
	}
	return { base: { files: base }, device: { files: device } };
}

/**
 * The manifest's dropdown for `micropython-lsp.target`, from the catalogue.
 *
 * Generated rather than hand-written, because a manifest listing a target the
 * build did not produce offers a choice that resolves to nothing. `enumItemLabels`
 * shows the board name and `enumDescriptions` keeps the id visible, because the
 * id is what a project commits to its `.vscode/settings.json` and what any later
 * programmatic route would take.
 *
 * @param {{targets: {id: string, label: string, description?: string}[]}} catalogue
 */
export function targetEnum(catalogue) {
	return {
		enum: catalogue.targets.map((target) => target.id),
		enumItemLabels: catalogue.targets.map((target) => target.label),
		enumDescriptions: catalogue.targets.map((target) => target.description ?? target.id),
	};
}

/** The first path segment under `stdlib/`, which is the module a stub belongs to. */
function moduleOf(key) {
	if (!key.endsWith('.pyi')) return undefined;
	const relative = key.startsWith('stdlib/') ? key.slice('stdlib/'.length) : key;
	const first = relative.split('/')[0];
	return first.endsWith('.pyi') ? first.slice(0, -'.pyi'.length) : first;
}

export async function assembleStubs() {
	await fetchStubs();
	const { sources, skip = {} } = await readConfig();

	await rm(ASSETS, { recursive: true, force: true });
	const targets = orderTargets([
		...(await assembleMicroPython(sources, skip)),
		...(await assembleMicrobit(sources.microbit)),
	]);
	assertUniqueIds(targets);

	const catalogue = { targets };
	await write('catalogue.json', catalogue);
	await writeTargetEnum(catalogue);
	console.log(`[stubs] assembled ${targets.length} targets into assets/stubs/`);
}

/**
 * The MicroPython base, every board overlay, and their catalogue entries.
 *
 * The base goes first and carries `auto`, the default target: the standard
 * library with no board modules at all, which is the honest answer for a user
 * who has not said what they are programming.
 */
async function assembleMicroPython(sources, skip) {
	const source = sources[MICROPYTHON_BASE];
	const tree = await cachedTree(MICROPYTHON_BASE, source);
	const base = toLayer(tree, MICROPYTHON_BASE_MOVES);
	await write(MICROPYTHON_BASE_LAYER, base);
	await writeRaw('micropython/LICENSE.md', wheelLicence(tree));

	const targets = [
		{
			id: AUTO_TARGET,
			label: 'MicroPython (no board selected)',
			layers: [MICROPYTHON_BASE_LAYER],
		},
	];

	let shared;
	let overlays = 0;
	for (const [id, board] of Object.entries(sources).filter(([, entry]) => entry.port)) {
		const wheel = await cachedTree(id, board);
		const overlay = toLayer(wheel, wheelRoots(wheel).map((root) => ({ from: root, to: `stdlib/${root}` })));
		const target = micropythonTarget(board);
		assertDisjoint(base, overlay, target.id);
		await write(boardLayer(board), overlay);

		const licence = wheelLicence(wheel);
		if (shared === undefined) shared = licence;
		else assertSameLicence(id, shared, licence);
		targets.push(target);
		overlays += 1;
	}

	// One copy for all of them, having just checked they say the same thing. The
	// board wheels carry the same MIT text under the same copyright, and 17 more
	// identical files would be noise rather than attribution.
	await writeRaw('micropython/boards/LICENSE.md', shared);

	// The skipped port packages that are worth offering under their own name. Only
	// the ones the config gives a label to: a port whose flagship board is already
	// called something generic ("ESP32", "ESP8266") would otherwise get a second
	// entry meaning exactly the same thing.
	const generics = Object.entries(skip).filter(([, entry]) => entry.label);
	for (const [name, entry] of generics) {
		const board = sources[entry.duplicateOf];
		if (!board) throw new Error(`${name}: "duplicateOf": "${entry.duplicateOf}" is not a source in config.json`);
		targets.push(genericTarget(entry, board));
	}

	console.log(
		`[stubs] micropython: ${Object.keys(base.files).length} base files + ${overlays} board overlays` +
			` + ${generics.length} generic port targets sharing them`
	);
	return targets;
}

/**
 * micro:bit, which is a flavour of its own: a self-contained typeshed with its
 * own `VERSIONS`, `builtins` and `machine`, borrowing nothing from MicroPython's
 * standard library.
 */
async function assembleMicrobit(source) {
	const tree = await cachedTree('microbit', source);
	const { base, device } = splitDevice(toLayer(tree, [{ from: source.typeshed, to: '' }]), MICROBIT_DEVICE);

	await write('microbit/base.json', base);
	await write('microbit/device.json', device);

	// The upstream text, not a summary of it: micro:bit's licence is a per-file
	// listing of which half is Apache-2.0 and which is MIT.
	await writeRaw('microbit/LICENSE.md', tree.get('LICENSE.md'));

	console.log(
		`[stubs] microbit: ${Object.keys(base.files).length} base files + ${Object.keys(device.files).length} device files`
	);
	// Deliberately not prefixed "MicroPython:" like the boards above. That prefix
	// means upstream MicroPython, and upstream has a micro:bit of its own
	// (`ports/nrf/boards/MICROBIT`) with the standard APIs and no `microbit`
	// module. These stubs are the Foundation's fork instead, so the name has to
	// stay free for the port that would earn it.
	return [
		{
			id: 'microbit',
			label: 'BBC micro:bit',
			description: `microbit (micro:bit MicroPython, stubs ${source.version})`,
			layers: ['microbit/base.json', 'microbit/device.json'],
		},
	];
}

/** A wheel's licence, from the `.dist-info/` its version stamps. */
function wheelLicence(tree) {
	const path = [...tree.keys()].find((key) => key.endsWith('.dist-info/licenses/LICENSE.md'));
	return path === undefined ? undefined : tree.get(path);
}

/** One wheel writes the boards' licence file, so the rest have to agree with it. */
function assertSameLicence(id, licence, other) {
	// Line endings normalised because one wheel ships CRLF: same text, same
	// copyright, different writer.
	const text = (buffer) => String(buffer).replace(/\r\n/g, '\n');
	if (text(licence) !== text(other)) {
		throw new Error(`${id} ships a different licence from the other board stubs; they can no longer share one file`);
	}
}

/**
 * Put the catalogue's targets in the manifest, so Settings shows a dropdown.
 *
 * The manifest is committed and mostly hand-written, so this rewrites exactly one
 * property and leaves the file alone when nothing changed, keeping a stub bump
 * out of the diff unless it really moved the catalogue.
 */
async function writeTargetEnum(catalogue) {
	const manifest = path.join(here, '..', 'package.json');
	const pkg = JSON.parse(await readFile(manifest, 'utf8'));
	const setting = pkg.contributes?.configuration?.properties?.['micropython-lsp.target'];
	if (!setting) throw new Error('package.json does not contribute micropython-lsp.target');

	const before = JSON.stringify(setting);
	Object.assign(setting, targetEnum(catalogue));
	if (JSON.stringify(setting) === before) return;

	await writeFile(manifest, `${JSON.stringify(pkg, null, '\t')}\n`);
	console.log(`[stubs] package.json: micropython-lsp.target now offers ${setting.enum.length} targets`);
}

/** One source's files, unpacked from the archive as it was served. */
const cachedTree = async (id, source) => sourceTree(await readFile(cachedArchive(id, source)), source);

const write = (name, value) => writeRaw(name, `${JSON.stringify(value, null, '\t')}\n`);

async function writeRaw(name, content) {
	if (content === undefined) throw new Error(`nothing to write to assets/stubs/${name}`);
	const target = path.join(ASSETS, ...name.split('/'));
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, content);
}

// `pathToFileURL`, not a template string: only it produces the percent-encoding
// and the `file:///C:/` shape `import.meta.url` carries on Windows.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	assembleStubs().catch((error) => {
		console.error(String(error));
		process.exit(1);
	});
}
