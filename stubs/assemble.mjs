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

/**
 * A cached source tree, narrowed to one typeshed root and turned into a layer.
 *
 * @param {Map<string, Buffer>} tree paths as they appear in the archive
 * @param {string} root the prefix holding `stdlib/`, removed from every key
 * @returns {{files: Record<string, string>}}
 */
export function toLayer(tree, root) {
	const files = {};
	for (const [key, content] of tree) {
		if (key.startsWith(root)) files[key.slice(root.length)] = content.toString('utf8');
	}

	const paths = Object.keys(files).sort();
	if (paths.length === 0) throw new Error(`no files under "${root}" to build a layer from`);

	// Sorted, because the archive's order is not something upstream promises and
	// this output is read in diffs.
	return { files: Object.fromEntries(paths.map((key) => [key, files[key]])) };
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
 * @param {{targets: {id: string, label: string}[]}} catalogue
 */
export function targetEnum(catalogue) {
	return {
		enum: catalogue.targets.map((target) => target.id),
		enumItemLabels: catalogue.targets.map((target) => target.label),
		enumDescriptions: catalogue.targets.map((target) => target.id),
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
	const { sources } = await readConfig();

	const microbit = sources.microbit;
	const tree = sourceTree(await readArchive('microbit', microbit), microbit);
	const { base, device } = splitDevice(toLayer(tree, microbit.typeshed), MICROBIT_DEVICE);

	await rm(ASSETS, { recursive: true, force: true });
	await write('microbit/base.json', base);
	await write('microbit/device.json', device);

	// The upstream text, not a summary of it: micro:bit's licence is a per-file
	// listing of which half is Apache-2.0 and which is MIT.
	await writeRaw('microbit/LICENSE.md', tree.get('LICENSE.md'));

	const catalogue = {
		targets: [
			{
				id: 'auto',
				label: 'MicroPython (no board selected)',
				layers: ['microbit/base.json'],
			},
			{
				id: 'microbit',
				label: 'BBC micro:bit',
				layers: ['microbit/base.json', 'microbit/device.json'],
			},
		],
	};
	await write('catalogue.json', catalogue);
	await writeTargetEnum(catalogue);

	const count = (layer) => Object.keys(layer.files).length;
	console.log(`[stubs] assembled ${count(base)} base + ${count(device)} device files into assets/stubs/`);
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

const readArchive = (id, source) => readFile(cachedArchive(id, source));

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
