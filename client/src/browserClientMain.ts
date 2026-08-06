import { ExtensionContext, Uri, WorkspaceFolder, workspace } from 'vscode';
import { LanguageClientOptions } from 'vscode-languageclient';
import { LanguageClient } from 'vscode-languageclient/browser';

import { debug, initLogging, log, traceChannel } from './log';
import { PyrightWorker, startPyrightWorker } from './worker';

let client: LanguageClient | undefined;
let pyright: PyrightWorker | undefined;

export async function activate(context: ExtensionContext) {
	const outputChannel = initLogging();
	const workerUrl = Uri.joinPath(context.extensionUri, 'assets/pyright.worker.js').toString(true);
	log(`starting pyright worker from ${workerUrl}`);
	pyright = startPyrightWorker(workerUrl, debug);

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'python' }],
		outputChannel,
		traceOutputChannel: traceChannel(),
		workspaceFolder: serverWorkspaceFolder(),
		// Sent even when empty: the server destructures `files` unguarded, and
		// only applies its embedded typeshed when it is an object. Device stubs
		// go here once they are bundled.
		initializationOptions: { files: {} },
	};

	client = new LanguageClient('micropython-lsp', 'MicroPython LSP', clientOptions, pyright.worker);
	try {
		await client.start();
	} catch (error) {
		await stopEverything(); // or the workers outlive the failed activation
		throw error;
	}
	log('language client started');

	// Test seam, not a public API.
	return { client, pyright };
}

export async function deactivate(): Promise<void> {
	await stopEverything();
}

/** Never throws, so a client that fails to stop cannot strand its workers. */
async function stopEverything(): Promise<void> {
	try {
		await client?.stop();
	} catch (error) {
		log(`stopping the language client failed: ${String(error)}`);
	} finally {
		client = undefined;
		pyright?.dispose();
		pyright = undefined;
	}
}

/**
 * The root reported to the server, which must be a `file:` URI.
 *
 * Pyright's browser build is backed by an in-memory filesystem keyed on plain
 * POSIX paths. Under any other scheme it reports non-existent files as existing
 * and nothing resolves, `builtins` included.
 *
 * So the rule is by scheme, not by host application: `file:` passes straight
 * through, and anything else (`vscode-vfs:` on vscode.dev, a virtual provider
 * registered by an embedding app) gets a synthetic root for the mirror to
 * translate onto.
 */
function serverWorkspaceFolder(): WorkspaceFolder {
	const folder = workspace.workspaceFolders?.[0];
	if (folder?.uri.scheme === 'file') return folder;
	return { uri: Uri.parse('file:///'), name: 'micropython-lsp', index: 0 };
}
