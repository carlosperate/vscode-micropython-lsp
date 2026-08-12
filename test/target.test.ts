import { describe, expect, it } from 'vitest';

import {
	composeSeed,
	findTarget,
	loadTarget,
	parseCatalogue,
	parseLayer,
	TARGET_TYPESHED,
	type Layer,
	type ReadStub,
} from '../client/src/target';

const layer = (files: Record<string, string>): Layer => ({ files });

/** Seeded paths back as layer paths, so an assertion reads like the layer did. */
const seeded = (seed: Record<string, string>) =>
	Object.keys(seed)
		.map((path) => path.slice(TARGET_TYPESHED.length + 1))
		.sort();

// A wrong winner here is silent: the board still resolves, with another port's
// `machine`. Nothing downstream can tell, so these assertions are the only check.
describe('composeSeed', () => {
	it('seeds every file under the target typeshed root', () => {
		const seed = composeSeed([layer({ 'stdlib/VERSIONS': 'sys: 3.0-\n', 'stdlib/sys.pyi': 'platform: str\n' })]);
		expect(seed).toEqual({
			[`${TARGET_TYPESHED}/stdlib/VERSIONS`]: 'sys: 3.0-\n',
			[`${TARGET_TYPESHED}/stdlib/sys.pyi`]: 'platform: str\n',
		});
	});

	it('never seeds into the embedded typeshed root', () => {
		// `initialize` merges the engine's own CPython typeshed into `/typeshed`
		// whatever we send it, so one path landing there puts `subprocess` back
		// beside the board's modules, and only the count would look right.
		const seed = composeSeed([layer({ 'stdlib/sys.pyi': '', 'stdlib/machine.pyi': '' })]);
		expect(Object.keys(seed).every((path) => path.startsWith(`${TARGET_TYPESHED}/`))).toBe(true);
		expect(Object.keys(seed).some((path) => path.startsWith('/typeshed/'))).toBe(false);
	});

	it('merges layers left to right, the last one winning', () => {
		const seed = composeSeed([
			layer({ 'stdlib/machine.pyi': 'base', 'stdlib/sys.pyi': 'base' }),
			layer({ 'stdlib/machine.pyi': 'board' }),
		]);
		expect(seed[`${TARGET_TYPESHED}/stdlib/machine.pyi`]).toBe('board');
		expect(seed[`${TARGET_TYPESHED}/stdlib/sys.pyi`]).toBe('base');
	});

	it('keeps every entry when the layers are disjoint', () => {
		const seed = composeSeed([
			layer({ 'stdlib/sys.pyi': '', 'stdlib/VERSIONS': '' }),
			layer({ 'stdlib/rp2/__init__.pyi': '' }),
		]);
		expect(seeded(seed)).toEqual(['stdlib/VERSIONS', 'stdlib/rp2/__init__.pyi', 'stdlib/sys.pyi']);
	});

	it('seeds nothing for no layers', () => {
		expect(composeSeed([])).toEqual({});
	});

	it('refuses a path that escapes the typeshed root', () => {
		// `..` would reach `/typeshed` itself, which is the one root a target
		// exists to replace.
		expect(() => composeSeed([layer({ '/stdlib/sys.pyi': '' })])).toThrow(/relative/);
		expect(() => composeSeed([layer({ '../typeshed/stdlib/sys.pyi': '' })])).toThrow(/relative/);
		expect(() => composeSeed([layer({ 'stdlib//sys.pyi': '' })])).toThrow(/relative/);
		expect(() => composeSeed([layer({ '': '' })])).toThrow(/relative/);
	});
});

