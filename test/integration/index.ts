import * as vscode from 'vscode';
// Via the language client, not `vscode-jsonrpc` directly: it re-exports the same
// module, so the probe cannot drift onto a different protocol version than the
// client stack, and nothing new has to be declared to import it.
import { BrowserMessageReader, BrowserMessageWriter, createMessageConnection } from 'vscode-languageclient/browser';

import { SILENT_LOGGER } from '../../client/src/log-level';
import { createUriMap, SERVER_ROOT } from '../../client/src/uri-map';
import { type EngineUrls, startPyrightWorker } from '../../client/src/worker';
import { BYPASS_PROBE, replacementTypeshed } from './typeshed-fixture';

const EXTENSION_ID = 'carlosperate.micropython-lsp';

/**
 * Regression suite for the worker + language-server architecture.
 *
 * Every check reports before it asserts, so a failing run says which assumption
 * broke rather than just stopping at the first one.
 *
 * Hover is the instrument. Two alternatives were tried and both are dead ends:
 * `publishDiagnostics` is never sent (basedpyright registers pull-model
 * `textDocument/diagnostic` instead), and the pull itself never returns for a
 * file pyright is not tracking: it hangs rather than answering empty. Hover
 * answers promptly for any URI the server knows about.
 */

/**
 * The root the server actually sees, which is **not** the `SERVER_ROOT` constant.
 * Only a virtual scheme is rebased onto it; a `file:` workspace passes straight
 * through as itself. Hardcoding the constant made every seeded path land outside
 * pyright's project root when this runs on desktop, where the workspace is
 * already `file:`, and three checks failed for that reason alone. Set from the
 * live workspace before any check runs.
 */
let serverRoot = SERVER_ROOT;

interface Result {
	name: string;
	ok: boolean;
	detail: string;
}
const results: Result[] = [];

