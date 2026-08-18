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
 * Run it by hand: `npm run stubs:check`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every version here comes from PyPI, so PEP 440 is the format rather than
// semver: `1.28.0.post5` is not a semver version at all, and coercing it to one
// drops the `.post5` that the whole post-release check turns on.
import { compare, explain, valid } from '@renovatebot/pep440';

import { digest, extractTarGz, extractZip } from './archive.mjs';
import { CIRCUITPYTHON, CIRCUITPYTHON_LICENCE, MICROBIT, MICROPYTHON_BASE, wheelRoots } from './assemble.mjs';
import { readConfig } from './fetch.mjs';
import { compareMembers, rstMembers, stubMembers } from './members.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

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
	const pinned = series(version);
	const found = new Set();
	for (const folder of folders) {
		const release = /^micropython-v(\d+)_(\d+)_(\d+)-/.exec(folder);
		if (release) found.add(`${release[1]}.${release[2]}.${release[3]}`);
	}
	return [...found].filter((release) => compare(release, pinned) > 0).sort(compare);
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
 * Confined to the pinned release on purpose: moving to the next one is a
 * catalogue-wide decision that `newerReleases` reports separately.
 */
export function latestInSeries(versions, pinned) {
	const wanted = series(pinned);
	const newest = versions.filter((version) => valid(version) && series(version) === wanted).sort(compare).pop();
	return newest !== undefined && compare(newest, pinned) > 0 ? newest : undefined;
}

/** A version without its post-release suffix: `1.28.0.post5` is the `1.28.0` series. */
const series = (version) => explain(version).base_version;

/**
 * The newest of `versions` past `pinned`, or nothing when the pin is current.
 * A whole release, unlike `latestInSeries`, which stays inside the pinned one.
 *
 * Both repositories tag things that are not releases, and a pre-release is not
 * an update, so neither is offered as one.
 */
export function newerRelease(versions, pinned) {
	const newest = versions.filter((version) => valid(version) && !explain(version).is_prerelease).sort(compare).pop();
	return newest !== undefined && compare(newest, pinned) > 0 ? newest : undefined;
}

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

/**
 * One "is anything newer published?" line. The three upstreams differ only in
 * where the version list comes from and in what counts as newer, so that is the
 * argument; an update is always `news`, a failed lookup always `unknown`.
 *
 * @param {string} name what the line is about
 * @param {string} pinned the version config.json holds
 * @param {() => Promise<string | undefined>} findNewer newer version, if there is one
 */
async function checkRelease(name, pinned, findNewer) {
	try {
		const newer = await findNewer();
		return line(name, `${pinned}  ${newer ? `UPDATE AVAILABLE (${newer})` : 'up to date'}`, newer ? 'news' : 'ok');
	} catch (error) {
		return line(name, `lookup failed: ${error}`, 'unknown');
	}
}

/** Is a newer post-release of this pin published? */
const checkPin = ([id, source]) =>
	checkRelease(pypiName(id), source.version, async () =>
		latestInSeries(Object.keys((await pypi(pypiName(id))).releases), source.version));

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

