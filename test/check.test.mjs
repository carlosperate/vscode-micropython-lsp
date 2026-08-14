import { describe, expect, it } from 'vitest';

import { comparePackages, latestInSeries, newerReleases, packageOf, publishPrefix } from '../stubs/check.mjs';
import { readConfig } from '../stubs/fetch.mjs';

describe('publishPrefix', () => {
	it('takes the release out of a pinned post-release version', () => {
		// Upstream names its folders after the MicroPython release, not the stub
		// package's post number, so the two have to be separated before matching.
		expect(publishPrefix('1.28.0.post6')).toBe('micropython-v1_28_0-');
		expect(publishPrefix('1.28.0')).toBe('micropython-v1_28_0-');
	});
});

describe('packageOf', () => {
	const prefix = publishPrefix('1.28.0.post4');

	it('turns a publish folder into the name PyPI knows it by', () => {
		expect(packageOf('micropython-v1_28_0-rp2-rpi_pico-stubs', prefix)).toBe('micropython-rp2-rpi_pico-stubs');
		expect(packageOf('micropython-v1_28_0-unix-stubs', prefix)).toBe('micropython-unix-stubs');
	});

	it('ignores every other release', () => {
		expect(packageOf('micropython-v1_21_0-rp2-stubs', prefix)).toBeUndefined();
	});

	it('ignores the shared base, which is published unversioned', () => {
		// `micropython-stdlib-stubs` has one folder for every release, so it can
		// never be discovered this way. It is pinned by name instead.
		expect(packageOf('micropython-stdlib-stubs', prefix)).toBeUndefined();
	});
});

describe('newerReleases', () => {
	const folders = [
		'micropython-stdlib-stubs',
		'micropython-v1_21_0-rp2-stubs',
		'micropython-v1_28_0-rp2-rpi_pico-stubs',
		'micropython-v1_29_0-rp2-rpi_pico-stubs',
		'micropython-v1_30_0-esp32-stubs',
	];

	it('reports releases past the pinned one, newest last', () => {
		// The whole catalogue moves together, so a new release is a different kind
		// of news from a new board and worth saying separately.
		expect(newerReleases(folders, '1.28.0.post4')).toEqual(['1.29.0', '1.30.0']);
	});

	it('says nothing when the pin is current', () => {
		expect(newerReleases(folders, '1.30.0.post1')).toEqual([]);
	});

	it('compares numerically, not as text', () => {
		// 1.9 is older than 1.28, which a string sort gets backwards.
		expect(newerReleases(['micropython-v1_9_0-rp2-stubs'], '1.28.0')).toEqual([]);
	});
});

describe('comparePackages', () => {
	const known = new Set(['micropython-rp2-rpi_pico-stubs', 'micropython-unix-stubs']);

	it('reports what upstream has and we do not', () => {
		expect(comparePackages(['micropython-rp2-rpi_pico-stubs', 'micropython-rp2-rpi_pico2-stubs'], known)).toEqual({
			added: ['micropython-rp2-rpi_pico2-stubs'],
			gone: ['micropython-unix-stubs'],
		});
	});

	it('reports what we pin that upstream no longer publishes', () => {
		// A board withdrawn upstream still builds here, from the cache or the pinned
		// URL, so nothing else would ever mention it.
		expect(comparePackages(['micropython-rp2-rpi_pico-stubs'], known).gone).toEqual(['micropython-unix-stubs']);
	});

	it('is quiet when the two agree', () => {
		expect(comparePackages([...known], known)).toEqual({ added: [], gone: [] });
	});
});

// Whether the skip list is still *true* needs the network, and lives in
// `checkSkip`. These are the parts of the claim that can be checked without one,
// so a typo does not have to wait for someone to run that command.
describe('the skip list in config.json', () => {
	it('points every entry at a source we ship', async () => {
		// The entry means "not downloaded, because it duplicates that one". A
		// `duplicateOf` naming nothing makes the claim uncheckable rather than false,
		// which is worse: the digest comparison never runs and reports nothing.
		const { sources, skip } = await readConfig();
		for (const [name, entry] of Object.entries(skip)) {
			expect(sources[entry.duplicateOf], `${name} duplicateOf`).toBeDefined();
		}
	});

	it('only offers a generic for a port whose flagship is not already generic', async () => {
		// A `label` puts the entry in the dropdown as a whole-port target. Adding one
		// where the board it duplicates is already named for the port ("ESP32",
		// "ESP8266") would list the same stubs twice under two names.
		const { sources, skip } = await readConfig();
		const labelled = Object.values(skip).filter((entry) => entry.label);
		for (const entry of labelled) {
			expect(sources[entry.duplicateOf].board ?? '').not.toMatch(/generic/);
		}
		expect(labelled.length).toBeGreaterThan(0);
	});
});

describe('latestInSeries', () => {
	const versions = ['1.28.0.post1', '1.28.0.post4', '1.28.0.post10', '1.29.0.post1'];

	it('finds a newer post-release of the pinned release', () => {
		expect(latestInSeries(versions, '1.28.0.post4')).toBe('1.28.0.post10');
	});

	it('orders post-releases numerically', () => {
		// post10 beats post4, which a string sort gets backwards, and this is the
		// comparison the whole check rests on.
		expect(latestInSeries(['1.28.0.post9', '1.28.0.post10'], '1.28.0.post1')).toBe('1.28.0.post10');
	});

	it('stays inside the pinned release', () => {
		// Moving to 1.29 is a catalogue-wide decision, not a drifted pin, and
		// `newerReleases` is what reports it.
		expect(latestInSeries(versions, '1.28.0.post10')).toBeUndefined();
	});

	it('treats a plain release as post 0', () => {
		expect(latestInSeries(['1.28.0', '1.28.0.post1'], '1.28.0')).toBe('1.28.0.post1');
	});
});