function record(name: string, ok: boolean, detail: string): void {
	results.push({ name, ok, detail });
	console.log(`[gate] ${ok ? 'PASS' : 'FAIL'}  ${name}\n[gate]       ${detail}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/**
 * Collects what `mirrorLogsToConsole` prints.
 *
 * The mirror is the one part of logging with no unit test: it needs a real
 * output channel and a real language client. Patching `console.log` here reads
 * the same stream a developer reads in DevTools, from inside the extension host
 * the extension runs in.
 */
const mirrored: string[] = [];
let consoleCalls = 0;
function captureMirroredLogs(): void {
	const original = console.log.bind(console);
	const patched = (...args: unknown[]) => {
		consoleCalls++;
		const first = args[0];
		if (typeof first === 'string' && first.startsWith('[micropython-lsp]')) mirrored.push(first);
		original(...args);
	};
	// The extension host installs its own console forwarder, so a plain
	// assignment can be refused and leave the capture silently empty.
	try {
		Object.defineProperty(console, 'log', { value: patched, writable: true, configurable: true });
	} catch {
		console.log = patched;
	}
	assert(console.log === patched, 'could not patch console.log, so the mirror cannot be observed');
}

const tracedSince = (mark: number) => mirrored.slice(mark).filter((line) => line.includes('[Trace'));

/**
 * Boot lines only the engine writes, used to prove its logs reach the console.
 *
 * A canary: it is the engine's wording, not a protocol guarantee. If this fails
 * after an engine bump, check the wording before suspecting the mirror. See the
 * upgrade checklist in dev.md.
 */
const ENGINE_BOOT_LINES = /basedpyright|Auto-excluding|Server root directory/;

const MOD_PROBE_SOURCE = 'def probe() -> str: ...\n';

/** Hover predicate: the seeded module's real signature, not a mid-analysis `Unknown`. */
const resolvesToStr = (text: string) => /->\s*str/.test(text);

/**
 * Hover predicate for "the language server is answering", used by every check
 * whose subject is the session's liveness rather than its contents.
 *
 * Deliberately not `LiteralString`, which the engine's own CPython typeshed gives
 * `sys.platform` and a device typeshed does not: asserting on it made these
 * checks quietly depend on which typeshed was live, and they went red the day a
 * real target shipped.
 *
 * A hover arriving at all is most of the signal, since nothing else in the
 * harness registers a Python hover provider and a dead server answers nothing.
 * The `Unknown` half is the rest: a session that restarted but resolved nothing
 * still hovers `platform: Unknown`, so the type has to be a real one without the
 * predicate caring which.
 */
const serverAnswered = (text: string | undefined) =>
	/platform:/.test(text ?? '') && !/Unknown/.test(text ?? '');

/** One file, every question. Hover targets are the last occurrence of each symbol. */
const PROBE_SOURCE = [
	'import sys',
	'from mod_probe import probe',
	'from gate_late import LATE',
	'',
	'check_stdlib = sys.maxsize',
	'check_sibling = probe',
	'check_late = LATE',
	'',
].join('\n');

export async function run(): Promise<void> {
	const ext = vscode.extensions.getExtension(EXTENSION_ID);
	assert(ext, `${EXTENSION_ID} was not loaded by the extension host`);

	// Before activate: the client derives the trace level during start().
	// Global, not Workspace: the harness mounts the workspace read-only, so a
	// workspace-scoped write cannot land.
	const config = vscode.workspace.getConfiguration('micropython-lsp');
	await config.update('logLevel', 'trace', vscode.ConfigurationTarget.Global);
	await config.update('mirrorLogsToConsole', true, vscode.ConfigurationTarget.Global);

	captureMirroredLogs();

	const activateStarted = Date.now();
	const api = await ext.activate();
	const activateMs = Date.now() - activateStarted;
	assert(ext.isActive, `${EXTENSION_ID} failed to activate`);
	const client = api?.client;
	assert(client, 'activate() did not return the language client');
	record('extension activates and the language client starts', true,
		`foreground worker booted and the LSP handshake completed in ${activateMs} ms`);

	// Asserted, not assumed. If the relay breaks, the foreground worker keeps
	// answering hover and completion and everything below still passes, while
	// background analysis silently never runs.
	const pyright = api?.pyright;
	assert(pyright, 'activate() did not return the worker handle');
	const relayed = await waitFor(async () => pyright.backgroundCount, (count) => count > 0);
	record('background analysis worker relayed', Boolean(relayed),
		`browser/newWorker → ${pyright.backgroundCount} background worker(s)`);

	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	assert(root, 'no workspace folder; the harness should mount test/workspace/');
	// `toString()`, not `toString(true)`: the client derives its own root from
	// `folders[0].uri.toString()`, so an unencoded copy of it would send every
	// seeded URI outside pyright's project root on any path needing escaping.
	const workspaceBase = root.toString().replace(/\/$/, '');
	serverRoot = createUriMap(workspaceBase).serverRoot;
	console.log(`[gate] workspace root: ${workspaceBase}`);
	console.log(`[gate] server root:    ${serverRoot}`);

	// First, before anything is seeded: this is the state a user is actually in
	// when they open a file in a fresh session.
	await checkEditorExperience(root, activateStarted);
	await checkLogging(root);
	await checkMirror(root);
	await checkDefinition(root);
	await checkEditorRoundTrip(root);
	await checkClosedFileDiagnostics(root);
	await checkWatcher(client, root);
	await checkOpenFileIsImportable(client, root);
	await checkOpenFileDiagnostics(root);

	// Everything is mirrored under the server root, which is what the extension
	// reports as its workspace folder and therefore what the mirror will use.
	// Other schemes may also happen to work, but asserting on that mostly measures
	// pyright's import caching rather than anything we control.
	const base = `${serverRoot}/gate`;

	// Created but never given content. Stub delivery depends on this staying
	// empty: there is no content channel after initialize.
	await client.sendNotification('pyright/createFile', { uri: `${base}/gate_late.py`, kind: 'create' });
	await seed(client, `${base}/mod_probe.py`, MOD_PROBE_SOURCE);
	await seed(client, `${base}/probe.py`, PROBE_SOURCE);

	// Hovering inside the seeded file separates "content never arrived" from
	// "import resolution isn't using it": two bugs with one symptom.
	const own = await hover(client, `${base}/mod_probe.py`, MOD_PROBE_SOURCE, 'probe', resolvesToStr);
	record('seeded file sees its OWN content', Boolean(own && resolvesToStr(own)),
		`hover inside mod_probe.py: ${oneLine(own)}`);

	const stdlib = await hover(client, `${base}/probe.py`, PROBE_SOURCE, 'maxsize', (t) => /int/.test(t));
	record('stdlib resolves (sys.maxsize)', Boolean(stdlib && /int/.test(stdlib)),
		`hover: ${oneLine(stdlib)}`);

	const late = await hover(client, `${base}/probe.py`, PROBE_SOURCE, 'LATE');
	record('post-start createFile stays EMPTY (no late content channel)',
		!late || !/int|str|float/.test(late),
		`stubs cannot be added after initialize. hover: ${oneLine(late)}`);

	await checkWorkspaceFile(client, root);
	await checkTypingKeepsUp(client);

	// The ping is answered with `MethodNotFound`, and only `ping()` knows that
	// counts as alive. Get it wrong and a healthy server restarts every few
	// seconds, which no unit test can see: it depends on what the engine replies.
	record('the liveness probe reports a healthy server as alive', await api.checkHealth(),
		'an unimplemented ping must come back as MethodNotFound, not as silence');

	// Before crash recovery, which leaves a different client behind. Both use their
	// own throwaway workers, so they do not disturb the session above.
	await checkEngineLoadFailure(ext);
	await checkTypeshedBypass(ext);

	// Last: these replace the client and worker that everything above holds.
	await checkCrashRecovery(api, root);
	// These three share state, each arriving on the target the one before it left
	// behind. The `finally` is for the path where one of them throws first, since
	// the write is Global and would otherwise outlive the run and start the next
	// one on the wrong board.
	try {
		await checkTargetSwitch(api, root);
		await checkDeviceStubs(root);
		await checkMicroPythonBoards(root);
		await checkCircuitPythonBoards(root);
	} finally {
		await setTarget(undefined);
	}
	await checkEnableToggle(api, root);
	summarise();
}

/**
 * Does the server keep up while the document keeps changing? The engine cannot
 * cancel an in-flight analysis, so this is the one measurement that could have
 * invalidated the engine choice.
 *
 * **Each edit renames the alias being completed**, so a non-empty result proves
 * the edit landed. Completing on something the edit does not touch measures a
 * possibly-stale document and reports a flatteringly small number.
 *
 * The latencies are logged, never asserted: a threshold here is a flaky CI
 * failure, and the number is only useful against itself over time.
 */
async function checkTypingKeepsUp(client: any): Promise<void> {
	const uri = `${serverRoot}/gate/perf.py`;
	await seed(client, uri, 'import sys\n');

	const latencies: number[] = [];
	let items = 0;
	for (let edit = 1; edit <= 20; edit++) {
		const alias = `sys_${edit}`;
		await client.sendNotification('textDocument/didChange', {
			textDocument: { uri, version: edit + 1 },
			contentChanges: [{ text: `import sys as ${alias}\n\n${alias}.\n` }],
		});
		const started = Date.now();
		const result = await client.sendRequest('textDocument/completion', {
			textDocument: { uri },
			position: { line: 2, character: alias.length + 1 },
		});
		latencies.push(Date.now() - started);
		items = result?.items?.length ?? result?.length ?? 0;
	}

	const sorted = [...latencies].sort((a, b) => a - b);
	record('completion keeps up while the document changes', items > 0,
		`20 edits, ${items} items on the newest alias: first ${latencies[0]} ms, ` +
		`median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted[sorted.length - 1]} ms, ` +
		`last ${latencies[latencies.length - 1]} ms`);
}

/**
 * A worker that cannot load its engine has to say so.
 *
 * VS Code's nested-worker polyfill carries `// todo onerror` where it would
 * forward an error out of a nested worker, so nothing on our side ever hears the
 * exception: without the entry reporting it by hand, a 404 on the engine is
 * perfectly silent and looks exactly like a slow start. Only a real extension
 * host can show that, since it is the polyfill that swallows it.
 */
async function checkEngineLoadFailure(ext: vscode.Extension<any>): Promise<void> {
	const errors: string[] = [];
	const workers = startPyrightWorker(
		{
			host: vscode.Uri.joinPath(ext.extensionUri, 'client/dist/engineWorkerMain.js').toString(true),
			engine: vscode.Uri.joinPath(ext.extensionUri, 'assets/no-such-engine.js').toString(true),
		},
		{ ...SILENT_LOGGER, error: (message) => errors.push(message) }
	);

	try {
		const reported = await waitFor(
			async () => errors.find((line) => line.includes('could not load')),
			Boolean,
			15_000
		);
		record('a worker that cannot load its engine reports it', Boolean(reported),
			reported ?? 'nothing was logged, so a bad engine URL would fail silently');
	} finally {
		workers.dispose();
	}
}

/**
 * The typeshed bypass gate: does a replacement typeshed root displace the embedded one?
 *
 * Both delivery mechanisms are read at `initialize`, so neither can be tested by
 * reconfiguring a running server. Each gets its own throwaway worker and client,
 * which also keeps the extension's own session out of it.
 *
 * `sys.platform` is the instrument. The embedded CPython typeshed types it as
 * `LiteralString`; the replacement root declares a plain `str`. So the hover text
 * says which root actually answered, and "no hover at all" stays distinguishable
 * from either, which matters because a root the engine cannot read looks exactly
 * like a successful bypass if you only assert that `subprocess` is gone.
 */
async function checkTypeshedBypass(ext: vscode.Extension<any>): Promise<void> {
	const engine: EngineUrls = {
		host: vscode.Uri.joinPath(ext.extensionUri, 'client/dist/engineWorkerMain.js').toString(true),
		engine: vscode.Uri.joinPath(ext.extensionUri, 'assets/pyright.worker.js').toString(true),
	};
	const root = '/mp-typeshed';
	const files = replacementTypeshed(root);

	// A: typeshedPaths, the channel the contributed setting feeds.
	await recordBypassCase('A: typeshedPaths configuration', engine, files, {
		typeshedPaths: [`file://${root}`],
		logLevel: 'trace',
	});

	// B: a seeded pyrightconfig.json, with the configuration pointing back at the
	// embedded root so anything that works is the config file's doing.
	await recordBypassCase(
		'B: seeded pyrightconfig.json',
		engine,
		{ ...files, '/pyrightconfig.json': JSON.stringify({ typeshedPath: root, stubPath: `${root}/stubs` }, null, 2) },
		{ typeshedPaths: ['file:///typeshed'], logLevel: 'trace' }
	);
}

/**
 * One mechanism, reported either way.
 *
 * A throw here would skip crash recovery and `summarise()` with it, losing every
 * result the run had already accumulated. The suite reports before it asserts.
 */
async function recordBypassCase(
	mechanism: string,
	engine: EngineUrls,
	files: Record<string, string>,
	analysisConfig: Record<string, unknown>
): Promise<void> {
	try {
		recordBypass(mechanism, await probeBypass(engine, files, analysisConfig));
	} catch (error) {
		record(`typeshed bypass, ${mechanism}`, false, `the probe threw: ${String(error)}`);
	}
}

interface BypassResult {
	stdlib: string | undefined;
	own: string | undefined;
	missing: string | undefined;
}

/**
 * The two hovers that decide it, over a raw JSON-RPC connection.
 *
 * Deliberately not a second `LanguageClient`: that one registers the server's
 * commands with VS Code, and a second registration of `basedpyright.createtypestub`
 * throws `command already exists`, failing the probe's `start()` before it asks
 * anything. A bare connection also means the gate answers `workspace/configuration`
 * itself, so mechanism A is tested against a known reply rather than through the
 * settings plumbing that the rest of the suite already exercises.
 */
async function probeBypass(
	engine: EngineUrls,
	files: Record<string, string>,
	analysisConfig: Record<string, unknown>
): Promise<BypassResult> {
	const relay = (m: string) => console.log(`[gate:bypass] ${m}`);
	const workers = startPyrightWorker(engine, { error: relay, warn: relay, info: relay, trace: relay });
	const connection = createMessageConnection(
		new BrowserMessageReader(workers.worker),
		new BrowserMessageWriter(workers.worker)
	);

	// The server asks for `python` and `basedpyright.analysis`, one entry per
	// requested section. Anything unasked-for gets an empty object, never null:
	// pyright reads properties off the reply without guarding.
	connection.onRequest('workspace/configuration', (params: any) =>
		(params.items ?? []).map((item: any) =>
			item.section === 'basedpyright.analysis' ? analysisConfig : {}
		)
	);
	connection.onRequest('client/registerCapability', () => null);
	connection.onRequest('window/workDoneProgress/create', () => null);

	// `logLevel: 'trace'` makes the resolver name every directory it searched, the
	// only way to see which root actually answered for a module.
	connection.onNotification('window/logMessage', ({ message }: any) => {
		if (/subprocess|microbit|typeshed/i.test(message)) console.log(`[gate:resolve] ${message}`);
	});

	connection.listen();

	try {
		// Bounded: a worker that boots but never answers `initialize` would
		// otherwise hang the whole gate with no FAIL line and no summary.
		await withTimeout(connection.sendRequest('initialize', {
			processId: null,
			rootUri: 'file:///',
			workspaceFolders: [{ uri: 'file:///', name: 'bypass' }],
			initializationOptions: { files },
			capabilities: {
				workspace: { configuration: true, workspaceFolders: true },
				textDocument: {
					synchronization: {},
					hover: { contentFormat: ['markdown', 'plaintext'] },
				},
			},
		}), 30_000, 'initialize');
		await connection.sendNotification('initialized', {});

		const uri = 'file:///bypass/probe.py';
		await seed(connection, uri, BYPASS_PROBE);
		return {
			// Order is load-bearing. These two wait on a predicate, which drains the
			// analysis pass, so the absence probe below reads a settled file. Hover
			// it first instead and a mid-analysis `Unknown` reports a bypass that
			// never happened.
			stdlib: await hover(connection, uri, BYPASS_PROBE, 'platform', (t) => /str|LiteralString/.test(t)),
			own: await hover(connection, uri, BYPASS_PROBE, 'panic', (t) => /panic/.test(t)),
			missing: await hover(connection, uri, BYPASS_PROBE, 'Popen'),
		};
	} finally {
		// Never let a probe's workers outlive it: the next probe boots its own.
		connection.dispose();
		workers.dispose();
	}
}

/**
 * Both halves must hold. A root the engine never loaded also has no `subprocess`,
 * so "it is gone" alone is not evidence: `microbit` and `sys.platform` are what
 * separate a real bypass from a typeshed that simply failed to resolve.
 */
function recordBypass(mechanism: string, { stdlib, own, missing }: BypassResult): void {
	const replacementLive = Boolean(stdlib && !/LiteralString/.test(stdlib) && /\bstr\b/.test(stdlib));
	const ownResolves = Boolean(own && /def panic/.test(own));
	// Requires a hover that says `Unknown`, rather than accepting silence. No
	// answer at all is not evidence of absence, and treating it as a pass is how a
	// gate goes green on an engine that stopped answering.
	const subprocessGone = Boolean(missing && /Unknown/.test(missing) && !/\(class\)|__init__/.test(missing));

	record(`typeshed bypass, ${mechanism}`, replacementLive && ownResolves && subprocessGone,
		`sys.platform: ${oneLine(stdlib)} (want str, not LiteralString); ` +
		`microbit.panic: ${oneLine(own)} (want a def); ` +
		`subprocess.Popen: ${oneLine(missing)} (want Unknown, not a class)`);
}

/**
 * Crash recovery, which never runs in normal use and so is the thing that will
 * silently regress.
 *
 * `terminate()` is the honest simulation: it is exactly as silent as a real
 * crash. Nothing fires, `postMessage` keeps succeeding into the void, and the
 * LSP connection never closes, so the liveness probe is the only detector, and
 * driving it by hand is what keeps this test from waiting out a 30s interval.
 */
async function checkCrashRecovery(api: any, root: vscode.Uri): Promise<void> {
	const before = api.pyright;
	assert(before, 'activate() did not return the worker handle');

	const { uri, platform } = await openBench(root);

	before.worker.terminate();
	console.log('[gate] terminated the foreground worker');

	const answers: boolean[] = [];
	for (let probe = 0; probe < 2; probe++) answers.push(await api.checkHealth());
	record('a silently terminated worker is detected', answers.every((alive) => !alive),
		`probes answered alive: ${answers.join(', ')} (both must be false)`);

	// Hover, not completion: with the server dead VS Code still answers `sys.`
	// with ~200 word-based suggestions, so a completion list proves nothing here.
	// Only the language server answers a hover at all.
	const recovered = await waitFor(
		() => editorHover(uri, platform),
		serverAnswered,
		60_000
	);
	record('the server recovers without a window reload', serverAnswered(recovered),
		`hover on sys.platform after the crash: ${oneLine(recovered)}`);
	const after = api.pyright;
	record('the replacement is a new worker', after !== undefined && after !== before,
		`before=${describeWorker(before)} after=${describeWorker(after)}`);
}

/**
 * Changing the target rebuilds the session on a **new worker**.
 *
 * The engine reads its seed once, at `initialize`, into a filesystem it merges
 * into and never removes from, and the language client re-wraps the `Worker` it
 * was constructed with. So anything short of a new worker leaves the previous
 * board's exclusive modules resolvable, silently. Only a real extension host can
 * show which worker answered, and this is the check that catches a regression
 * back to `client.restart()`.
 */
async function checkTargetSwitch(api: any, root: vscode.Uri): Promise<void> {
	const before = api.pyright;
	assert(before, 'activate() did not return the worker handle');

	await setTarget('microbit');
	const replaced = await waitFor(async () => api.pyright, (handle) => handle !== undefined && handle !== before);
	record('switching target rebuilds on a new worker', replaced !== undefined && replaced !== before,
		`before=${describeWorker(before)} after=${describeWorker(replaced)}`);

	// The handle changing only proves a session was built. Hover proves the one
	// that replaced it actually answers, which is the half a bad restart breaks.
	const { uri, platform } = await openBench(root);
	const answering = await waitFor(
		() => editorHover(uri, platform),
		serverAnswered,
		60_000
	);
	record('the server for the new target answers', serverAnswered(answering),
		`hover on sys.platform after the switch: ${oneLine(answering)}`);
}

/**
 * The product's central claim, in three assertions: the selected board's modules
 * resolve, CPython's do not, and changing the board changes both.
 *
 * Diagnostics rather than hover for the import lines. Hovering a module symbol
 * reports `Module("subprocess")` whether or not the import resolved, which reads
 * identically in both worlds; an unresolved import is a *diagnostic*, and
 * `main.py` is open, so VS Code pulls for it.
 *
 * Runs after the switch check, which leaves the target on `microbit`.
 */
async function checkDeviceStubs(root: vscode.Uri): Promise<void> {
	const bench = await openImports(root);

	// The board's own modules. Waited on, because the session restarted moments ago.
	const microbitProblems = await waitFor(() => bench.unresolved(MICROBIT), (found) => found.length === 0, 60_000);
	record('the selected board\'s modules resolve', (microbitProblems ?? []).length === 0,
		`${MICROBIT}: ${problems(microbitProblems) || 'no problems'}`);

	// The whole point of the bypass. A resolved `subprocess` means the engine's
	// own CPython typeshed is live and a learner can autocomplete a desktop stdlib.
	const cpython = await waitFor(() => bench.unresolved(SUBPROCESS), (found) => found.length > 0, 30_000);
	record('CPython\'s stdlib does NOT resolve', (cpython ?? []).length > 0,
		`${SUBPROCESS}: ${problems(cpython) || 'resolved, so the wrong typeshed is live'}`);

	// Both halves matter: `sys` going red too would mean the seed replaced
	// everything rather than bypassing, which reads the same from `subprocess` alone.
	const stdlib = await bench.unresolved(SYS);
	record('the board\'s own stdlib still resolves', stdlib.length === 0, `${SYS}: ${problems(stdlib) || 'no problems'}`);

	// Hover, not just the absence of a diagnostic: an import can resolve to an
	// empty module, which is what a seed delivered through the wrong channel gives.
	const display = await bench.hoverOn(MICROBIT, 'display');
	record('a device module carries its real types', /display/.test(display ?? '') && !/Unknown/.test(display ?? ''),
		`hover on display: ${oneLine(display)}`);

	// Nothing we ship has source behind it, so this rule would fire on every
	// device import if the severity override were dropped.
	const missingSource = vscode.languages
		.getDiagnostics(bench.uri)
		.filter((d) => ruleOf(d) === 'reportMissingModuleSource');
	record('stub-only modules raise no missing-source warning', missingSource.length === 0,
		`${missingSource.length} reportMissingModuleSource diagnostic(s) in main.py`);

	// Switching away must take the board's modules with it. This is the assertion
	// the new-worker rule exists for: the engine merges seeds and never removes,
	// so a reconfigured session would still resolve `microbit` here.
	await setTarget(undefined);
	const gone = await waitFor(() => bench.unresolved(MICROBIT), (found) => found.length > 0, 60_000);
	record('switching away drops the previous board\'s modules', (gone ?? []).length > 0,
		`after switching to the default target, ${MICROBIT}: ` +
		`${problems(gone) || 'still resolving, so the seed leaked across the switch'}`);

	const stillStdlib = await bench.unresolved(SYS);
	record('the default target keeps a working stdlib', stillStdlib.length === 0,
		`${SYS} on the default target: ${problems(stillStdlib) || 'no problems'}`);
}

/**
 * MicroPython's shared base plus a board overlay, which is the first target
 * built from two layers rather than one.
 *
 * Three things are only visible here. That an overlay resolves at all; that
 * moving between two chip families takes the previous one's modules away, which
 * a reconfigured session would not do since the engine merges seeds and never
 * removes; and that the helper package the base has to relocate into the
 * typeshed root is reachable. The last one cannot be seen from the module that
 * imports it, because that module resolves either way and only the types coming
 * through it turn `Unknown`.
 *
 * Arrives on the default target, which is what `checkDeviceStubs` leaves behind.
 */
async function checkMicroPythonBoards(root: vscode.Uri): Promise<void> {
	const bench = await openImports(root);

	// The first-run experience. A board module resolving with nothing selected
	// means the default is pointed at some board's layer rather than the base.
	const unchosen = await waitFor(() => bench.unresolved(MACHINE), (found) => found.length > 0, 60_000);
	record('the default target offers no board modules', (unchosen ?? []).length > 0,
		`${MACHINE} with no board selected: ${problems(unchosen) || 'resolved, so the default is not the bare stdlib'}`);

	for (const [target, mine, theirs] of [
		['micropython/esp32/esp32_generic', ESP32, RP2],
		['micropython/rp2/rpi_pico', RP2, ESP32],
	] as const) {
		await setTarget(target);

		// Both halves in one predicate, because the client clears its diagnostics
		// while it restarts: "no problem on this line" is briefly true of every
		// line, so waiting on it alone can pass before the new board has loaded.
		const settled = await waitFor(
			async () => ({ mine: await bench.unresolved(mine), theirs: await bench.unresolved(theirs) }),
			(state) => state.mine.length === 0 && state.theirs.length > 0,
			60_000
		);
		record(`${target} resolves its own board modules`, settled?.mine.length === 0,
			`${mine}: ${problems(settled?.mine) || 'no problems'}`);
		record(`${target} does not resolve another family's`, (settled?.theirs.length ?? 0) > 0,
			`${theirs}: ${problems(settled?.theirs) || 'resolved, so the previous board survived the switch'}`);
	}

	// The relocated helper package, read through a signature rather than through
	// the module that imports it: `sys` resolves whether or not the move happened.
	const shed = await waitFor(() => bench.hoverOn(SHED_PROBE, 'print_exception'), carriesShedType, 30_000);
	record('the base\'s helper package is reachable from the typeshed root', carriesShedType(shed),
		`hover on sys.print_exception: ${oneLine(shed)}`);

	// Same guarantee as the micro:bit target, on a two-layer one: the board's
	// modules are there and desktop Python's still are not.
	const cpython = await bench.unresolved(SUBPROCESS);
	record('a two-layer target still hides CPython\'s stdlib', cpython.length > 0,
		`${SUBPROCESS}: ${problems(cpython) || 'resolved, so the base layer restored the embedded typeshed'}`);
}

/**
 * CircuitPython, the first flavour where two boards differ by what the base
 * offers them rather than by what their own layer adds.
 *
 * 628 boards share one base of 217 files, so this is the only check that can see
 * the allowlist work: `wifi` is in the base either way, and the two Picos differ
 * only in whether their board says it has a radio. Getting that wrong offers a
 * learner hardware they do not have, and it takes the real merge at load time to
 * see, so no unit test can.
 *
 * Arrives on whichever MicroPython board the check before it left.
 */
async function checkCircuitPythonBoards(root: vscode.Uri): Promise<void> {
	const bench = await openImports(root);

	await setTarget('circuitpython/raspberry_pi_pico_w');
	// One predicate over all three, because the client clears its diagnostics
	// while it restarts: every line is briefly clean, so waiting on the resolving
	// half alone can pass before the new board has loaded.
	const settled = await waitFor(
		async () => ({
			board: await bench.unresolved(BOARD),
			radio: await bench.unresolved(WIFI),
			micropython: await bench.unresolved(MACHINE),
		}),
		(state) => state.board.length === 0 && state.radio.length === 0 && state.micropython.length > 0,
		60_000
	);
	record('a CircuitPython board resolves its own modules', settled?.board.length === 0,
		`${BOARD}: ${problems(settled?.board) || 'no problems'}`);
	// The flavours must not bleed into each other. `machine` is MicroPython's and
	// exists on every one of its boards, so a CircuitPython target resolving it
	// means a MicroPython layer is still live.
	record('a CircuitPython board does not resolve MicroPython\'s modules', (settled?.micropython.length ?? 0) > 0,
		`${MACHINE}: ${problems(settled?.micropython) || 'resolved, so the flavours are bleeding into each other'}`);

	// The board's own layer, which is one file: the base ships a pin-less
	// placeholder for `board` and the overlay replaces it. Completion rather than
	// hover, because the pins are what a user reaches for and an empty list is
	// exactly what the placeholder would give.
	// Probed on a pin that appears nowhere in the workspace. `GP0` is written on
	// the bench line itself, so VS Code's word-based suggestions offer it whether
	// or not a server is running, and asserting on it would pass against an empty
	// board module.
	const pins = await waitFor(() => bench.completeAfter(PIN, 'board.'), (items) => items.includes(UNWRITTEN_PIN), 30_000);
	record('the board layer carries that board\'s own pins', (pins ?? []).includes(UNWRITTEN_PIN),
		`completion after "board.": ${pins?.length ?? 0} item(s)${pins?.length ? `, e.g. ${pins.slice(0, 4).join(', ')}` : ''}`);

	// The phase, in one assertion: same base, same layer format, and the board
	// without a radio does not get one.
	await setTarget('circuitpython/raspberry_pi_pico');
	const filtered = await waitFor(
		async () => ({ radio: await bench.unresolved(WIFI), board: await bench.unresolved(BOARD) }),
		(state) => state.radio.length > 0 && state.board.length === 0,
		60_000
	);
	record('a board with no radio does not resolve wifi', (filtered?.radio.length ?? 0) > 0,
		`${WIFI} on a Pico: ${problems(filtered?.radio) || 'resolved, so the allowlist did not filter the shared base'}`);
	record('and keeps everything its own board list names', filtered?.board.length === 0,
		`${BOARD} on a Pico: ${problems(filtered?.board) || 'no problems'}`);
}

/** Bench lines these checks ask about, matched from the start of the line. */
const SYS = 'import sys';
const MICROBIT = 'from microbit import';
const SUBPROCESS = 'import subprocess';
const MACHINE = 'import machine';
const ESP32 = 'import esp32';
const RP2 = 'import rp2';
const SHED_PROBE = 'sys.print_exception(';
const BOARD = 'import board';
const WIFI = 'import wifi';
const PIN = 'pin = board.';

/**
 * A pin on the Pico W that is written nowhere in the bench, so only the board's
 * own stub can offer it. CLAUDE.md: a completion list is never evidence on its
 * own, since a dead server still yields word-based items from the document.
 */
const UNWRITTEN_PIN = 'A0';

/**
 * A type that only resolves if the standard library's helper package was moved
 * into the typeshed root. `Unknown` is the shape of it not having been.
 */
const carriesShedType = (hover: string | undefined) => /IOBase_mp/.test(hover ?? '');

/**
 * The bench in an editor, and the two questions asked of it below: whether a
 * line's import resolved, and what a symbol on it hovers as.
 *
 * Open, because diagnostics are pull-model and VS Code only pulls for documents
 * it has. Re-read per call rather than captured, since every check here runs
 * across a session restart.
 */
async function openImports(root: vscode.Uri) {
	const uri = vscode.Uri.joinPath(root, 'main.py');
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc);

	const lines = doc.getText().split('\n');
	const lineOf = (start: string) => {
		const line = lines.findIndex((text) => text.startsWith(start));
		assert(line >= 0, `test/workspace/main.py no longer contains a line starting "${start}"`);
		return line;
	};

	return {
		uri,
		unresolved: async (start: string) => {
			const line = lineOf(start);
			return vscode.languages
				.getDiagnostics(uri)
				.filter((d) => d.range.start.line === line && /report(Missing|Attribute)/.test(ruleOf(d)));
		},
		hoverOn: (start: string, symbol: string) => {
			const line = lineOf(start);
			return hoverAt(uri, line, doc.lineAt(line).text.indexOf(symbol));
		},
		/**
		 * What completion offers just after `upTo` on a line, by label.
		 *
		 * The one question hover cannot answer: a module that resolves to an empty
		 * placeholder hovers exactly like one carrying a board's pins.
		 */
		completeAfter: async (start: string, upTo: string) => {
			const line = lineOf(start);
			const at = doc.lineAt(line).text.indexOf(upTo);
			assert(at >= 0, `test/workspace/main.py line "${start}" no longer contains "${upTo}"`);
			const list = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				uri,
				new vscode.Position(line, at + upTo.length)
			);
			return (list?.items ?? []).map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
		},
	};
}

