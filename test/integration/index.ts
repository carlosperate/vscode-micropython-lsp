import * as vscode from 'vscode';

const EXTENSION_ID = 'carlosperate.python-lsp';

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Entry point for `vscode-test-web --extensionTestsPath`. Throwing fails the run. */
export async function run(): Promise<void> {
	const ext = vscode.extensions.getExtension(EXTENSION_ID);
	check(ext, `${EXTENSION_ID} was not loaded by the extension host`);

	await ext.activate();
	check(ext.isActive, `${EXTENSION_ID} failed to activate`);

	// Round-trips the language server: opening a plaintext document triggers
	// activation, the client spawns the worker, and the colour provider answers.
	const doc = await vscode.workspace.openTextDocument({
		language: 'plaintext',
		content: 'a colour: #e244ff\n',
	});
	await vscode.window.showTextDocument(doc);

	const colours = await waitFor(async () => {
		const result = await vscode.commands.executeCommand<vscode.ColorInformation[]>(
			'vscode.executeDocumentColorProvider',
			doc.uri
		);
		return result?.length ? result : undefined;
	}, 20_000);

	check(colours, 'no colour information came back — the language server never answered');
	check(colours.length === 1, `expected 1 colour, got ${colours.length}`);
	console.log(`[integration] ${EXTENSION_ID} active, language server answered with 1 colour`);
}

/** Poll until `fn` returns a value, since the server starts asynchronously. */
async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value !== undefined) return value;
		await new Promise((r) => setTimeout(r, 250));
	}
	return undefined;
}
