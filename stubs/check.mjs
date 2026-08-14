/**
 * Ask upstream whether the pinned MicroPython stubs are still the whole story.
 *
 * `fetch.mjs` answers a different question: is this archive the one we pinned?
 * That fails loudly on a changed download but is silent about a board that
 * appeared, a post-release that was published, or a whole new MicroPython
 * release. This reports those, and changes nothing: every pin is a deliberate
 * edit to `config.json`.
 *
 * It exits non-zero only when a claim in `config.json` has become false, never
 * merely because an update exists. News does not fail a run; a wrong assertion
 * does.
 *
 * Boards are discovered through **Josverl's `publish/` directory**, not PyPI.
 * PyPI has no usable search, so the alternative is guessing names; that
 * directory holds one folder per published package and is the authoritative
 * list. Versions still come from PyPI, which is where the pins point.
 *
 * Run it by hand: `npm run check:micropythonpackages`.
 */

import { pathToFileURL } from 'node:url';

import { digest, extractZip } from './archive.mjs';
import { MICROPYTHON_BASE, wheelRoots } from './assemble.mjs';
import { readConfig } from './fetch.mjs';

/** Every package Josverl publishes, one folder each. Well under a page. */
const PUBLISH = 'https://api.github.com/repos/Josverl/micropython-stubs/contents/publish';

/** How a pinned version names its release folders upstream. */
export function publishPrefix(version) {
	return `micropython-v${series(version).replace(/\./g, '_')}-`;
}

/**
 * The PyPI name behind a publish folder, or nothing if it is another release.
 *
 * The shared base is deliberately never matched: it is published unversioned,
 * with one folder for every release, so it cannot be discovered this way and is
 * pinned by name instead.
 */
export function packageOf(folder, prefix) {
	return folder.startsWith(prefix) ? `micropython-${folder.slice(prefix.length)}` : undefined;
}

/** MicroPython releases past the pinned one, oldest first. */
export function newerReleases(folders, version) {
	const pinned = order(series(version));
	const found = new Set();
	for (const folder of folders) {
		const release = /^micropython-v(\d+)_(\d+)_(\d+)-/.exec(folder);
		if (release) found.add(`${release[1]}.${release[2]}.${release[3]}`);
	}
	return [...found].filter((release) => order(release) > pinned).sort((a, b) => order(a) - order(b));
}

/** What upstream has that we do not, and what we carry that upstream dropped. */
export function comparePackages(upstream, known) {
	return {
		added: upstream.filter((name) => !known.has(name)).sort(),
		gone: [...known].filter((name) => !upstream.includes(name)).sort(),
	};
}

/**
 * The newest post-release of the version we pin, if there is one.
 *
 * Numeric on the post number, because `post10` sorts before `post4` as text and
 * this comparison is the whole point of the check. Deliberately confined to the
 * pinned release: moving to the next one is a catalogue-wide decision that
 * `newerReleases` reports separately.
 */
export function latestInSeries(versions, pinned) {
	const wanted = series(pinned);
	const newest = versions
		.filter((version) => series(version) === wanted)
		.sort((a, b) => post(a) - post(b))
		.pop();
	return newest !== undefined && post(newest) > post(pinned) ? newest : undefined;
}

const series = (version) => version.split('.post')[0];
const post = (version) => Number(/\.post(\d+)$/.exec(version)?.[1] ?? 0);
const order = (release) => release.split('.').reduce((total, part) => total * 1000 + Number(part), 0);

/** PyPI's own name for a source, by the convention `config.json` is written to. */
const pypiName = (id) => `${id}-stubs`;

/** The sources this covers: the shared base and every board, never micro:bit. */
const micropythonSources = (sources) =>
	Object.entries(sources).filter(([id, source]) => id === MICROPYTHON_BASE || source.port);

async function json(url) {
	const response = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
	if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
	return response.json();
}

/** Everything PyPI knows about a package, fetched once and passed around. */
const pypi = (name) => json(`https://pypi.org/pypi/${name}/json`);