/** Unresolved-import diagnostics as one line. Empty when the import resolved. */
const problems = (found: readonly vscode.Diagnostic[] | undefined) =>
	(found ?? []).map((d) => oneLine(d.message)).join('; ');

/** Global, not Workspace: the web harness mounts the workspace read-only. */
const setTarget = (id: string | undefined) =>
	vscode.workspace.getConfiguration('micropython-lsp').update('target', id, vscode.ConfigurationTarget.Global);

/** Hover at a position given as line and character, flattened to text. */
const hoverAt = (uri: vscode.Uri, line: number, character: number) =>
	editorHover(uri, new vscode.Position(line, character));

/**
 * `micropython-lsp.enable`, both ways.
 *
 * Only the extension host can show this: the setting is read in `activate` and
 * again from a configuration listener, and the failure that matters is silent
 * either way. Off leaving the workers running wastes a worker nobody owns; on
 * failing to rebuild leaves the extension looking installed and dead until a
 * reload.
 */
async function checkEnableToggle(api: any, root: vscode.Uri): Promise<void> {
	const config = vscode.workspace.getConfiguration('micropython-lsp');

	await config.update('enable', false, vscode.ConfigurationTarget.Global);
	const stopped = await waitFor(async () => api.client, (client) => client === undefined);
	record('disabling stops the language server', stopped === undefined,
		`micropython-lsp.enable=false, client is ${stopped === undefined ? 'gone' : 'still running'}`);

	await config.update('enable', true, vscode.ConfigurationTarget.Global);
	const { uri, platform } = await openBench(root);
	// Hover, not the client handle: a client that exists but never answers is the
	// failure this is here to catch.
	const restarted = await waitFor(
		() => editorHover(uri, platform),
		serverAnswered,
		60_000
	);
	record('re-enabling starts a working server', serverAnswered(restarted),
		`micropython-lsp.enable=true, hover on sys.platform: ${oneLine(restarted)}`);

	// `update()` resolves once the value is written, not once our listener has
	// finished with it, so this second pair lands while the first is still
	// stopping. Unserialised, the enable half sees the client the disable half is
	// still tearing down, does nothing, and the extension is left off with the
	// setting saying on.
	await config.update('enable', false, vscode.ConfigurationTarget.Global);
	await config.update('enable', true, vscode.ConfigurationTarget.Global);
	const settled = await waitFor(
		() => editorHover(uri, platform),
		serverAnswered,
		60_000
	);
	record('a rapid off/on settles on', serverAnswered(settled),
		`toggled without waiting between, hover on sys.platform: ${oneLine(settled)}`);
}

