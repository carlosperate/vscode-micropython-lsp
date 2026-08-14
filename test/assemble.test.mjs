import { describe, expect, it } from 'vitest';

import {
	assertDisjoint,
	assertUniqueIds,
	boardLayer,
	genericTarget,
	micropythonTarget,
	orderTargets,
	splitDevice,
	targetEnum,
	toLayer,
	wheelRoots,
} from '../stubs/assemble.mjs';

const tree = (entries) => new Map(entries.map(([path, body]) => [path, Buffer.from(body, 'utf8')]));

describe('toLayer', () => {
	const cached = tree([
		['lang/en/typeshed/stdlib/VERSIONS', 'sys: 3.0-\n'],
		['lang/en/typeshed/stdlib/microbit/__init__.pyi', 'def panic(n: int) -> None: ...\n'],
		['LICENSE.md', 'not a stub'],
	]);
	const typeshed = [{ from: 'lang/en/typeshed/', to: '' }];

	it('keeps the typeshed subtree, addressed from the typeshed root', () => {
		// The layer format is relative to the root the engine is pointed at, so the
		// upstream folders above `stdlib/` have to come off here.
		expect(toLayer(cached, typeshed).files).toEqual({
			'stdlib/VERSIONS': 'sys: 3.0-\n',
			'stdlib/microbit/__init__.pyi': 'def panic(n: int) -> None: ...\n',
		});
	});

	it('leaves everything no move names, licences included', () => {
		expect(Object.keys(toLayer(cached, typeshed).files)).not.toContain('LICENSE.md');
	});

	it('moves each subtree to where the engine can reach it', () => {
		// The wheels are why this takes several moves. The engine resolves from one
		// typeshed root, and `_mpy_shed` ships beside `stdlib/` rather than in it,
		// so left where upstream puts it nothing can import it and every type that
		// passes through it degrades to `Unknown` with no error anywhere.
		const wheel = tree([
			['stdlib/io.pyi', 'from _mpy_shed import FileIO\n'],
			['_mpy_shed/__init__.pyi', 'class FileIO: ...\n'],
			['stubs/mypy-extensions/mypy_extensions.pyi', 'x\n'],
			['micropython_stdlib_stubs-1.28.0.post6.dist-info/RECORD', 'metadata'],
		]);
		expect(
			Object.keys(
				toLayer(wheel, [
					{ from: 'stdlib/', to: 'stdlib/' },
					{ from: '_mpy_shed/', to: 'stdlib/_mpy_shed/' },
					{ from: 'stubs/', to: 'stubs/' },
				]).files
			)
		).toEqual(['stdlib/_mpy_shed/__init__.pyi', 'stdlib/io.pyi', 'stubs/mypy-extensions/mypy_extensions.pyi']);
	});

	it('sorts its keys', () => {
		// The output is a committed-looking build artefact read by humans in diffs.
		// Archive order is not something upstream promises, so sorting is what keeps
		// a rebuild from producing a different file for identical input.
		const unsorted = tree([
			['t/stdlib/sys.pyi', ''],
			['t/stdlib/abc.pyi', ''],
			['t/stdlib/machine.pyi', ''],
		]);
		expect(Object.keys(toLayer(unsorted, [{ from: 't/', to: '' }]).files)).toEqual([
			'stdlib/abc.pyi',
			'stdlib/machine.pyi',
			'stdlib/sys.pyi',
		]);
	});

	it('fails on any move that matches nothing', () => {
		// A moved path upstream would otherwise write a layer with a hole in it, and
		// a typeshed root missing files resolves nothing while looking like a working
		// build. Each move is checked, not just the set.
		expect(() => toLayer(cached, [{ from: 'lang/es/typeshed/', to: '' }])).toThrow(/lang\/es\/typeshed\//);
		expect(() => toLayer(cached, [...typeshed, { from: '_mpy_shed/', to: 'stdlib/_mpy_shed/' }])).toThrow(
			/_mpy_shed\//
		);
	});
});

describe('wheelRoots', () => {
	const wheel = tree([
		['machine.pyi', 'x'],
		['rp2/__init__.pyi', 'x'],
		['rp2/asm_pio.pyi', 'x'],
		['micropython_rp2_rpi_pico_stubs-1.28.0.post4.dist-info/RECORD', 'x'],
		['micropython_rp2_rpi_pico_stubs-1.28.0.post4.dist-info/licenses/LICENSE.md', 'x'],
	]);

	it('names each top-level entry so a move cannot match a longer name by accident', () => {
		// A directory keeps its slash and a file does not, which is what makes these
		// safe to use as prefixes: bare `machine.pyi` would also match `machine.pyix`.
		expect(wheelRoots(wheel)).toEqual(['machine.pyi', 'rp2/']);
	});

	it('leaves out the wheel metadata', () => {
		// `.dist-info/` is packaging, not stubs, and its name carries the version, so
		// naming it in the config would mean re-editing 18 entries on every bump.
		expect(wheelRoots(wheel).join(' ')).not.toContain('dist-info');
	});
});

describe('assertDisjoint', () => {
	const base = { files: { 'stdlib/VERSIONS': 'v', 'stdlib/sys/__init__.pyi': 's' } };

	it('passes when a board only adds to the base', () => {
		expect(() => assertDisjoint(base, { files: { 'stdlib/machine.pyi': 'm' } }, 'rp2')).not.toThrow();
	});

	it('fails when a board would replace a file the base already ships', () => {
		// Layers merge with the later one winning, silently. Upstream separates the
		// standard library from the board overlays and we ship them the same way, so
		// an overlap means that separation moved and the merge is now picking a
		// winner nobody chose.
		expect(() => assertDisjoint(base, { files: { 'stdlib/VERSIONS': 'other' } }, 'rp2')).toThrow(
			/rp2.*stdlib\/VERSIONS/s
		);
	});
});

describe('micropythonTarget', () => {
	const pico = { port: 'rp2', board: 'rpi_pico', label: 'Raspberry Pi Pico', version: '1.28.0.post4' };
	// No board, which is what a whole-port generic is. Every source we ship names
	// one, so `genericTarget` is the only caller that takes this branch.
	const port = { port: 'rp2', label: 'RP2040 / RP2350 (generic)', version: '1.28.0.post4' };

	it('builds the id from the port and the board', () => {
		expect(micropythonTarget(pico).id).toBe('micropython/rp2/rpi_pico');
	});

	it('drops the board segment for a source that names no board', () => {
		expect(micropythonTarget(port).id).toBe('micropython/rp2');
	});

	it('leads the label with the flavour, so one language reads as one run', () => {
		// The same board ships for CircuitPython too, and two bare "Raspberry Pi
		// Pico" entries in a dropdown are indistinguishable.
		expect(micropythonTarget(pico).label).toBe('MicroPython: Raspberry Pi Pico');
	});

	it('puts the id and the firmware release in the description', () => {
		// The id is what a project commits to its settings.json, and the release is
		// derived rather than hand-written beside 18 pins: a label saying 1.28 next
		// to a 1.29 pin is a lie nothing else would catch.
		expect(micropythonTarget(pico).description).toBe('micropython/rp2/rpi_pico (MicroPython 1.28)');
	});

	it('merges the shared base under the board overlay it names', () => {
		// The order is the whole point of layering, and the overlay path has to be
		// the one the build writes or the target resolves to nothing.
		expect(micropythonTarget(pico).layers).toEqual(['micropython/stdlib.json', boardLayer(pico)]);
		expect(boardLayer(pico)).toBe('micropython/boards/rp2-rpi_pico.json');
		expect(boardLayer(port)).toBe('micropython/boards/rp2.json');
	});

	it('groups by port, so a long list can be broken up', () => {
		expect(micropythonTarget(pico).group).toBe('rp2');
	});
});

describe('genericTarget', () => {
	const pico = { port: 'rp2', board: 'rpi_pico_w', label: 'Raspberry Pi Pico W', version: '1.28.0.post4' };
	const entry = { duplicateOf: 'micropython-rp2-rpi_pico_w', label: 'RP2040 / RP2350 (generic)' };

	it('names the port alone, because it stands for the port rather than one board', () => {
		expect(genericTarget(entry, pico).id).toBe('micropython/rp2');
		expect(genericTarget(entry, pico).description).toBe('micropython/rp2 (MicroPython 1.28)');
	});

	it('reads as a board name, so the dropdown stays one list', () => {
		expect(genericTarget(entry, pico).label).toBe('MicroPython: RP2040 / RP2350 (generic)');
		expect(genericTarget(entry, pico).group).toBe('rp2');
	});

	it('refuses a source that is not a board', () => {
		// Every field is derived from the port, so without one the target is
		// `micropython/undefined` pointing at a layer the build never wrote. It
		// resolves to nothing, and only the catalogue-wide check in `bundle.test.ts`
		// would say so, after a release had already been assembled.
		expect(() => genericTarget(entry, { version: '1.28.0.post6' })).toThrow(/not a board source/);
		expect(() => genericTarget(entry, undefined)).toThrow(/not a board source/);
	});

	it('shares the layers of the board it duplicates, so it costs no bytes', () => {
		// Upstream's `micropython-<port>-stubs` ships the same stubs as that port's
		// flagship board, which `npm run check:micropythonpackages` verifies. Writing
		// a second copy under the generic name would be half a megabyte for nothing.
		expect(genericTarget(entry, pico).layers).toEqual(micropythonTarget(pico).layers);
	});
});

describe('assertUniqueIds', () => {
	it('passes when every target has its own id', () => {
		expect(() => assertUniqueIds([{ id: 'auto' }, { id: 'micropython/rp2' }])).not.toThrow();
	});

	it('fails when two targets share one id', () => {
		// The ids become the `enum` of a Settings dropdown, and VS Code resolves the
		// current value with `indexOf`, so the second of two options sharing a value
		// can never be picked and always renders as the first. Nothing else notices:
		// the catalogue, the merge and the seed all work fine.
		expect(() => assertUniqueIds([{ id: 'micropython/rp2' }, { id: 'micropython/rp2' }])).toThrow(
			/micropython\/rp2/
		);
	});
});

describe('splitDevice', () => {
	const layer = {
		files: {
			'stdlib/VERSIONS': 'v',
			'stdlib/builtins.pyi': 'b',
			'stdlib/sys.pyi': 's',
			'stdlib/microbit/__init__.pyi': 'm',
			'stdlib/microbit/display.pyi': 'd',
			'stdlib/radio.pyi': 'r',
		},
	};
	const { base, device } = splitDevice(layer, ['microbit', 'radio']);

	it('puts the board modules in the device layer, whole packages included', () => {
		expect(Object.keys(device.files).sort()).toEqual([
			'stdlib/microbit/__init__.pyi',
			'stdlib/microbit/display.pyi',
			'stdlib/radio.pyi',
		]);
	});

	it('leaves the standard library, and the parts every target needs, in the base', () => {
		// `builtins` and `VERSIONS` in the wrong half means the default target
		// resolves nothing at all rather than merely lacking board modules.
		expect(Object.keys(base.files).sort()).toEqual(['stdlib/VERSIONS', 'stdlib/builtins.pyi', 'stdlib/sys.pyi']);
	});

	it('loses nothing and duplicates nothing', () => {
		const halves = [...Object.keys(base.files), ...Object.keys(device.files)].sort();
		expect(halves).toEqual(Object.keys(layer.files).sort());
	});

	it('fails on a device module that is not there', () => {
		// The list is hand-written against a pinned upstream. A typo in it, or a
		// module upstream renamed, would otherwise quietly ship in the base layer,
		// where every target gets it.
		expect(() => splitDevice(layer, ['microbit', 'speech'])).toThrow(/speech/);
	});
});

describe('orderTargets', () => {
	const targets = [
		{ id: 'auto', label: 'MicroPython (no board selected)' },
		{ id: 'micropython/rp2/waveshare_rp2040_zero', label: 'MicroPython: Waveshare RP2040-Zero' },
		{ id: 'micropython/stm32/pybv11', label: 'MicroPython: PyBoard v1.1' },
		{ id: 'micropython/esp32/esp32_generic', label: 'MicroPython: ESP32' },
		{ id: 'microbit', label: 'BBC micro:bit' },
		{ id: 'micropython/rp2', label: 'MicroPython: RP2040 / RP2350 (generic)' },
	];

	it('keeps the default first and sorts the boards by label', () => {
		// `auto` is what a new user starts on, and "no board selected" is not a name
		// anyone looks up alphabetically, so it stays at the top of the list.
		expect(orderTargets(targets).map((target) => target.label)).toEqual([
			'MicroPython (no board selected)',
			'BBC micro:bit',
			'MicroPython: ESP32',
			'MicroPython: PyBoard v1.1',
			'MicroPython: RP2040 / RP2350 (generic)',
			'MicroPython: Waveshare RP2040-Zero',
		]);
	});

	it('does not lose or invent a target', () => {
		expect(orderTargets(targets)).toHaveLength(targets.length);
	});
});

describe('targetEnum', () => {
	const catalogue = {
		targets: [
			{ id: 'auto', label: 'MicroPython (no board selected)', layers: [] },
			{ id: 'microbit', label: 'BBC micro:bit', description: 'microbit (stubs v0.4.0)', layers: [] },
		],
	};

	it('offers every catalogue target, by its board name', () => {
		// The value a user has to end up with is the id; the name is what makes the
		// dropdown navigable. Both, in step, or the list offers the wrong thing.
		// A target with no description of its own falls back to its id, which is
		// the part a project commits to `.vscode/settings.json`.
		expect(targetEnum(catalogue)).toEqual({
			enum: ['auto', 'microbit'],
			enumItemLabels: ['MicroPython (no board selected)', 'BBC micro:bit'],
			enumDescriptions: ['auto', 'microbit (stubs v0.4.0)'],
		});
	});

	it('keeps the three lists the same length and in the same order', () => {
		// VS Code pairs them positionally, so a mismatch labels a board with
		// another board's name and there is nothing to notice it.
		const { enum: ids, enumItemLabels, enumDescriptions } = targetEnum(catalogue);
		expect(enumItemLabels).toHaveLength(ids.length);
		expect(enumDescriptions).toHaveLength(ids.length);
	});
});
