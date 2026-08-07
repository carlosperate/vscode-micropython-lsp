import { ExtensionContext, Uri } from 'vscode';

import { initLogging } from './log';
import { AnalysisSession } from './session';

let session: AnalysisSession | undefined;

export async function activate(context: ExtensionContext) {
	const outputChannel = initLogging();
	const workerUrl = Uri.joinPath(context.extensionUri, 'assets/pyright.worker.js').toString(true);

	session = new AnalysisSession(workerUrl, outputChannel);
	await session.start();

	// Test seam, not a public API. Getters, because a restart replaces both.
	return {
		get client() {
			return session?.languageClient;
		},
		get pyright() {
			return session?.pyright;
		},
		checkHealth: () => session?.checkHealth() ?? Promise.resolve(false),
	};
}

export async function deactivate(): Promise<void> {
	await session?.stop();
	session = undefined;
}