/**
 * The mirror mechanism against real workspace files, done the way the real
 * mirror must do it: onto `file:` URIs under the server root.
 *
 * `pyright/createFile` keys the VFS on `Uri.getPath()` while `didOpen` keys on
 * the whole URI, so under any non-`file:` scheme the two disagree and the module
 * resolves empty. Mirroring onto `file:` makes path and URI the same thing.
 *
 * Seeding *inside* the root is load-bearing, not tidiness: a sibling import from
 * a file outside every workspace folder does not resolve.
 */
async function checkWorkspaceFile(client: any, root: vscode.Uri): Promise<void> {
	const read = async (name: string) =>
		new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name)));

	// Real workspace content, under names the real mirror will never produce, so
	// this measures the protocol rather than accidentally re-testing the mirror.
	await seed(client, `${serverRoot}/gate_lib.py`, await read('helper.py'));

	const probeSource = 'from gate_lib import greet\n\ncheck_seeded = greet\n';
	await seed(client, `${serverRoot}/gate_probe.py`, probeSource);

	const text = await hover(client, `${serverRoot}/gate_probe.py`, probeSource, 'greet', (t) => /name:\s*str/.test(t));
	record('workspace file: closed sibling module resolves',
		Boolean(text && /name:\s*str/.test(text) && /->\s*str/.test(text)),
		`helper.py never opened in an editor. hover: ${oneLine(text)}`);

	// Opening the real file in an editor makes VS Code sync it under its own
	// scheme. `uriConverters` rewrite it onto the server root, so the server has
	// one identity for the file rather than an editor copy and a mirrored copy.
	await vscode.window.showTextDocument(
		await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'main.py'))
	);
	const mapped = `${serverRoot}/main.py`;
	const viaEditor = await hover(client, mapped, await read('main.py'), 'platform', (t) => /platform/.test(t));
	record('editor document arrives under the server root', Boolean(viaEditor && /platform/.test(viaEditor)),
		`opened as ${root.scheme}:, answered as ${mapped}: ${oneLine(viaEditor)}`);
}

