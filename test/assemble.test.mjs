import { describe, expect, it } from 'vitest';

import { splitDevice, targetEnum, toLayer } from '../stubs/assemble.mjs';

const tree = (entries) => new Map(entries.map(([path, body]) => [path, Buffer.from(body, 'utf8')]));

describe('toLayer', () => {
	const cached = tree([
		['lang/en/typeshed/stdlib/VERSIONS', 'sys: 3.0-\n'],
		['lang/en/typeshed/stdlib/microbit/__init__.pyi', 'def panic(n: int) -> None: ...\n'],
		['LICENSE.md', 'not a stub'],
	]);

	it('keeps the typeshed subtree, addressed from the typeshed root', () => {
		// The layer format is relative to the root the engine is pointed at, so the
		// upstream folders above `stdlib/` have to come off here.
		expect(toLayer(cached, 'lang/en/typeshed/').files).toEqual({
			'stdlib/VERSIONS': 'sys: 3.0-\n',
			'stdlib/microbit/__init__.pyi': 'def panic(n: int) -> None: ...\n',
		});
	});

	it('leaves everything outside it, licences included', () => {
		expect(Object.keys(toLayer(cached, 'lang/en/typeshed/').files)).not.toContain('LICENSE.md');
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
		expect(Object.keys(toLayer(unsorted, 't/').files)).toEqual([
			'stdlib/abc.pyi',
			'stdlib/machine.pyi',
			'stdlib/sys.pyi',
		]);
	});

	it('fails when the root matches nothing', () => {
		// A moved path upstream would otherwise write an empty layer, and an empty
		// typeshed resolves nothing at all while looking like a working build.
		expect(() => toLayer(cached, 'lang/es/typeshed/')).toThrow(/lang\/es\/typeshed\//);
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

describe('targetEnum', () => {
	const catalogue = {
		targets: [
			{ id: 'auto', label: 'MicroPython (no board selected)', layers: [] },
			{ id: 'microbit', label: 'BBC micro:bit', layers: [] },
		],
	};

	it('offers every catalogue target, by its board name', () => {
		// The value a user has to end up with is the id; the name is what makes the
		// dropdown navigable. Both, in step, or the list offers the wrong thing.
		expect(targetEnum(catalogue)).toEqual({
			enum: ['auto', 'microbit'],
			enumItemLabels: ['MicroPython (no board selected)', 'BBC micro:bit'],
			enumDescriptions: ['auto', 'microbit'],
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
