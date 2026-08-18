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

/** The config keys CircuitPython is built from: its own stubs, and what it borrows. */
export const CIRCUITPYTHON = 'circuitpython';
export const CIRCUITPYTHON_LICENCE = 'circuitpython-license';
const UNIX_PORT = 'micropython-unix';

/** The config key of the micro:bit Foundation's stubs. */
export const MICROBIT = 'microbit';

/** Where the CircuitPython base is written, and what every board names first. */
const CIRCUITPYTHON_BASE_LAYER = 'circuitpython/stdlib.json';

/** The subtree of the sdist that is one board each, rather than a module. */
const BOARD_DEFINITIONS = 'board_definitions/';

/** One board's definition: the generated stub inside a package of its own. */
const BOARD_STUB = new RegExp(`^${BOARD_DEFINITIONS}[^/]+/__init__\\.pyi?$`);

/**
 * The modules CircuitPython documents but neither it nor MicroPython's shared
 * base ships a stub for. MicroPython keeps them in its port stubs, so the unix
 * port supplies them.
 *
 * Hand-written against a pinned upstream, like micro:bit's device list;
 * `checkInheritedModules` in `check.mjs` is what notices when it stops being
 * right, and the build fails if one of them is missing.
 *
 * `asyncio` is borrowed the same way and deliberately reaches every board:
 * CircuitPython ships it as a library rather than firmware, so no board
 * definition names it, and squiggling it would flag working code on any board
 * whose owner installed it. `circup` installs `.mpy` bytecode by default, which
 * pyright cannot read at all, so the real choice is this stub or no types.
 */
const CIRCUITPYTHON_FROM_UNIX = ['binascii', 'errno', 'gc', 'heapq', 'platform', 'select'];

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
 * A tree's top-level roots lifted into `stdlib/`, which is where the engine's
 * only import root looks. Wheels and the sdist alike ship their stubs flat.
 *
 * @param {Map<string, Buffer>} tree
 * @param {string[]} roots prefixes to move, from `wheelRoots` or `sdistRoots`
 */
const stdlibLayer = (tree, roots) => toLayer(tree, roots.map((root) => ({ from: root, to: `stdlib/${root}` })));

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
	// Without a port there is no layer to share, and every field derived below
	// would read "undefined": a target id nobody can select, pointing at a file the
	// build never wrote. Only the catalogue-wide check in `bundle.test.ts` would
	// catch it, and only after a release had been assembled.
	if (!source?.port) {
		throw new Error(`generic "${entry.label}": "duplicateOf": "${entry.duplicateOf}" is not a board source`);
	}
	return micropythonTarget({ port: source.port, label: entry.label, version: source.version }, boardLayer(source));
}

/**
 * Every top-level directory of the sdist that holds stubs, board definitions
 * aside. Derived rather than listed: it is 124 modules and upstream adds one
 * most releases.
 *
 * Holding a `.pyi` is what separates a module from the packaging around it
 * (`circuitpython_setboard/` is Python we do not ship, `.egg-info/` carries a
 * version in its name).
 *
 * @param {Map<string, Buffer>} tree
 * @returns {string[]} prefixes, each with its trailing slash
 */
export function sdistRoots(tree) {
	const roots = new Set();
	for (const key of tree.keys()) {
		const slash = key.indexOf('/');
		if (slash === -1 || !key.endsWith('.pyi')) continue;
		const root = `${key.slice(0, slash)}/`;
		if (root !== BOARD_DEFINITIONS) roots.add(root);
	}
	return [...roots].sort();
}

/**
 * What one board definition says about itself, from the docstring upstream
 * generates at the top of it. The module list is the whole of per-board
 * filtering, machine-written from the `CIRCUITPY_*` flags that build the
 * firmware.
 *
 * Two of its forms are not module names: `_bleio (HCI co-processor)` says how a
 * module is implemented, `busio.SPI` names a member of one. Both collapse onto
 * the module, which is what an `import` line spells.
 *
 * @param {string} text the stub's source
 * @returns {{name: string, port: string, id: string, modules: string[]}}
 */