/**
 * The phase's acceptance criterion, and the only check that exercises the real
 * mirror: `helper.py` is never opened in an editor, so the server can only know
 * `greet` if the mirror walked the workspace and pushed its content.
 *
 * Runs before anything is hand-seeded. Everything below seeds by hand, which
 * would make this pass for the wrong reason.
 */
async function checkMirror(root: vscode.Uri): Promise<void> {
	const { uri, greet } = await openBenchImport(root);

	const hovered = await waitFor(() => editorHover(uri, greet), (text) => Boolean(text && /name:\s*str/.test(text)));
	record('mirror: a never-opened workspace module resolves', Boolean(hovered && /name:\s*str/.test(hovered)),
		`helper.py mirrored, never opened. hover on greet: ${oneLine(hovered)}`);

	const stillClosed = !vscode.workspace.textDocuments.some((doc) => doc.uri.path.endsWith('/helper.py'));
	record('mirror: it really is closed', stillClosed,
		stillClosed ? 'helper.py is not among the open documents' : 'helper.py got opened, so the check proved nothing');
}

/**
 * Definition is the only way to catch a broken *reverse* mapping: hover answers
 * carry no URI, so everything else here would pass while go-to-definition sent
 * the user to a `file:///workspace/…` phantom that does not exist.
 */
