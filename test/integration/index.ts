import * as vscode from 'vscode';

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

	const api = await ext.activate();
	assert(ext.isActive, `${EXTENSION_ID} failed to activate`);
	const client = api?.client;
	assert(client, 'activate() did not return the language client');
	record('extension activates and the language client starts', true,
		'foreground worker booted and the LSP handshake completed');

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
	await checkEditorExperience(root);

	// Everything is mirrored onto `file:///`, which is what the extension reports
	// as the server's root, and therefore what the workspace mirror will use.
	// Other schemes may also happen to work, but asserting on that mostly measures
	// pyright's import caching rather than anything we control.
	const base = 'file:///gate';

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
	summarise();
}

/**
 * The mirror mechanism against real workspace files, done the way the real
 * mirror must do it: onto `file:///` URIs.
 *
 * `pyright/createFile` keys the VFS on `Uri.getPath()` while `didOpen` keys on
 * the whole URI, so under any non-`file:` scheme the two disagree and the module
 * resolves empty. Mirroring onto `file:///` makes path and URI the same thing.
 */
async function checkWorkspaceFile(client: any, root: vscode.Uri): Promise<void> {
	const read = async (name: string) =>
		new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name)));

	const helperText = await read('helper.py');
	const mainText = await read('main.py');

	// Mirrored but never opened in an editor, which is the whole point.
	await seed(client, 'file:///ws/helper.py', helperText);
	await seed(client, 'file:///ws/main.py', mainText);

	const text = await hover(client, 'file:///ws/main.py', mainText, 'greet', (t) => /name:\s*str/.test(t));
	record('workspace file: closed sibling module resolves',
		Boolean(text && /name:\s*str/.test(text) && /->\s*str/.test(text)),
		`helper.py never opened in an editor. hover: ${oneLine(text)}`);

	// Opening the real file in an editor makes VS Code sync it under its own
	// scheme, which pyright treats as a *different* file from the mirrored copy.
	// Recorded, not asserted: reconciling this is the mirror's problem to solve.
	await vscode.window.showTextDocument(
		await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'main.py'))
	);
	const viaEditor = await hover(client, vscode.Uri.joinPath(root, 'main.py').toString(true), mainText, 'greet');
	record('NOTE: editor-scheme copy is a separate file to pyright', true,
		`hover via ${root.scheme}: ${oneLine(viaEditor)}; the mirror must rewrite URIs, not just dedupe`);
}

/**
 * What a user gets from opening a file, via VS Code's own providers. Everything
 * else drives LSP directly, which can pass while the editor experience is broken.
 */
async function checkEditorExperience(root: vscode.Uri): Promise<void> {
	const uri = vscode.Uri.joinPath(root, 'main.py');
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc);

	const line = doc.getText().split('\n').findIndex((l) => l.includes('print(sys.platform)'));
	assert(line >= 0, 'test/workspace/main.py no longer contains print(sys.platform)');
	const text = doc.lineAt(line).text;

	const hovers = await waitFor(
		() => vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider', uri, new vscode.Position(line, text.indexOf('platform'))
		),
		(result) => Boolean(result?.length)
	);
	const hoverText = hovers
		?.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value)))
		.join(' ')
		.trim();
	record('editor: hover works on an opened file', Boolean(hoverText),
		`vscode.executeHoverProvider on sys.platform: ${oneLine(hoverText)}`);

	const completions = await waitFor(
		() => vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', uri, new vscode.Position(line, text.indexOf('.') + 1)
		),
		(result) => Boolean(result?.items?.length)
	);
	record('editor: completion works on an opened file', Boolean(completions?.items?.length),
		`${completions?.items?.length ?? 0} items after "sys."`);
}

/**
 * Poll until `accept` is satisfied, since analysis starts asynchronously.
 * Callers pass a predicate because providers answer early with empty results.
 */
async function waitFor<T>(fn: () => Thenable<T>, accept: (value: T) => boolean): Promise<T | undefined> {
	const deadline = Date.now() + 20_000;
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

const oneLine = (text: string | undefined) =>
	text ? text.replace(/\s+/g, ' ').replace(/```python|```/g, '').trim().slice(0, 100) : '<no hover>';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