describe('parseCatalogue', () => {
	const text = JSON.stringify({
		targets: [
			{ id: 'auto', label: 'MicroPython (no board selected)', layers: ['micropython/stdlib.json'] },
			{
				id: 'micropython/rp2/rpi_pico_w',
				label: 'Raspberry Pi Pico W',
				group: 'rp2',
				layers: ['micropython/stdlib.json', 'micropython/boards/rp2-rpi_pico_w.json'],
			},
		],
	});

	it('reads the entries', () => {
		const catalogue = parseCatalogue(text);
		expect(catalogue.targets).toHaveLength(2);
		expect(catalogue.targets[1].layers).toEqual([
			'micropython/stdlib.json',
			'micropython/boards/rp2-rpi_pico_w.json',
		]);
	});

	it('finds a target by id, and answers for an unknown one', () => {
		const catalogue = parseCatalogue(text);
		expect(findTarget(catalogue, 'auto')?.label).toBe('MicroPython (no board selected)');
		expect(findTarget(catalogue, 'micropython/rp2/no_such_board')).toBeUndefined();
	});

	it('refuses a catalogue it cannot use', () => {
		// A malformed asset must fail where it is read. Seeding nothing looks
		// exactly like a working server with no board selected.
		expect(() => parseCatalogue('not json')).toThrow();
		expect(() => parseCatalogue('{}')).toThrow(/targets/);
		expect(() => parseCatalogue(JSON.stringify({ targets: [{ id: 'x', label: 'X' }] }))).toThrow(/layers/);
		expect(() => parseCatalogue(JSON.stringify({ targets: [{ label: 'X', layers: [] }] }))).toThrow(/id/);
	});
});

describe('parseLayer', () => {
	it('reads a layer\'s files', () => {
		expect(parseLayer('{"files":{"stdlib/sys.pyi":""}}')).toEqual({ files: { 'stdlib/sys.pyi': '' } });
	});

	it('refuses a layer it cannot use', () => {
		expect(() => parseLayer('not json')).toThrow();
		expect(() => parseLayer('{}')).toThrow(/files/);
	});
});

describe('loadTarget', () => {
	const assets: Record<string, string> = {
		'catalogue.json': JSON.stringify({
			targets: [
				{ id: 'auto', label: 'MicroPython', layers: ['micropython/stdlib.json'] },
				{
					id: 'micropython/esp32/esp32_generic',
					label: 'ESP32',
					group: 'esp32',
					layers: ['micropython/stdlib.json', 'micropython/boards/esp32.json'],
				},
			],
		}),
		'micropython/stdlib.json': JSON.stringify({
			files: { 'stdlib/VERSIONS': 'sys: 3.0-\n', 'stdlib/sys.pyi': 'platform: str\n' },
		}),
		'micropython/boards/esp32.json': JSON.stringify({ files: { 'stdlib/esp32.pyi': 'def wake_on_touch() -> None: ...\n' } }),
	};
	const read: ReadStub = async (path) => {
		const text = assets[path];
		if (text === undefined) throw new Error(`ENOENT: ${path}`);
		return text;
	};

	it('merges the target\'s layers into files under the typeshed root', async () => {
		const seed = await loadTarget(read, 'micropython/esp32/esp32_generic');
		expect(seed.id).toBe('micropython/esp32/esp32_generic');
		expect(seed.label).toBe('ESP32');
		expect(seeded(seed.files)).toEqual(['stdlib/VERSIONS', 'stdlib/esp32.pyi', 'stdlib/sys.pyi']);
	});

	it('loads the base alone for the default target', async () => {
		expect(seeded((await loadTarget(read, 'auto')).files)).toEqual(['stdlib/VERSIONS', 'stdlib/sys.pyi']);
	});

	it('falls back to auto for an id the catalogue does not have, and says so', async () => {
		// A board that has left the catalogue since the setting was written must
		// still analyse Python. `id` is how the caller knows to say something.
		const seed = await loadTarget(read, 'micropython/esp32/no_such_board');
		expect(seed.id).toBe('auto');
	});

	it('names the asset it could not read', async () => {
		// A broken build, not a user error, and 646 targets share these parsers:
		// "no files object" without the path behind it is not actionable.
		await expect(loadTarget(async () => { throw new Error('ENOENT'); }, 'auto')).rejects.toThrow(/catalogue\.json/);
		await expect(loadTarget(read, 'micropython/esp32/esp32_generic')).resolves.toBeTruthy();
		await expect(
			loadTarget(async (path) => (path === 'catalogue.json' ? assets['catalogue.json'] : '{}'), 'auto')
		).rejects.toThrow(/micropython\/stdlib\.json/);
	});

	it('refuses a catalogue with nothing to fall back to', async () => {
		const empty: ReadStub = async () => JSON.stringify({ targets: [] });
		await expect(loadTarget(empty, 'auto')).rejects.toThrow(/auto/);
	});
});
