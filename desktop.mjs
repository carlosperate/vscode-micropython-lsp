import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const bench = path.join(here, 'test', 'workspace');
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
 */
const userDataDir = gate
	? fs.mkdtempSync(path.join(os.tmpdir(), 'mplsp-gate-'))
	: path.join(here, '.vscode-test', 'user-data');

seedSettings(userDataDir);

// Alongside the user data, so the gate's is thrown away with it: an extension
// installed during an interactive session must not turn up in a gate run.
const extensionsDir = gate
	? path.join(userDataDir, 'extensions')
	: path.join(here, '.vscode-test', 'extensions');

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
			extensionDevelopmentPath: here,
			extensionTestsPath: path.join(here, 'test', 'integration', 'dist', 'index.js'),
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
		`--extensionDevelopmentPath=${here}`,
		...launchArgs,
		// Activation is onLanguage:python, so the folder on its own starts nothing.
		path.join(bench, 'main.py'),
	];
	spawn(executable, args, { stdio: 'inherit' }).on('exit', (status) => process.exit(status ?? 0));
}
