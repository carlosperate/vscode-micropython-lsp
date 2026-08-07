import * as vscode from 'vscode';
// Via the language client, not `vscode-jsonrpc` directly: it re-exports the same
// module, so the probe cannot drift onto a different protocol version than the
// client stack, and nothing new has to be declared to import it.
import { BrowserMessageReader, BrowserMessageWriter, createMessageConnection } from 'vscode-languageclient/browser';

import { SERVER_ROOT } from '../../client/src/uri-map';
import { startPyrightWorker } from '../../client/src/worker';
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

const MOD_PROBE_SOURCE = 'def probe() -> str: ...\n';

/** Hover predicate: the seeded module's real signature, not a mid-analysis `Unknown`. */
const resolvesToStr = (text: string) => /->\s*str/.test(text);

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

	// Before activate: the client reads the trace level during start().
	// Global, not Workspace: the harness mounts the workspace read-only, so a
	// workspace-scoped write cannot land.
	const config = vscode.workspace.getConfiguration('micropython-lsp');
	await config.update('debug', true, vscode.ConfigurationTarget.Global);
	await config.update('trace.server', 'verbose', vscode.ConfigurationTarget.Global);
	await vscode.workspace
		.getConfiguration('basedpyright.analysis')
		.update('logLevel', 'trace', vscode.ConfigurationTarget.Global);

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
	const workspaceBase = root.toString(true).replace(/\/$/, '');
	console.log(`[gate] workspace root: ${workspaceBase}`);

	// First, before anything is seeded: this is the state a user is actually in
	// when they open a file in a fresh session.
	await checkEditorExperience(root, activateStarted);
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
	const base = `${SERVER_ROOT}/gate`;

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

	// Before crash recovery, which leaves a different client behind. Uses its own
	// throwaway workers, so it does not disturb the session above.
	await checkTypeshedBypass(ext);

	// Last: it replaces the client and worker that everything above holds.
	await checkCrashRecovery(api, root);
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
	const uri = `${SERVER_ROOT}/gate/perf.py`;
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
	const workerUrl = vscode.Uri.joinPath(ext.extensionUri, 'assets/pyright.worker.js').toString(true);
	const root = '/mp-typeshed';
	const files = replacementTypeshed(root);

	// A: typeshedPaths, the channel the contributed setting feeds.
	await recordBypassCase('A: typeshedPaths configuration', workerUrl, files, {
		typeshedPaths: [`file://${root}`],
		logLevel: 'trace',
	});

	// B: a seeded pyrightconfig.json, with the configuration pointing back at the
	// embedded root so anything that works is the config file's doing.
	await recordBypassCase(
		'B: seeded pyrightconfig.json',
		workerUrl,
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
	workerUrl: string,
	files: Record<string, string>,
	analysisConfig: Record<string, unknown>
): Promise<void> {
	try {
		recordBypass(mechanism, await probeBypass(workerUrl, files, analysisConfig));
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
	workerUrl: string,
	files: Record<string, string>,
	analysisConfig: Record<string, unknown>
): Promise<BypassResult> {
	const workers = startPyrightWorker(workerUrl, (m) => console.log(`[gate:bypass] ${m}`));
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
	// Only the language server can type `platform` as `LiteralString`.
	const recovered = await waitFor(
		() => editorHover(uri, platform),
		(text) => /LiteralString/.test(text ?? ''),
		60_000
	);
	record('the server recovers without a window reload', /LiteralString/.test(recovered ?? ''),
		`hover on sys.platform after the crash: ${oneLine(recovered)}`);
	const after = api.pyright;
	record('the replacement is a new worker', after !== undefined && after !== before,
		`before=${describeWorker(before)} after=${describeWorker(after)}`);
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
	await seed(client, `${SERVER_ROOT}/gate_lib.py`, await read('helper.py'));

	const probeSource = 'from gate_lib import greet\n\ncheck_seeded = greet\n';
	await seed(client, `${SERVER_ROOT}/gate_probe.py`, probeSource);

	const text = await hover(client, `${SERVER_ROOT}/gate_probe.py`, probeSource, 'greet', (t) => /name:\s*str/.test(t));
	record('workspace file: closed sibling module resolves',
		Boolean(text && /name:\s*str/.test(text) && /->\s*str/.test(text)),
		`helper.py never opened in an editor. hover: ${oneLine(text)}`);

	// Opening the real file in an editor makes VS Code sync it under its own
	// scheme. `uriConverters` rewrite it onto the server root, so the server has
	// one identity for the file rather than an editor copy and a mirrored copy.
	await vscode.window.showTextDocument(
		await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'main.py'))
	);
	const mapped = `${SERVER_ROOT}/main.py`;
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

	await vscode.window.showTextDocument(doc);
	await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	await waitFor(
		async () => vscode.workspace.textDocuments.some((d) => d.uri.path.endsWith('/helper.py')),
		(open) => !open
	);

	const afterClose = await waitFor(() => editorHover(mainUri, greet), resolves);
	record('round trip: still resolves after the editor closes it', resolves(afterClose),
		`VS Code's didClose drops the server's copy; the mirror must re-seed. hover: ${oneLine(afterClose)}`);
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
		const text = await hover(client, `${SERVER_ROOT}/gate_created.py`, source, 'spark', (t) => /int/.test(t));
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
		await seed(client, `${SERVER_ROOT}/gate_probe_open.py`, probe);
		const text = await hover(client, `${SERVER_ROOT}/gate_probe_open.py`, probe, 'spark', (t) => /int/.test(t));
		record('a file open in an editor is importable by others', Boolean(text && /int/.test(text)),
			`gate_open.py open in an editor, hover on the imported spark: ${oneLine(text)}`);
	} finally {
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		await vscode.workspace.fs.delete(created).then(undefined, () => {});
	}
}

/**
 * Squiggles in an open file. `main.py` block 3 passes an `int` where a `str` is
 * wanted, so a working pull answers with at least one problem.
 *
 * Recorded, not asserted, because it currently answers zero for a reason that is
 * inside the engine rather than in this extension: the server never replies to
 * `textDocument/diagnostic` at all. Asserting would paint the whole gate red
 * over something we cannot fix here, while a `NOTE:` row still shows the day it
 * starts working.
 */
async function checkOpenFileDiagnostics(root: vscode.Uri): Promise<void> {
	const mainUri = vscode.Uri.joinPath(root, 'main.py');
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainUri));

	const problems = await waitFor(
		async () => vscode.languages.getDiagnostics(mainUri),
		(found) => found.length > 0,
		3_000
	);
	record('NOTE: diagnostics for an OPEN file', true,
		`${problems?.length ?? 0} problem(s) in main.py, expected at least 1 (block 3 passes int for str). ` +
		'Zero means the pull went unanswered: no squiggles anywhere, for any file.');
}

/**
 * The pull-model question, recorded rather than asserted because the answer is
 * what decides the scope we can promise. `broken.py` is mirrored and never
 * opened, and carries a type error the server certainly knows about.
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
		'Zero means VS Code only pulls for documents it knows, so Problems covers open files only.');
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
