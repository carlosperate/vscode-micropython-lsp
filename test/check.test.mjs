import { describe, expect, it } from 'vitest';

import { comparePackages, latestInSeries, newerRelease, newerReleases, packageOf, publishPrefix } from '../stubs/check.mjs';
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

describe('the excluded list in config.json', () => {
	it('offers no board for a port that runs on a computer', async () => {
		// The desktop and browser ports are published upstream and deliberately not
		// offered, so this is the decision itself rather than a description of the
		// config: making one selectable has to be a considered edit here, not a quiet
		// line in a bump.
		//
		// Pinning one is a different thing from offering it. CircuitPython documents
		// six modules that neither it nor MicroPython's shared base ships a stub for,
		// and the unix port is where MicroPython keeps them, so it is fetched for what
		// is borrowed out of it and `borrowedBy` keeps it out of the catalogue.
		const { sources, excluded } = await readConfig();
		for (const port of ['unix', 'windows', 'webassembly']) {
			const pinned = Object.entries(sources).filter(([, source]) => source.port === port);
			for (const [id, source] of pinned) {
				expect(source.borrowedBy, `${id} is offered as a target`).toBeTruthy();
				expect(sources[source.borrowedBy], `${id} is borrowed by nothing`).toBeTruthy();
			}
			expect(pinned.length || excluded[`micropython-${port}`], `${port} unaccounted for`).toBeTruthy();
		}
	});

	it('gives a reason for every name, since that is all it is', async () => {
		// The value is the whole entry, so an empty one leaves a package suppressed
		// from the report with nothing saying why it was.
		const { excluded } = await readConfig();
		for (const [name, reason] of Object.entries(excluded)) {
			expect(typeof reason, `${name} reason`).toBe('string');
			expect(reason.length, `${name} reason`).toBeGreaterThan(0);
		}
	});

	it('never names a package another list already covers', async () => {
		// All three are keyed by our own id, so one package has one entry and the
		// three lists partition them: shipped, skipped as a duplicate, or excluded on
		// purpose. An id in two of them means two answers to what we do with it.
		const { sources, skip, excluded } = await readConfig();
		const lists = [Object.keys(sources), Object.keys(skip), Object.keys(excluded)];
		const all = lists.flat();
		expect(all.filter((id, at) => all.indexOf(id) !== at)).toEqual([]);
	});

	it('keys every list by our id, never by the name a registry happens to use', async () => {
		// The PyPI name is `<id>-stubs`, but CircuitPython's stubs come from GitHub
		// releases and carry no such suffix. Keying on it would put one flavour's
		// packaging convention in a file that has to describe every flavour, and make
		// moving an entry between lists a rename.
		const { skip, excluded } = await readConfig();
		for (const id of [...Object.keys(skip), ...Object.keys(excluded)]) {
			expect(id, `${id} is keyed by its PyPI name`).not.toMatch(/-stubs$/);
		}
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

describe('newerRelease', () => {
	it('compares by number, not as text', () => {
		// `10.2.1` sorts before `9.2.9` as text, and this decides whether an update
		// is reported at all.
		expect(newerRelease(['9.2.9', '10.0.0', '10.2.1'], '10.0.0')).toBe('10.2.1');
	});

	it('says nothing when the pin is the newest', () => {
		expect(newerRelease(['9.2.9', '10.2.1'], '10.2.1')).toBeUndefined();
	});

	it('takes a leading v, which is how tags are written', () => {
		expect(newerRelease(['v0.3.0', 'v0.4.0'], 'v0.4.0')).toBeUndefined();
		expect(newerRelease(['v0.4.0', 'v0.5.0'], 'v0.4.0')).toBe('v0.5.0');
	});

	it('ignores anything that is not a release number', () => {
		// Both repositories tag other things, and a pre-release is not an update.
		expect(newerRelease(['10.2.1', '11.0.0-beta.1', 'nightly'], '10.2.1')).toBeUndefined();
	});
});