/** One table. The width is shared across the tables of a section, so they line up. */
function report(title, lines, width = Math.max(...lines.map((entry) => entry.name.length))) {
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

/**
 * A pin that can move under us, re-downloaded and re-hashed.
 *
 * PyPI files are immutable; a git tag is a label and moving one is normal. Both
 * GitHub-sourced pins hang off a tag, and `fetch.mjs` only re-hashes what is
 * already cached, so a moved tag stays invisible until someone deletes
 * `.cache/` and gets a different build.
 */
async function checkMovablePin([id, source]) {
	try {
		const response = await fetch(source.url);
		if (!response.ok) return line(id, `${source.url}: ${response.status} ${response.statusText}`, 'unknown');
		const actual = digest(Buffer.from(await response.arrayBuffer()));
		return actual === source.sha256
			? line(id, `${source.version} still serves the bytes we pinned`)
			: line(id, `${source.version} now serves ${actual.slice(0, 12)}, not ${source.sha256.slice(0, 12)}: the tag moved`, 'drift');
	} catch (error) {
		return line(id, `could not re-fetch: ${error}`, 'unknown');
	}
}

/**
 * A source this file checks by name, which has to be there.
 *
 * A missing key means the config was renamed or the entry dropped, and returning
 * quietly would take a whole section of the report with it while the run still
 * passed. Unverified is the one thing this command may not report as verified.
 */
function required(sources, id) {
	const source = sources[id];
	if (!source) throw new Error(`config.json has no "${id}" source, so nothing about it can be checked`);
	return source;
}

/** micro:bit: one tarball off a tag, so both things that can change are asked about. */
async function checkMicrobit(sources) {
	const source = required(sources, MICROBIT);
	console.log('Checking microbit-foundation/micropython-microbit-stubs...\n');

	const tags = 'https://api.github.com/repos/microbit-foundation/micropython-microbit-stubs/tags';
	const lines = [
		await checkRelease(MICROBIT, source.version, async () =>
			newerRelease((await json(tags)).map((tag) => tag.name), source.version)),
		await checkMovablePin([MICROBIT, source]),
	];
	report('micro:bit', lines);
	console.log('');
	return lines;
}

/**
 * CircuitPython: the release, the two pins, and the claim the borrowed half
 * rests on.
 *
 * That last one is why this section exists. `CIRCUITPYTHON_FROM_UNIX` is only
 * correct while `docs/library/` keeps meaning the modules CircuitPython inherits
 * rather than implements, and upstream moving one in or out makes our base wrong
 * where no build assertion can see it: every file still exists, every board
 * still resolves.
 */
async function checkCircuitPython(sources) {
	const source = required(sources, CIRCUITPYTHON);
	console.log('Checking adafruit/circuitpython...\n');

	const name = pypiName(CIRCUITPYTHON);
	const lines = [
		await checkRelease(name, source.version, async () =>
			newerRelease(Object.keys((await pypi(name)).releases), source.version)),
		await checkMovablePin([CIRCUITPYTHON_LICENCE, required(sources, CIRCUITPYTHON_LICENCE)]),
	];
	let docs;
	try {
		docs = await circuitpythonDocs(source.version);
		lines.push(checkInheritedModules(docs));
	} catch (error) {
		lines.push(line('docs/library', `could not read the reference docs: ${error}`, 'unknown'));
	}
	report('CircuitPython', lines);
	console.log('');
	if (docs) reportBorrowedMembers(docs);
	return lines;
}

/**
 * `docs/library/` at the tag the stubs were built from. The whole repository for
 * fourteen files, because one tarball beats a directory listing plus a request
 * per file, which is also why this check is run by hand and not by the build.
 */
async function circuitpythonDocs(version) {
	const url = `https://codeload.github.com/adafruit/circuitpython/tar.gz/refs/tags/${version}`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
	const tree = extractTarGz(Buffer.from(await response.arrayBuffer()));

	const docs = new Map();
	for (const [path, content] of tree) {
		const name = /^[^/]+\/docs\/library\/([a-z_]+)\.rst$/.exec(path)?.[1];
		if (name && name !== 'index') docs.set(name, content.toString('utf8'));
	}
	if (docs.size === 0) throw new Error('no docs/library/*.rst in the tag, so the layout moved');
	return docs;
}

/**
 * The set our borrow list is derived from, asserted rather than assumed.
 *
 * Every module documented here is one CircuitPython inherits and generates no
 * stub for, so it has to come from MicroPython's. Six are not in the shared base
 * either and are named in `assemble.mjs`; a name appearing or leaving means that
 * hand-written six is no longer the right six.
 */
function checkInheritedModules(docs) {
	const documented = [...docs.keys()].sort();
	const known = INHERITED_MODULES.join(', ');
	if (documented.join(', ') === known) return line('docs/library', `${documented.length} inherited modules, as expected`);
	const added = documented.filter((name) => !INHERITED_MODULES.includes(name));
	const gone = INHERITED_MODULES.filter((name) => !documented.includes(name));
	return line('docs/library', `now documents ${documented.length} inherited module(s)` +
		`${added.length ? `, new: ${added.join(', ')}` : ''}${gone.length ? `, gone: ${gone.join(', ')}` : ''}. ` +
		'Check CIRCUITPYTHON_FROM_UNIX in assemble.mjs against it.', 'drift');
}

/**
 * The modules CircuitPython documents in `docs/library/` rather than generating
 * stubs for. Thirteen at 10.2.1, and the reason the base borrows at all.
 */
const INHERITED_MODULES = [
	'array', 'binascii', 'builtins', 'collections', 'errno', 'gc', 'heapq', 'io', 'json', 'platform', 're', 'select', 'sys',
];

/**
 * What a user would notice about the borrowed half, in the direction worth
 * acting on. Read against the base this build produced, since what a user sees
 * is what shipped, and reported rather than asserted: both parsers are
 * approximations and the numbers move when either project edits prose.
 */
function reportBorrowedMembers(docs) {
	let base;
	try {
		base = JSON.parse(readFileSync(path.join(here, '..', 'assets', 'stubs', 'circuitpython', 'stdlib.json'), 'utf8'));
	} catch {
		console.log('Borrowed modules: assets/stubs/ is not built, so there is nothing to compare. Run `npm run stubs`.\n');
		return;
	}

	const rows = [];
	let extras = 0;
	for (const [module, text] of [...docs].sort()) {
		const stub = base.files[`stdlib/${module}.pyi`] ?? base.files[`stdlib/${module}/__init__.pyi`];
		if (!stub) {
			rows.push([module, 'no stub ships for it at all']);
			continue;
		}
		const { missing, extra } = compareMembers(rstMembers(text, module), stubMembers(stub));
		extras += extra;
		if (missing.length) rows.push([module, `documented, and not in the stub: ${missing.join(' ')}`]);
	}

	console.log('Borrowed from MicroPython, against CircuitPython\'s own reference docs:');
	const width = Math.max(...rows.map(([module]) => module.length), 12);
	for (const [module, note] of rows) console.log(`  ${module.padEnd(width)}  ${note}`);
	console.log(`  ${'-'.padEnd(width)}  ${rows.length} module(s) where valid code may be flagged.`);
	console.log(`  ${''.padEnd(width)}  ${extras} name(s) the stubs carry that the docs do not mention, which is what`);
	console.log(`  ${''.padEnd(width)}  borrowing CPython-shaped stubs costs and is not per-name actionable.`);
	console.log('  Both sides are parsed approximately, so treat this as a reading list, not a gate.\n');
}

/** Everything this project assumes about an upstream, in one run. */
export async function checkStubs() {
	const { sources } = await readConfig();
	const { failed } = await checkMicroPythonPackages();
	const rest = [...(await checkMicrobit(sources)), ...(await checkCircuitPython(sources))];
	const unclean = rest.filter(unresolved);
	for (const { name, note } of unclean) console.log(`  ${name}  ${note}`);
	return { failed: failed + unclean.length };
}

// `pathToFileURL`, not a template string: only it produces the percent-encoding
// and the `file:///C:/` shape `import.meta.url` carries on Windows.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	// Never non-zero for an available update, so this is safe to wire into a
	// scheduled job: only a false claim or a check that could not run fails it.
	checkStubs()
		.then(({ failed }) => {
			if (failed) process.exitCode = 1;
		})
		.catch((error) => {
			console.error(String(error));
			process.exit(1);
		});
}