async function checkDefinition(root: vscode.Uri): Promise<void> {
	const { uri, greet } = await openBenchImport(root);

	const found = await waitFor(
		() => vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', uri, greet),
		(locations) => Boolean(locations?.length)
	);
	const target = found?.[0]?.uri;
	const ok = target?.scheme === root.scheme && target.path.endsWith('/helper.py');
	record('definition lands on the real workspace file', ok,
		`definition of greet: ${target?.toString() ?? 'nothing'} (want ${root.scheme}:, not the server root)`);
}

/**
 * The handover in both directions. Opening a mirrored file gives VS Code
 * ownership of a URI the mirror already owns, and closing it makes VS Code drop
 * the server's copy on the mirror's behalf. Both are silent when they break:
 * everything still answers, just about an empty module.
 *
 * The close direction is not observable in either harness. Neither
 * `vscode-test-web` nor the desktop gate disposes a text document, so
 * `onDidCloseTextDocument` never fires however the editor is closed (confirmed by
 * waiting on the event after `closeActiveEditor`, on both), and the mirror never
 * sees a close to react to. So the assertion is made only when the event really
 * arrives, and skipped loudly when it does not: written unconditionally it would
 * pass for the wrong reason, because the file is still open. If a future host does
 * fire it, this starts checking the re-seed instead of announcing that it cannot.
 */
async function checkEditorRoundTrip(root: vscode.Uri): Promise<void> {
	const { uri: mainUri, greet } = await openBenchImport(root);
	const helperUri = vscode.Uri.joinPath(root, 'helper.py');
	const resolves = (text: string | undefined) => Boolean(text && /name:\s*str/.test(text));

	const doc = await vscode.workspace.openTextDocument(helperUri);
	await vscode.window.showTextDocument(doc);
	const whileOpen = await waitFor(() => editorHover(mainUri, greet), resolves);
	record('round trip: resolves while the file is open in an editor', resolves(whileOpen),
		`helper.py open, hover on greet: ${oneLine(whileOpen)}`);

	const closed = whenClosed(helperUri, 5_000);
	await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	if (!(await closed)) {
		record('NOTE: the re-seed on editor close is not observable here', true,
			'onDidCloseTextDocument never fired, so the mirror never saw a close. No harness fires it, ' +
			'web or desktop, so this half is covered by the manual check only.');
		return;
	}

	const afterClose = await waitFor(() => editorHover(mainUri, greet), resolves);
	record('round trip: still resolves after the editor closes it', resolves(afterClose),
		`VS Code's didClose drops the server's copy; the mirror must re-seed. hover: ${oneLine(afterClose)}`);
}