export function parseBoardStub(text) {
	const field = (label) => new RegExp(`^\\s*-\\s*${label}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim();
	const name = /Board stub for (.+)/.exec(text)?.[1]?.trim();
	const port = field('port');
	const id = field('board_id');
	const listed = field('Included modules');
	if (!name || !port || !id || !listed) {
		throw new Error('a board definition is missing its generated docstring, so it has no module list');
	}

	const modules = listed
		.split(',')
		.map((entry) => entry.trim().split(' ')[0].split('.')[0])
		.filter(Boolean);
	return { name, port, id, modules: [...new Set(modules)].sort() };
}

/** Where a CircuitPython board's overlay is written, and what its target names. */
export const circuitpythonBoardLayer = (id) => `circuitpython/boards/${id}.json`;

/**
 * One CircuitPython board's catalogue entry.
 *
 * The label leads with the flavour because the same board ships for both, and
 * the description carries the board id because twelve display names are shared
 * by more than one board upstream: the id is the only thing telling `edgebadge`
 * from `pybadge` when both read "Adafruit Pybadge".
 */
export function circuitpythonTarget(board, version) {
	const id = `circuitpython/${board.id}`;
	return {
		id,
		label: `CircuitPython: ${board.name}`,
		description: `${id} (CircuitPython ${version.split('.').slice(0, 2).join('.')})`,
		group: board.port,
		layers: [CIRCUITPYTHON_BASE_LAYER, circuitpythonBoardLayer(board.id)],
	};
}

/**
 * A layer narrowed to the modules named, the same rule the client applies to an
 * `include` at load time. Anything belonging to no module keeps its place, which
 * is what carries `VERSIONS` through.
 *
 * @param {{files: Record<string, string>}} layer
 * @param {readonly string[]} modules
 */
export function keepModules(layer, modules) {
	const wanted = new Set(modules);
	const kept = Object.entries(layer.files).filter(([path]) => {
		const module = moduleOf(path);
		return module === undefined || wanted.has(module);
	});
	return { files: Object.fromEntries(kept) };
}

/**
 * Top-level modules a stub imports. `import x.y` and `from x.y import z` both
 * name `x`, which is what an allowlist can act on.
 *
 * @param {string} text a stub's source
 * @returns {Set<string>}
 */
export function importsOf(text) {
	const found = new Set();
	for (const line of text.split('\n')) {
		const match = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/.exec(line);
		const name = (match?.[1] ?? match?.[2])?.split('.')[0];
		if (name) found.add(name);
	}
	return found;
}

/**
 * The modules a board's list has no authority over, and so may never remove.
 *
 * **The borrowed half is not per-board data.** A `CIRCUITPY_*` flag exists for
 * what CircuitPython compiles, and for nothing it inherits, so no board
 * definition describes `io`, `re` or `builtins` even though every board has
 * them. Filtering them on a board that happens not to list one is not a smaller
 * standard library, it is a broken one: `builtins` imports `io`, so `open()`
 * returned `Unknown` on the 88 boards that did not name it, and `typing` imports
 * `re`. Nothing errors, the types simply go quiet.
 *
 * Natives no board mentions join them, which is the older half of this rule:
 * they are real firmware modules the matrix cannot see either.
 *
 * @param {{files: Record<string, string>}} borrowed MicroPython's stubs
 * @param {{files: Record<string, string>}} natives CircuitPython's own
 * @param {ReadonlySet<string>} documented every module named by any board
 */
export function unfilterableModules(borrowed, natives, documented) {
	const unmentioned = [...modulesOf(natives)].filter((module) => !documented.has(module));
	return new Set([...modulesOf(borrowed), ...unmentioned]);
}

/** Every module a layer holds a stub for. */
export function modulesOf(layer) {
	const modules = new Set();
	for (const path of Object.keys(layer.files)) {
		const module = moduleOf(path);
		if (module !== undefined) modules.add(module);
	}
	return modules;
}

/**
 * A board's effective allowlist: what it documents, plus what its list has no
 * authority over.
 *
 * **You can only filter what the per-board data can see.** Keeping a native the
 * matrix never mentions offers `dualbank` to a board without one; the
 * alternative hides `micropython`, and `from micropython import const` is
 * everyday CircuitPython. The cheaper mistake wins.
 *
 * What stays filtered is a module the board really lacks, even where another
 * kept stub names it: `displayio` types a union member `picodvi`, and offering
 * HDMI to a board with none costs more than that member reading `Unknown`.
 *
 * @param {readonly string[]} documented one board's module list
 * @param {ReadonlySet<string>} unfilterable from `unfilterableModules`
 */
export function boardInclude(documented, unfilterable) {
	return [...new Set([...documented, ...unfilterable])].sort();
}

/**
 * Every module the boards ask for that nothing in the base answers: the
 * reconciliation between two upstreams that do not know about each other. A name
 * in neither is one upstream started shipping and we do not carry, which would
 * otherwise be a board silently offering less than it says.
 *
 * @param {{files: Record<string, string>}} base
 * @param {ReadonlySet<string>} documented every module named by any board
 */
export function missingFromBase(base, documented) {
	const have = modulesOf(base);
	return [...documented].filter((module) => !have.has(module)).sort();
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

/**
 * The module a path belongs to, or nothing when it belongs to none.
 *
 * Anything inside a package directory is that package's, whatever its extension:
 * `asyncio/readme.md` travels with `asyncio`, so declining a module leaves
 * nothing of it behind. A bare file at the root counts only if it is a stub,
 * which keeps `VERSIONS` out of every allowlist and every split.
 *
 * `stdlibModule` in `target.ts` is the same rule at load time: two copies in two
 * languages, one writing the lists and one reading them, each with its own test.
 */
function moduleOf(key) {
	if (!key.startsWith('stdlib/')) return undefined;
	const relative = key.slice('stdlib/'.length);
	const slash = relative.indexOf('/');
	if (slash !== -1) return relative.slice(0, slash);
	return relative.endsWith('.pyi') ? relative.slice(0, -'.pyi'.length) : undefined;
}

export async function assembleStubs() {
	await fetchStubs();
	const { sources, skip = {} } = await readConfig();

	await rm(ASSETS, { recursive: true, force: true });
	const targets = orderTargets([
		...(await assembleMicroPython(sources, skip)),
		...(await assembleMicrobit(sources.microbit)),
		...(await assembleCircuitPython(sources)),
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

	// `borrowedBy` is a port pinned for what another flavour takes from it rather
	// than to be offered: the unix port's standard library is CircuitPython's
	// closest source for six modules, and it runs on a computer.
	const boards = Object.entries(sources).filter(([, entry]) => entry.port && !entry.borrowedBy);
	let shared;
	for (const [id, board] of boards) {
		const wheel = await cachedTree(id, board);
		const overlay = stdlibLayer(wheel, wheelRoots(wheel));
		const target = micropythonTarget(board);
		assertDisjoint(base, overlay, target.id);
		await write(boardLayer(board), overlay);

		const licence = wheelLicence(wheel);
		if (shared === undefined) shared = licence;
		else assertSameLicence(id, shared, licence);
		targets.push(target);
	}

	// One copy for all of them, having just checked they say the same thing. The
	// board wheels carry the same MIT text under the same copyright, and 17 more
	// identical files would be noise rather than attribution.
	await writeRaw('micropython/boards/LICENSE.md', shared);

	// The skipped port packages that are worth offering under their own name. Only
	// the ones the config gives a label to: a port whose flagship board is already
	// called something generic ("ESP32", "ESP8266") would otherwise get a second
	// entry meaning exactly the same thing.
	const generics = Object.values(skip).filter((entry) => entry.label);
	for (const entry of generics) targets.push(genericTarget(entry, sources[entry.duplicateOf]));

	console.log(
		`[stubs] micropython: ${Object.keys(base.files).length} base files + ${boards.length} board overlays` +
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
	const tree = await cachedTree(MICROBIT, source);
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

/**
 * CircuitPython: one base of native modules, and one layer per board carrying
 * that board's pins and the modules its firmware was built with.
 *
 * The base is two upstreams. CircuitPython generates stubs for the 124 modules
 * it implements itself and no standard library at all: no `builtins`, no
 * `typing`, no `sys`. Those it inherits from MicroPython in source as well as in
 * documentation, so they are borrowed from MicroPython's stubs. What
 * CircuitPython does generate always wins, being extracted from the C it ships.
 */
async function assembleCircuitPython(sources) {
	const source = sources[CIRCUITPYTHON];
	const sdist = await cachedTree(CIRCUITPYTHON, source);
	const natives = stdlibLayer(sdist, sdistRoots(sdist));
	assertGeneratedStdlib(natives);

	// Read once and used twice, for the stubs and for the licence beside them: it
	// is the largest wheel we carry and unzipping it is not free.
	const micropython = await cachedTree(MICROPYTHON_BASE, sources[MICROPYTHON_BASE]);
	const borrowed = await borrowedStdlib(sources, natives, micropython);
	assertDisjoint(borrowed, natives, CIRCUITPYTHON);
	const base = { files: { ...borrowed.files, ...natives.files } };
	await write(CIRCUITPYTHON_BASE_LAYER, base);
	await writeRaw('circuitpython/LICENSE.md', (await cachedTree(CIRCUITPYTHON_LICENCE, sources[CIRCUITPYTHON_LICENCE])).get('LICENSE'));
	// The borrowed half travels under its own licence, a different file by a
	// different author, so both ship.
	await writeRaw('circuitpython/LICENSE-micropython-stubs.md', wheelLicence(micropython));

	const boards = [...sdist]
		.filter(([path]) => BOARD_STUB.test(path))
		.map(([, content]) => {
			const stub = content.toString('utf8');
			return { stub, ...parseBoardStub(stub) };
		});
	assertEveryBoard(sdist, boards);

	const documented = new Set(boards.flatMap((board) => board.modules));
	const missing = missingFromBase(base, documented);
	if (missing.length) {
		throw new Error(
			`${missing.length} module(s) the boards document have no stub in either upstream: ${missing.join(', ')}`
		);
	}
	const unfilterable = unfilterableModules(borrowed, natives, documented);

	const targets = [];
	for (const board of boards) {
		// The one sanctioned collision, and the reason `include` filters before a
		// layer's own files land: this replaces the base's pin-less placeholder with
		// the board's real pins, which is what `circuitpython_setboard` does too.
		// Its own imports join the list, since one board types its pins `busio.*`
		// while its docstring never mentions `busio`.
		const include = boardInclude([...board.modules, ...importsOf(board.stub)], unfilterable);
		const layer = { files: { 'stdlib/board/__init__.pyi': board.stub }, include };
		await write(circuitpythonBoardLayer(board.id), layer);
		targets.push(circuitpythonTarget(board, source.version));
	}

	console.log(
		`[stubs] circuitpython: ${Object.keys(natives.files).length} generated files` +
			` + ${Object.keys(base.files).length - Object.keys(natives.files).length} borrowed` +
			` + ${boards.length} boards, ${unfilterable.size} module(s) no board filters`
	);
	return targets;
}

/**
 * The standard library CircuitPython documents and does not generate, taken
 * from MicroPython's stubs.
 *
 * Mostly derived rather than listed: everything MicroPython's shared base has
 * that CircuitPython does not ship itself, plus the six from the unix port.
 *
 * Only `stdlib/` travels. MicroPython's separate `stubs/` import root stays
 * behind: its one package is imported by nothing, and the engine resolves from a
 * single root anyway.
 */
async function borrowedStdlib(sources, natives, micropython) {
	const shared = toLayer(micropython, MICROPYTHON_BASE_MOVES);
	const stdlib = { files: Object.fromEntries(Object.entries(shared.files).filter(([path]) => path.startsWith('stdlib/'))) };

	const ours = modulesOf(natives);
	const wanted = [...modulesOf(stdlib)].filter((module) => !ours.has(module));

	const wheel = await cachedTree(UNIX_PORT, sources[UNIX_PORT]);
	const inherited = keepModules(stdlibLayer(wheel, wheelRoots(wheel)), CIRCUITPYTHON_FROM_UNIX);
	// A third licence, because this is a third package: same author and the same
	// MIT terms as the shared base, a different file under a different copyright
	// year. Six modules of what ships come from here.
	await writeRaw('circuitpython/LICENSE-micropython-unix-stubs.md', wheelLicence(wheel));
	const absent = CIRCUITPYTHON_FROM_UNIX.filter((module) => !modulesOf(inherited).has(module));
	if (absent.length) {
		throw new Error(`the unix port no longer ships ${absent.join(', ')}, which CircuitPython documents`);
	}

	const borrowed = keepModules(stdlib, wanted);
	assertDisjoint(borrowed, inherited, 'the unix port');
	return { files: { ...borrowed.files, ...inherited.files } };
}

/**
 * Every board directory upstream ships became a target of the same name.
 *
 * A board whose stub the filter misses disappears from the catalogue silently,
 * and 627 looks exactly like 628. Not hypothetical: two of them arrive with a
 * truncated name unless the tar reader honours pax headers.
 *
 * By name rather than by count, because the counts also match when two boards
 * declare one `board_id` between them and one layer file overwrites the other.
 *
 * @param {Map<string, Buffer>} sdist
 * @param {{id: string}[]} boards
 */
export function assertEveryBoard(sdist, boards) {
	const shipped = new Set(
		[...sdist.keys()].filter((path) => path.startsWith(BOARD_DEFINITIONS)).map((path) => path.split('/')[1])
	);
	const parsed = new Set(boards.map((board) => board.id));
	const lost = [...shipped].filter((id) => !parsed.has(id));
	const invented = [...parsed].filter((id) => !shipped.has(id));
	if (lost.length || invented.length) {
		throw new Error(
			`${shipped.size} board definitions produced ${parsed.size} target(s).` +
				`${lost.length ? ` No target for: ${lost.slice(0, 5).join(', ')}.` : ''}` +
				`${invented.length ? ` No definition for: ${invented.slice(0, 5).join(', ')}.` : ''}`
		);
	}
}

/**
 * The six standard-library modules CircuitPython really does implement, and why
 * this reads the sdist rather than the wheel: `setup.py` subtracts them from the
 * wheel so they cannot shadow CPython's own on a desktop, while the sdist keeps
 * them because it is the source tree.
 *
 * True since 7.3.3, but a side effect of what an sdist is rather than a promise.
 * If a release prunes them every board silently loses `time` and `os`, so this
 * fails the build instead.
 */
function assertGeneratedStdlib(natives) {
	const have = modulesOf(natives);
	const missing = ['math', 'os', 'random', 'ssl', 'struct', 'time'].filter((module) => !have.has(module));
	if (missing.length) {
		throw new Error(
			`the CircuitPython sdist no longer carries ${missing.join(', ')}. ` +
				'Check whether MANIFEST.in or STD_PACKAGES in setup.py changed upstream.'
		);
	}
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