async function wheel(meta, name, version) {
	const file = (meta.releases[version] ?? []).find((entry) => entry.packagetype === 'bdist_wheel');
	if (!file) throw new Error(`${name} ${version} publishes no wheel`);
	const response = await fetch(file.url);
	if (!response.ok) throw new Error(`${file.url}: ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

/**
 * What a wheel contributes, ignoring the `.dist-info/` that carries its name and
 * version. Two wheels shipping identical stubs never have identical bytes
 * without that, which is what makes the skip list checkable rather than a claim
 * that quietly goes stale.
 */
function stubDigest(bytes) {
	const tree = extractZip(bytes);
	const roots = wheelRoots(tree);
	const content = [...tree]
		.filter(([file]) => roots.some((root) => file.startsWith(root)))
		.map(([file, body]) => `${file}:${digest(body)}`)
		.sort();
	return digest(Buffer.from(content.join('\n')));
}

/**
 * One line of the report: what was checked and what it says.
 *
 * Two kinds of "not ok", because they deserve different reactions. `ok` is
 * "nothing to act on", which decides whether the run ends with the all-clear:
 * a published update is news, and acting on it is a deliberate edit. `drift` is
 * narrower and decides the exit code: something `config.json` asserts that
 * upstream has since made false. Only drift can make this command fail, so a
 * routine post-release does not cry wolf.
 */
const line = (name, note, { ok = true, drift = false } = {}) => ({ name, note, ok: ok && !drift, drift });

/** Is a newer post-release of this pin published? */
async function checkPin([id, source]) {
	const name = pypiName(id);
	try {
		const newer = latestInSeries(Object.keys((await pypi(name)).releases), source.version);
		const note = newer ? `${source.version}  UPDATE AVAILABLE (${newer})` : `${source.version}  up to date`;
		return line(name, note, { ok: !newer });
	} catch (error) {
		return line(name, `lookup failed: ${error}`, { drift: true });
	}
}

/**
 * Is a skipped package still the duplicate the config says it is?
 *
 * The port packages (`micropython-rp2-stubs` and friends) ship the same stubs as
 * that port's flagship board under another name, so pinning both would ship the
 * same half-megabyte twice. The name is still worth having, and a `label` on the
 * entry offers it as a generic target sharing that board's layer, so this check
 * is what that sharing rests on: if upstream ever stops making them identical,
 * the generic starts lying about what it covers and the package becomes a board
 * worth carrying. Nothing else would notice.
 */
async function checkSkip([name, entry], sources) {
	const id = entry?.duplicateOf;
	const source = sources[id];
	if (!source) return line(name, `"duplicateOf": "${id}" is not a source in config.json`, { drift: true });

	try {
		const [theirs, ours] = await Promise.all([pypi(name), pypi(pypiName(id))]);
		const version = latestInSeries(Object.keys(theirs.releases), source.version) ?? source.version;
		const [copy, original] = await Promise.all([
			wheel(theirs, name, version),
			wheel(ours, pypiName(id), source.version),
		]);
		if (stubDigest(copy) === stubDigest(original)) return line(name, `${version} is byte-identical to ${id}`);

		// Compared against the wheel we actually ship, not against upstream's newest,
		// so this cannot go stale in the direction that matters: whatever the board
		// gains upstream, the question stays "is what we ship still the whole port?".
		const generic = entry.label ? `, and "${entry.label}" no longer covers what it says` : '';
		return line(name, `${version} no longer matches ${id}, so it is a board in its own right now${generic}`, {
			drift: true,
		});
	} catch (error) {
		return line(name, `lookup failed: ${error}`, { drift: true });
	}
}

function report(title, lines, width) {
	console.log(`${title}:`);
	for (const { name, note } of lines) console.log(`  ${name.padEnd(width)}  ${note}`);
}

export async function checkMicroPythonPackages() {
	const { sources, skip = {} } = await readConfig();
	const base = sources[MICROPYTHON_BASE];
	if (!base) throw new Error(`config.json has no "${MICROPYTHON_BASE}" source to take the release from`);

	const pinned = micropythonSources(sources);
	console.log(`Checking Josverl/micropython-stubs against ${pinned.length} pinned package(s)...\n`);

	// The base is deliberately left out: it is published unversioned, with one
	// folder per release, so it can never turn up in this comparison.
	const folders = (await json(PUBLISH)).map((entry) => entry.name);
	const upstream = folders.map((folder) => packageOf(folder, publishPrefix(base.version))).filter(Boolean);
	const boards = pinned.filter(([id]) => id !== MICROPYTHON_BASE).map(([id]) => pypiName(id));
	const { added, gone } = comparePackages(upstream, new Set([...boards, ...Object.keys(skip)]));

	const pins = await Promise.all(pinned.map(checkPin));
	const skips = await Promise.all(Object.entries(skip).map((entry) => checkSkip(entry, sources)));
	const width = Math.max(...[...pins, ...skips].map((entry) => entry.name.length));

	report('Pinned', pins, width);
	console.log('');
	report('Skipped as duplicates', skips, width);
	console.log('');

	if (added.length) {
		console.log(`${added.length} package(s) upstream that config.json does not mention:`);
		for (const name of added) console.log(`  ${name}`);
		console.log('Add each as a source, or to "skip" if it duplicates one we already ship.');
	}
	if (gone.length) {
		console.log(`${gone.length} pinned package(s) upstream no longer publishes:`);
		for (const name of gone) console.log(`  ${name}`);
	}

	const releases = newerReleases(folders, base.version);
	if (releases.length) {
		console.log(`MicroPython ${releases.join(', ')} stubs are published. The pin is ${series(base.version)}.`);
		console.log('Moving is a catalogue-wide change: every URL, version and checksum in config.json.');
	}

	const drifted = [...pins, ...skips].filter((entry) => entry.drift);
	if (drifted.length) {
		console.log(`${drifted.length} check(s) found config.json asserting something upstream no longer supports:`);
		for (const { name, note } of drifted) console.log(`  ${name}  ${note}`);
	}

	const settled = [...pins, ...skips].every((entry) => entry.ok);
	if (settled && !added.length && !gone.length && !releases.length) {
		console.log('Everything is current: no new boards, no newer post-releases, no new release.');
	}
	return { drifted: drifted.length };
}

// `pathToFileURL`, not a template string: only it produces the percent-encoding
// and the `file:///C:/` shape `import.meta.url` carries on Windows.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	// Non-zero only on drift, so this is safe to wire into a scheduled job: an
	// available update is news and must not page anyone.
	checkMicroPythonPackages()
		.then(({ drifted }) => {
			if (drifted) process.exitCode = 1;
		})
		.catch((error) => {
			console.error(String(error));
			process.exit(1);
		});
}
