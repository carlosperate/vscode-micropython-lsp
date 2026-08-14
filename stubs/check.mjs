/**
 * Ask upstream whether the pinned MicroPython stubs are still the whole story.
 *
 * `fetch.mjs` answers a different question: is this archive the one we pinned?
 * That fails loudly on a changed download but is silent about a board that
 * appeared, a post-release that was published, or a whole new MicroPython
 * release. This reports those, and changes nothing: every pin is a deliberate
 * edit to `config.json`.
 *
 * It exits non-zero when a claim in `config.json` has become false, or when a
 * check could not run at all, never merely because an update exists. News does
 * not fail a run; a wrong assertion, or an unverified one, does.
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

/**
 * PyPI's own name for one of our ids.
 *
 * `config.json` is keyed by our id throughout, never by a registry's name for
 * the same thing: CircuitPython's stubs come from GitHub releases and carry no
 * `-stubs` suffix, so keying on it would put one flavour's packaging convention
 * in a file that has to describe every flavour. This is the one place the two
 * meet, and the report speaks PyPI's names because it is about PyPI.
 */
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
 * One line of the report: what was checked, what it says, and what it means.
 *
 * Four states, because they deserve different reactions. `ok` needs nothing.
 * `news` is an update that exists and is worth taking, which is a deliberate
 * edit rather than a failure, so it deliberately cannot set the exit code: a
 * routine post-release must not page anyone. `drift` is a claim in
 * `config.json` that upstream has made false. `unknown` is a check that could
 * not run at all, almost always the network, and fails the same way for the
 * opposite reason: nothing was verified, so nothing may be reported as verified.
 */
const line = (name, note, status = 'ok') => ({ name, note, status });

/** The states that mean this run proved nothing, and so set the exit code. */
const unresolved = (entry) => entry.status === 'drift' || entry.status === 'unknown';

/** Is a newer post-release of this pin published? */
async function checkPin([id, source]) {
	const name = pypiName(id);
	try {
		const newer = latestInSeries(Object.keys((await pypi(name)).releases), source.version);
		const note = newer ? `${source.version}  UPDATE AVAILABLE (${newer})` : `${source.version}  up to date`;
		return line(name, note, newer ? 'news' : 'ok');
	} catch (error) {
		return line(name, `lookup failed: ${error}`, 'unknown');
	}
}

/**
 * A package we have decided not to ship, whose entry is just the reason why.
 *
 * Nothing to verify, unlike `skip`: there is no duplicate behind it, only a
 * choice. Listed in `config.json` so `comparePackages` stops calling it new, and
 * reported so the choice stays visible rather than living in a file nobody
 * reopens.
 */
const checkExcluded = ([id, reason]) => line(pypiName(id), reason);

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
async function checkSkip([skipped, entry], sources) {
	const name = pypiName(skipped);
	const id = entry.duplicateOf;
	const source = sources[id];
	if (!source) return line(name, `"duplicateOf": "${id}" is not a source in config.json`, 'drift');

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
		return line(name, `${version} no longer matches ${id}, so it is a board in its own right now${generic}`, 'drift');
	} catch (error) {
		return line(name, `lookup failed: ${error}`, 'unknown');
	}
}

function report(title, lines, width) {
	console.log(`${title}:`);
	for (const { name, note } of lines) console.log(`  ${name.padEnd(width)}  ${note}`);
}

export async function checkMicroPythonPackages() {
	const { sources, skip = {}, excluded = {} } = await readConfig();
	const base = sources[MICROPYTHON_BASE];
	if (!base) throw new Error(`config.json has no "${MICROPYTHON_BASE}" source to take the release from`);

	const pinned = micropythonSources(sources);
	console.log(`Checking Josverl/micropython-stubs against ${pinned.length} pinned package(s)...\n`);

	// The base is deliberately left out: it is published unversioned, with one
	// folder per release, so it can never turn up in this comparison.
	const folders = (await json(PUBLISH)).map((entry) => entry.name);
	const upstream = folders.map((folder) => packageOf(folder, publishPrefix(base.version))).filter(Boolean);
	// Everything config.json accounts for, however it accounts for it: shipped,
	// skipped as a duplicate, or excluded on purpose. Anything else is genuinely
	// new. All three are keyed by our id, so one translation covers the lot.
	const boards = pinned.filter(([id]) => id !== MICROPYTHON_BASE).map(([id]) => id);
	const known = new Set([...boards, ...Object.keys(skip), ...Object.keys(excluded)].map(pypiName));
	const { added, gone } = comparePackages(upstream, known);

	const pins = await Promise.all(pinned.map(checkPin));
	const skips = await Promise.all(Object.entries(skip).map((entry) => checkSkip(entry, sources)));
	const exclusions = Object.entries(excluded).map(checkExcluded);
	const width = Math.max(...[...pins, ...skips, ...exclusions].map((entry) => entry.name.length));

	report('Pinned', pins, width);
	console.log('');
	report('Skipped as duplicates', skips, width);
	console.log('');
	if (exclusions.length) {
		report('Excluded', exclusions, width);
		console.log('');
	}

	if (added.length) {
		console.log(`${added.length} package(s) upstream that config.json does not mention:`);
		for (const name of added) console.log(`  ${name}`);
		console.log('Add each as a source, to "skip" if it duplicates one we ship, or to "excluded".');
	}
	if (gone.length) {
		// Not "pinned": this set is everything config.json names, so a withdrawn
		// package could equally be one we skip or one we excluded on purpose.
		console.log(`${gone.length} package(s) config.json names that upstream no longer publishes:`);
		for (const name of gone) console.log(`  ${name}`);
	}

	const releases = newerReleases(folders, base.version);
	if (releases.length) {
		console.log(`MicroPython ${releases.join(', ')} stubs are published. The pin is ${series(base.version)}.`);
		console.log('Moving is a catalogue-wide change: every URL, version and checksum in config.json.');
	}

	const checked = [...pins, ...skips];
	const failed = checked.filter(unresolved);
	if (failed.length) {
		console.log(`${failed.length} check(s) did not come back clean:`);
		for (const { name, note } of failed) console.log(`  ${name}  ${note}`);
	}

	if (checked.every((entry) => entry.status === 'ok') && !added.length && !gone.length && !releases.length) {
		console.log('Everything is current: no new boards, no newer post-releases, no new release.');
	}
	return { failed: failed.length };
}

// `pathToFileURL`, not a template string: only it produces the percent-encoding
// and the `file:///C:/` shape `import.meta.url` carries on Windows.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	// Never non-zero for an available update, so this is safe to wire into a
	// scheduled job: only a false claim or a check that could not run fails it.
	checkMicroPythonPackages()
		.then(({ failed }) => {
			if (failed) process.exitCode = 1;
		})
		.catch((error) => {
			console.error(String(error));
			process.exit(1);
		});
}