/** Resolves when VS Code really closes `uri`, which is what the mirror reacts to. */
function whenClosed(uri: vscode.Uri, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const subscription = vscode.workspace.onDidCloseTextDocument((doc) => {
			if (doc.uri.path !== uri.path) return;
			clearTimeout(timer);
			subscription.dispose();
			resolve(true);
		});
		timer = setTimeout(() => {
			subscription.dispose();
			resolve(false);
		}, timeoutMs);
	});
}

/**
 * The watcher path: a file created after the seed must reach the server without
 * a reload. Writes into the bench folder and takes it away again.
 */
async function checkWatcher(client: any, root: vscode.Uri): Promise<void> {
	const created = vscode.Uri.joinPath(root, 'gate_created.py');
	const source = 'def spark() -> int:\n    return 1\n';

	try {
		await vscode.workspace.fs.writeFile(created, new TextEncoder().encode(source));
	} catch (error) {
		record('NOTE: watcher not exercised here', true,
			`the harness mount is read-only (${oneLine(String(error))}); watcher coverage is the manual check`);
		return;
	}

	try {
		const text = await hover(client, `${serverRoot}/gate_created.py`, source, 'spark', (t) => /int/.test(t));
		record('watcher: a file created after the seed is mirrored', Boolean(text && /int/.test(text)),
			`created gate_created.py, hover on spark: ${oneLine(text)}`);
	} finally {
		await vscode.workspace.fs.delete(created).then(undefined, () => {});
	}
}

/**
 * A file the user creates is opened in an editor straight away, so the mirror
 * never owns it. It still has to become importable: `didOpen` carries content
 * but only `pyright/createFile` makes a path the resolver can find.
 */
async function checkOpenFileIsImportable(client: any, root: vscode.Uri): Promise<void> {
	const created = vscode.Uri.joinPath(root, 'gate_open.py');
	const source = 'def spark() -> int:\n    return 1\n';

	try {
		await vscode.workspace.fs.writeFile(created, new TextEncoder().encode(source));
	} catch (error) {
		record('NOTE: open-file import not exercised here', true, `read-only mount: ${oneLine(String(error))}`);
		return;
	}

	try {
		// Opened in an editor, exactly as the Explorer's New File leaves it.
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(created));

		const probe = 'from gate_open import spark\n\ncheck_open = spark\n';
		await seed(client, `${serverRoot}/gate_probe_open.py`, probe);
		const text = await hover(client, `${serverRoot}/gate_probe_open.py`, probe, 'spark', (t) => /int/.test(t));
		record('a file open in an editor is importable by others', Boolean(text && /int/.test(text)),
			`gate_open.py open in an editor, hover on the imported spark: ${oneLine(text)}`);
	} finally {
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		await vscode.workspace.fs.delete(created).then(undefined, () => {});
	}
}

/**
 * Squiggles in an open file, which is as far as a pull model reaches.
 *
 * This is the check that guards the port fix in `client/src/engine-host.ts`.
 * Without it the engine never answers `textDocument/diagnostic` at all and this
 * reports zero, which is what a build that dropped `engineWorkerMain.js`, or an
 * engine bump that moved the call site, would look like.
 *
 * It asserts on the rule that fired, not on the message or the count: block 3's
 * `greet(42)` passes an `int` where a `str` is wanted, so `reportArgumentType`
 * is proof the engine really checked types rather than merely reporting the
 * unresolved imports further down. Rule ids are stable identifiers; the prose
 * and the severities around them are not, and the type checking mode still to be
 * set will change how many of the other eight problems survive.
 */
async function checkOpenFileDiagnostics(root: vscode.Uri): Promise<void> {
	const mainUri = vscode.Uri.joinPath(root, 'main.py');
	const doc = await vscode.workspace.openTextDocument(mainUri);
	await vscode.window.showTextDocument(doc);

	const line = doc.getText().split('\n').findIndex((l) => l.startsWith('greet(42)'));
	assert(line >= 0, 'test/workspace/main.py no longer contains greet(42)');

	const here = (d: vscode.Diagnostic) => d.range.start.line === line;
	const argumentType = (d: vscode.Diagnostic) => ruleOf(d) === 'reportArgumentType';
	const problems = await waitFor(
		async () => vscode.languages.getDiagnostics(mainUri),
		(found) => found.filter(here).some(argumentType)
	);

	const onBlock3 = (problems ?? []).filter(here);
	record('diagnostics reach the Problems panel for an open file', onBlock3.some(argumentType),
		`${problems?.length ?? 0} problem(s) in main.py, ${onBlock3.length} on greet(42) ` +
		`[${onBlock3.map(ruleOf).join(', ')}]: ${oneLine(onBlock3.find(argumentType)?.message)}`);
}

/** The rule id behind a diagnostic. VS Code carries it as a string or a link. */
function ruleOf(diagnostic: vscode.Diagnostic): string {
	const code = diagnostic.code;
	return String(typeof code === 'object' && code !== null ? code.value : code);
}

/**
 * The pull-model limit, recorded rather than asserted because it is the scope we
 * promise rather than a thing that can break. `broken.py` is mirrored and never
 * opened, and carries a type error the server certainly knows about; VS Code
 * simply never asks about a URI it has no document for, so nobody pulls.
 */
async function checkClosedFileDiagnostics(root: vscode.Uri): Promise<void> {
	const brokenUri = vscode.Uri.joinPath(root, 'broken.py');
	const problems = await waitFor(
		async () => vscode.languages.getDiagnostics(brokenUri),
		(found) => found.length > 0,
		// Short: this waits out its whole budget every run, since the answer is
		// always zero. Long enough to notice the day that changes, no longer.
		3_000
	);
	const opened = vscode.workspace.textDocuments.some((d) => d.uri.path.endsWith('/broken.py'));
	record('NOTE: diagnostics for a never-opened file', true,
		`${problems?.length ?? 0} problem(s) for broken.py (opened in an editor: ${opened}). ` +
		'Zero is expected: Problems covers open files only, while the check below covers open ones.');
}

/**
 * What a user gets from opening a file, via VS Code's own providers. Everything
 * else drives LSP directly, which can pass while the editor experience is broken.
 */
async function checkEditorExperience(root: vscode.Uri, activateStarted: number): Promise<void> {
	const { uri, platform, dot } = await openBench(root);

	const hoverText = await waitFor(() => editorHover(uri, platform), (result) => Boolean(result));
	record('editor: hover works on an opened file', Boolean(hoverText),
		`vscode.executeHoverProvider on sys.platform: ${oneLine(hoverText)}`);

	const completions = await waitFor(
		() => vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', uri, dot
		),
		(result) => Boolean(result?.items?.length)
	);
	record('editor: completion works on an opened file', Boolean(completions?.items?.length),
		`${completions?.items?.length ?? 0} items after "sys."`);

	// Cold start as a user experiences it: activation through to the first
	// completion an editor actually shows.
	record('NOTE: cold start', true,
		`${Date.now() - activateStarted} ms from activate() to the first editor completion`);
}

