/**
 * Desktop VS Code with this extension loaded from source. Two modes:
 *
 * - no arguments, `npm run desktop`: open the bench interactively, the
 *   counterpart of `npm run chrome`.
 * - `--gate`, `npm run test:integration:desktop`: run the integration gate,
 *   the same bundle `npm run test:integration` runs under VS Code Web.
 *
 * Both run a VS Code downloaded into `.vscode-test/`, with an extensions directory
 * of its own, so a run is isolated from the machine's own install: no settings of
 * the developer's are read, and a second Python language server they happen to have
 * installed is not in the way. The profile differs by mode, see below.
 *
 * `--extensionDevelopmentKind=web` is deliberately not passed. With no `main`
 * entry the manifest already puts this in the LocalWebWorker host, so leaving the
 * flag off tests what a real desktop install gets rather than forcing the host we
 * expect. `.vscode/launch.json` does pass it, because `debugWebWorkerHost` needs
 * the host named to attach to it.
 */
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This script lives in config/, but every path below (the bench, .vscode-test/,
// extensionDevelopmentPath) is repo-root-relative: that's where package.json,
// client/dist and test/ actually are, so `root` steps back up out of config/.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const bench = path.join(root, 'test', 'workspace');
const gate = process.argv.includes('--gate');

/**
 * The Copilot sign-in modal is not covered by `--disable-extensions`: it comes
 * from `GitHub.copilot-chat`, which ships as a builtin, and builtins stay enabled.
 * A setting is the only thing that stops it.
 *
 * Never overwrites, because this is also the file the Settings UI writes to in the
 * interactive profile, and a run should not undo the level a session raised.
 */
function seedSettings(dir) {
	const settings = path.join(dir, 'User', 'settings.json');
	if (fs.existsSync(settings)) return;
	fs.mkdirSync(path.dirname(settings), { recursive: true });
	fs.writeFileSync(settings, `${JSON.stringify({ 'chat.disableAIFeatures': true }, null, '\t')}\n`);
}

/** The limit is on the socket path, so it is the socket that gets measured. */
const SOCKET_LIMIT = 103;

/**
 * Whether VS Code could open its socket inside this directory. The real name
 * carries the running version (`1.133-main.sock`), unknown before launch, so
 * this measures a generous stand-in rather than guessing it exactly.
 *
 * Bytes, not characters: the limit is on `sun_path`, so an accented or CJK
 * folder in the path counts for more than its length.
 */
const fits = (dir) => Buffer.byteLength(path.join(dir, '1.9999-main.sock')) <= SOCKET_LIMIT;

/** Where a profile goes when it does not fit, and why it had to move. */
const tooDeep = (dir) =>
	new Error(`no room for a VS Code profile: ${dir} exceeds the ${SOCKET_LIMIT}-character socket limit. ` +
		'Set TMPDIR to something shorter.');

/**
 * The two modes must not share a profile, and it leaks both ways.
 *
 * The gate writes user settings of its own (`logLevel`, `mirrorLogsToConsole`) and
 * toggles `micropython-lsp.enable` off and on. A shared profile therefore leaves
 * `trace` on for every later interactive session, and a gate run that dies
 * mid-toggle leaves `enable: false` behind and fails the *next* run before it
 * starts. Restored editors travel the same way: an interactive session that left
 * `helper.py` open would silently invalidate the closed-module check.
 *
 * So the gate gets a throwaway profile, and only the interactive run keeps a
 * persistent one, which is what lets a raised log level survive until it is lowered.
 *
 * The throwaway one goes in the system temp dir and keeps a short prefix on purpose:
 * VS Code opens a socket at `<user-data-dir>/1.xx-main.sock` against a
 * 103-character platform limit, and a long path fails with an opaque `listen EINVAL`.
 * Measured here too: a deeply nested `TMPDIR`, which some CI images have, crosses
 * that limit on its own and would fail the gate with nothing explaining why.
 */
const userDataDir = gate ? gateProfile() : interactiveProfile();

function gateProfile() {
	const throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'mplsp-gate-'));
	if (!fits(throwaway)) throw tooDeep(throwaway);
	return throwaway;
}

/**
 * The interactive profile, beside the downloaded VS Code until the checkout is
 * too deep for that to work.
 *
 * This path is not ours to keep short: it is wherever the user cloned to, plus
 * `.vscode-test/user-data`, plus a name VS Code chooses. One folder deeper than
 * the author's crosses the limit, and the failure is `listen EINVAL` on a path
 * nobody wrote, with no window ever appearing.
 *
 * So it is measured, and a profile that would not fit moves to the temp
 * directory under a name derived from the checkout, so two clones keep their own
 * settings. Announced, because a profile that silently moved is a setting that
 * silently disappeared.
 */
function interactiveProfile() {
	const beside = path.join(root, '.vscode-test', 'user-data');
	if (fits(beside)) return beside;

	// Eight hex characters of the checkout path: enough that two clones on one
	// machine do not share a profile, short enough to stay inside the limit.
	const key = createHash('sha256').update(root).digest('hex').slice(0, 8);
	const elsewhere = path.join(os.tmpdir(), `mplsp-${key}`);
	if (!fits(elsewhere)) throw tooDeep(elsewhere);
	console.log(`[desktop] ${root} is too deep for a profile beside it, so this session keeps its settings in ${elsewhere}`);
	return elsewhere;
}

seedSettings(userDataDir);

// Alongside the user data, so the gate's is thrown away with it: an extension
// installed during an interactive session must not turn up in a gate run.
const extensionsDir = gate
	? path.join(userDataDir, 'extensions')
	: path.join(root, '.vscode-test', 'extensions');

const launchArgs = [
	`--user-data-dir=${userDataDir}`,
	`--extensions-dir=${extensionsDir}`,
	'--skip-welcome',
	'--skip-release-notes',
	'--disable-workspace-trust',
	bench,
];

if (gate) {
	// The gate's own bundle, unchanged. It is built for the browser and that is
	// correct here too: for an extension with no `main`, a script loaded through
	// `--extensionTestsPath` runs in the **web worker** extension host, with DOM
	// `Worker` and `importScripts` and no `process`. So one bundle serves both hosts.
	try {
		await runTests({
			extensionDevelopmentPath: root,
			extensionTestsPath: path.join(root, 'test', 'integration', 'dist', 'index.js'),
			launchArgs,
		});
	} catch (error) {
		// The gate reports its own failures line by line, so a stack trace on top of
		// them only buries the part worth reading.
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		fs.rmSync(userDataDir, { recursive: true, force: true });
	}
} else {
	const executable = await downloadAndUnzipVSCode();
	const args = [
		// Absolute: VS Code resolves a relative path here against its own cwd, not
		// the shell's, and then quietly opens a window with no extension in it.
		`--extensionDevelopmentPath=${root}`,
		...launchArgs,
		// Activation is onLanguage:python, so the folder on its own starts nothing.
		path.join(bench, 'main.py'),
	];
	spawn(executable, args, { stdio: 'inherit' }).on('exit', (status) => process.exit(status ?? 0));
}
