import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildTargetPicks, chooseWriteScope, describeTarget } from '../client/src/target-pick';
import { type Target } from '../client/src/target';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The shape and order `assemble.mjs` writes: default first, then by label. */
const CATALOGUE: Target[] = [
	{ id: 'auto', label: 'MicroPython (no board selected)', layers: [] },
	{ id: 'microbit', label: 'BBC micro:bit', description: 'microbit (micro:bit MicroPython, stubs v0.4.0)', layers: [] },
	{
		id: 'circuitpython/adafruit_feather_m4_express',
		label: 'CircuitPython: Adafruit Feather M4 Express',
		description: 'circuitpython/adafruit_feather_m4_express (CircuitPython 10.2)',
		group: 'atmel-samd',
		layers: [],
	},
	{
		id: 'circuitpython/raspberry_pi_pico',
		label: 'CircuitPython: Raspberry Pi Pico',
		description: 'circuitpython/raspberry_pi_pico (CircuitPython 10.2)',
		group: 'raspberrypi',
		layers: [],
	},
	{
		id: 'micropython/esp32/esp32_generic',
		label: 'MicroPython: ESP32',
		description: 'micropython/esp32/esp32_generic (MicroPython 1.28)',
		group: 'esp32',
		layers: [],
	},
	{
		id: 'micropython/rp2/rpi_pico',
		label: 'MicroPython: Raspberry Pi Pico',
		description: 'micropython/rp2/rpi_pico (MicroPython 1.28)',
		group: 'rp2',
		layers: [],
	},
];

const labels = (picks: readonly { label: string; separator?: true }[]) =>
	picks.map((pick) => (pick.separator ? `-- ${pick.label} --` : pick.label));

describe('buildTargetPicks', () => {
	it('keeps catalogue order and heads each flavour run', () => {
		expect(labels(buildTargetPicks(CATALOGUE))).toEqual([
			'MicroPython (no board selected)',
			'BBC micro:bit',
			'-- CircuitPython --',
			'CircuitPython: Adafruit Feather M4 Express',
			'CircuitPython: Raspberry Pi Pico',
			'-- MicroPython --',
			'MicroPython: ESP32',
			'MicroPython: Raspberry Pi Pico',
		]);
	});

	// The rule is run length, not flavour: a heading over one row repeats it.
	it('gives a run of one no heading', () => {
		const picks = buildTargetPicks(CATALOGUE);
		expect(picks.filter((pick) => pick.separator)).toHaveLength(2);
	});

	// Counting the flavour rather than the run would head both halves here, which
	// is what an order grouped by something other than the label would produce.
	it('gives a flavour split into two runs of one no heading either', () => {
		const interleaved = [CATALOGUE[2], CATALOGUE[4], CATALOGUE[3], CATALOGUE[5]];
		expect(labels(buildTargetPicks(interleaved))).toEqual([
			'CircuitPython: Adafruit Feather M4 Express',
			'MicroPython: ESP32',
			'CircuitPython: Raspberry Pi Pico',
			'MicroPython: Raspberry Pi Pico',
		]);
	});

	// Only rows with an id can be chosen, and the picker keys its write on it.
	it('carries the id on boards and nothing on headings', () => {
		for (const pick of buildTargetPicks(CATALOGUE)) {
			expect(Boolean(pick.id)).toBe(!pick.separator);
		}
	});

	// The searchable half, since `matchOnDescription` is on.
	it('describes a board with its id and firmware release', () => {
		const pick = buildTargetPicks(CATALOGUE).find((entry) => entry.id === 'circuitpython/raspberry_pi_pico');
		expect(pick?.description).toBe('circuitpython/raspberry_pi_pico (CircuitPython 10.2)');
	});

	it('marks the board already in force', () => {
		const picks = buildTargetPicks(CATALOGUE, 'micropython/esp32/esp32_generic');
		expect(picks.find((pick) => pick.id === 'micropython/esp32/esp32_generic')?.description)
			.toBe('micropython/esp32/esp32_generic (MicroPython 1.28) (current)');
		expect(picks.filter((pick) => pick.description?.includes('(current)'))).toHaveLength(1);
	});

	it('falls back to the id when the catalogue gives no description', () => {
		const pick = buildTargetPicks(CATALOGUE).find((entry) => entry.id === 'auto');
		expect(pick?.description).toBe('auto');
	});
});

describe('describeTarget', () => {
	// No room for the prefix, which carries meaning, so the hover keeps it.
	it('shows the board name and keeps the full label in the hover', () => {
		const status = describeTarget(CATALOGUE, 'circuitpython/raspberry_pi_pico');
		expect(status.text).toBe('Raspberry Pi Pico');
		expect(status.tooltip).toContain('CircuitPython: Raspberry Pi Pico');
		expect(status.tooltip).toContain('circuitpython/raspberry_pi_pico');
	});

	// micro:bit deliberately has no prefix, so the split must not eat its name.
	it('leaves a label with no flavour prefix alone', () => {
		expect(describeTarget(CATALOGUE, 'microbit').text).toBe('BBC micro:bit');
	});

	it('asks for a board when none is selected', () => {
		const status = describeTarget(CATALOGUE, 'auto');
		expect(status.text).toBe('Select Python board');
		expect(status.tooltip).toContain('No board selected');
	});

	// A project can pin a board a later stub bump dropped.
	it('reports an id the catalogue does not have', () => {
		const status = describeTarget(CATALOGUE, 'circuitpython/gone_away');
		expect(status.text).toBe('Unknown board');
		expect(status.tooltip).toContain('circuitpython/gone_away');
	});
});

describe('chooseWriteScope', () => {
	// A user-scope write under a workspace value changes nothing visible.
	it('writes the workspace when the workspace is what is in force', () => {
		expect(chooseWriteScope({ workspaceValue: 'microbit' })).toBe('workspace');
	});

	it('writes the user scope otherwise', () => {
		expect(chooseWriteScope(undefined)).toBe('global');
		expect(chooseWriteScope({})).toBe('global');
	});
});

/**
 * Where a link is clickable. That the id matches the one the code registers is a
 * gate check, where the constant itself can be imported.
 */
describe('manifest', () => {
	it('links the setting to the picker, and only from where links are clickable', async () => {
		const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
		const setting = manifest.contributes.configuration.properties['micropython-lsp.target'];

		// Only `markdownDescription` is rendered as markdown, with commands allowed.
		expect(setting.markdownDescription).toContain('(command:micropython-lsp.selectTarget)');
		expect(setting.description).not.toContain('command:');

		// The select box opens enum links without commands, so one there is dead.
		for (const description of setting.enumDescriptions ?? []) {
			expect(description).not.toContain('command:');
		}
	});
});