/**
 * Poll until `accept` is satisfied, since analysis starts asynchronously.
 * Callers pass a predicate because providers answer early with empty results.
 */
async function waitFor<T>(
	fn: () => Thenable<T>,
	accept: (value: T) => boolean,
	timeoutMs = 20_000
): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		last = await fn();
		if (accept(last)) return last;
		await delay(500);
	}
	return last;
}

async function seed(client: any, uri: string, text: string): Promise<void> {
	await client.sendNotification('pyright/createFile', { uri, kind: 'create' });
	await client.sendNotification('textDocument/didOpen', {
		textDocument: { uri, languageId: 'python', version: 1, text },
	});
}

/**
 * Hover the last occurrence of `symbol`, retrying while the server settles.
 *
 * `accept` matters: mid-analysis pyright answers with a real hover whose types
 * are still `Unknown`, so waiting only for *some* response makes the result
 * depend on how long the preceding checks happened to take. Callers that expect
 * a particular type pass a predicate and get a deterministic answer.
 */
async function hover(
	client: any,
	uri: string,
	source: string,
	symbol: string,
	accept: (text: string) => boolean = () => true
): Promise<string | undefined> {
	const position = lastOccurrence(source, symbol);
	if (!position) throw new Error(`"${symbol}" not found in probe source`);

	const deadline = Date.now() + 20_000;
	let last: string | undefined;
	while (Date.now() < deadline) {
		const result = await client.sendRequest('textDocument/hover', { textDocument: { uri }, position });
		const value = result?.contents?.value ?? result?.contents;
		last = typeof value === 'string' ? value.trim() : undefined;
		if (last && accept(last)) return last;
		await delay(400);
	}
	return last;
}


/**
 * Position of the last standalone `symbol` in `source`.
 *
 * Whole-word matching is required, not a convenience: `probe` occurs inside
 * `mod_probe` on an earlier line, and matching that would hover the wrong token
 * and report a confident, wrong answer.
 */
function lastOccurrence(source: string, symbol: string): { line: number; character: number } | undefined {
	const lines = source.split('\n');
	for (let line = lines.length - 1; line >= 0; line--) {
		const pattern = new RegExp(`\\b${symbol}\\b`, 'g');
		let character = -1;
		for (let m = pattern.exec(lines[line]); m; m = pattern.exec(lines[line])) character = m.index;
		if (character >= 0) return { line, character };
	}
	return undefined;
}

/**
 * Logging, which is only observable here: the mirror needs a real output channel
 * and the level has to survive a running session.
 *
 * Hover is the traffic generator. It is one LSP round trip on demand, where the
 * alternative, waiting for the 30 s heartbeat, would add a minute to the run.
 */
async function checkLogging(root: vscode.Uri): Promise<void> {
	const config = vscode.workspace.getConfiguration('micropython-lsp');
	const { uri, platform } = await openBench(root);

	// `Params:` blocks are Verbose, and they carry whole file contents. Nothing
	// may reach that level: `trace` derives `messages`, and the client id keeps a
	// hand-written `micropython-lsp.trace.server` out of the decision.
	const bodies = mirrored.filter((line) => line.includes('Params:'));
	record('logging: the trace never reaches verbose', bodies.length === 0,
		`${mirrored.length} mirrored line(s), ${bodies.length} carrying message bodies`);

	const engine = mirrored.filter((line) => ENGINE_BOOT_LINES.test(line));
	const ours = mirrored.filter((line) => line.includes('starting pyright worker') || line.includes('mirror: seeded'));
	record('logging: the console mirror carries both sides', engine.length > 0 && ours.length > 0,
		`${engine.length} engine line(s) and ${ours.length} of ours, from ${consoleCalls} console call(s)`);

	// Both directions are polled rather than slept on. A configuration change
	// reaches our listener whenever it reaches it, and a fixed wait would either
	// be slower than it needs to be or fail on a loaded runner.
	await config.update('logLevel', 'error', vscode.ConfigurationTarget.Global);
	const quiet = await waitFor(() => hoverAndCountTrace(uri, platform), (count) => count === 0);
	record('logging: lowering logLevel silences the trace', quiet === 0,
		`a hover at logLevel=error produced ${quiet} trace line(s)`);

	await config.update('logLevel', 'trace', vscode.ConfigurationTarget.Global);
	const loud = await waitFor(() => hoverAndCountTrace(uri, platform), (count) => count > 0);
	record('logging: raising it turns the trace back on', (loud ?? 0) > 0,
		`a hover at logLevel=trace produced ${loud} trace line(s)`);
}

/** One hover, and how much protocol trace it mirrored. */
async function hoverAndCountTrace(uri: vscode.Uri, position: vscode.Position): Promise<number> {
	const mark = mirrored.length;
	await editorHover(uri, position);
	await delay(250); // the trace is written as the response is handled, not before
	return tracedSince(mark).length;
}

/** Open the bench in an editor and locate block 1, which two checks both probe. */
async function openBench(root: vscode.Uri) {
	const uri = vscode.Uri.joinPath(root, 'main.py');
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc);

	const line = doc.getText().split('\n').findIndex((l) => l.includes('print(sys.platform)'));
	assert(line >= 0, 'test/workspace/main.py no longer contains print(sys.platform)');
	const text = doc.lineAt(line).text;

	return {
		uri,
		platform: new vscode.Position(line, text.indexOf('platform')),
		dot: new vscode.Position(line, text.indexOf('.') + 1),
	};
}

/** Locate block 2's `greet`, the symbol that only resolves through the mirror. */
async function openBenchImport(root: vscode.Uri) {
	const uri = vscode.Uri.joinPath(root, 'main.py');
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc);

	const line = doc.getText().split('\n').findIndex((l) => l.includes('print(greet('));
	assert(line >= 0, 'test/workspace/main.py no longer contains print(greet(');
	return { uri, greet: new vscode.Position(line, doc.lineAt(line).text.indexOf('greet')) };
}

/** Hover through VS Code's own provider stack, flattened to text. */
async function editorHover(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
	const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
		'vscode.executeHoverProvider', uri, position
	);
	return hovers
		?.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value)))
		.join(' ')
		.trim();
}

const describeWorker = (handle: any) =>
	handle ? `<worker backgroundCount=${handle.backgroundCount}>` : '<none>';

const oneLine = (text: string | undefined) =>
	text ? text.replace(/\s+/g, ' ').replace(/```python|```/g, '').trim().slice(0, 100) : '<no hover>';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fail loudly instead of hanging when the server never answers. */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		work,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
	]);
}

function summarise(): void {
	console.log('\n[gate] ==== summary ====');
	for (const { name, ok, detail } of results) {
		console.log(`[gate] ${ok ? 'PASS' : 'FAIL'}  ${name}`);
		console.log(`[gate]       ${detail}`);
	}
	const fatal = results.filter((r) => !r.ok);
	if (fatal.length) throw new Error(`gate failed: ${fatal.map((r) => r.name).join('; ')}`);
	console.log('[gate] GATE PASSED');
}
