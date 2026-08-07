import { Disposable, RelativePattern, Uri, workspace, WorkspaceFolder } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/browser';

import { scanWorkspace } from './scan';
import type { UriMap } from './uri-map';

/**
 * The server has no filesystem: it only knows the files it is told about.
 *
 * `pyright/createFile` makes a path resolvable but carries no content, and the
 * only content channel is open-document sync. So every workspace file the user
 * has not opened is kept permanently "open" from the server's point of view,
 * and the editor keeps ownership of everything it does have open.
 */

/** Coalesces the burst of events one save, or one git operation, produces. */
const DEBOUNCE_MS = 150;

/**
 * Where mirrored content goes.
 *
 * The destination is the one thing that would change under a different engine,
 * so it lives behind these three verbs and nothing above this line knows how a
 * file reaches the server.
 */
export interface MirrorSink {
	put(uri: string, text: string): Promise<void>;
	/** The file is genuinely gone. The only time a mirrored file is closed. */
	drop(uri: string): Promise<void>;
	/** The server's copy went away without us: the next `put` must open, not patch. */
	forget(uri: string): void;
}

export function createClientSink(client: LanguageClient): MirrorSink {
	const versions = new Map<string, number>();

	return {
		async put(uri, text) {
			const version = versions.get(uri);
			if (version === undefined) {
				versions.set(uri, 1);
				// `createFile` blanks the VFS entry, so it belongs on this branch only.
				// Both queued in one turn, or the editor's own `didOpen` can land
				// between them and lose to ours.
				await Promise.all([
					client.sendNotification('pyright/createFile', { uri, kind: 'create' }),
					client.sendNotification('textDocument/didOpen', {
						textDocument: { uri, languageId: 'python', version: 1, text },
					}),
				]);
				return;
			}
			versions.set(uri, version + 1);
			await client.sendNotification('textDocument/didChange', {
				textDocument: { uri, version: version + 1 },
				contentChanges: [{ text }],
			});
		},

		async drop(uri) {
			if (versions.delete(uri)) {
				await client.sendNotification('textDocument/didClose', { textDocument: { uri } });
			}
			await client.sendNotification('pyright/deleteFile', { uri, kind: 'delete' });
		},

		forget(uri) {
			versions.delete(uri);
		},
	};
}

export interface Mirror extends Disposable {
	/** Walk the workspace and push everything the editor is not already syncing. */
	seed(): Promise<void>;
}

export function createMirror(options: {
	sink: MirrorSink;
	uris: UriMap;
	folder: WorkspaceFolder | undefined;
	log: (message: string) => void;
}): Mirror {
	const { sink, uris, folder, log } = options;
	const subscriptions: Disposable[] = [];
	const pending = new Map<string, ReturnType<typeof setTimeout>>();
	let disposed = false;

	const serverUri = (uri: Uri) => uris.toServerUri(uri.toString());

	/** VS Code syncs what it has open, under the same URI, so the mirror stays off it. */
	const editorOwned = (uri: Uri) =>
		workspace.textDocuments.some((doc) => doc.languageId === 'python' && doc.uri.toString() === uri.toString());

	/** `false` when the file was left to the editor, or could not be read. */
	const push = async (uri: Uri): Promise<boolean> => {
		const target = serverUri(uri);
		if (disposed || !target || editorOwned(uri)) return false;
		try {
			const bytes = await workspace.fs.readFile(uri);
			// Re-checked after the read: if the user opened it meanwhile, disk content
			// landing after the editor's `didOpen` desyncs every later keystroke.
			if (disposed || editorOwned(uri)) return false;
			await sink.put(target, new TextDecoder().decode(bytes));
			return true;
		} catch (error) {
			log(`mirror: could not mirror ${uri.toString()}: ${String(error)}`);
			return false;
		}
	};

	const schedule = (uri: Uri): void => {
		const key = uri.toString();
		clearTimeout(pending.get(key));
		pending.set(
			key,
			setTimeout(() => {
				pending.delete(key);
				void push(uri);
			}, DEBOUNCE_MS)
		);
	};

	const remove = async (uri: Uri): Promise<void> => {
		const target = serverUri(uri);
		if (disposed || !target) return;
		try {
			await sink.drop(target);
		} catch (error) {
			// Or a delete during shutdown is an unhandled rejection.
			log(`mirror: could not drop ${uri.toString()}: ${String(error)}`);
		}
	};

	if (folder) {
		const watcher = workspace.createFileSystemWatcher(new RelativePattern(folder, '**/*.{py,pyi}'));
		subscriptions.push(
			watcher,
			// Providers disagree on whether a new file arrives as Created or as
			// Changed, and both mean the same thing here.
			watcher.onDidCreate(schedule),
			watcher.onDidChange(schedule),
			watcher.onDidDelete((uri) => void remove(uri)),
			// Closing an editor makes VS Code send its own `didClose`, which drops
			// the server's copy. Nothing else puts it back, so a file the user
			// merely looked at would stop resolving for everything that imports it.
			workspace.onDidCloseTextDocument((doc) => {
				const target = /\.pyi?$/.test(doc.uri.path) ? serverUri(doc.uri) : undefined;
				if (!target) return;
				sink.forget(target);
				schedule(doc.uri);
			})
		);
	}

	return {
		async seed(): Promise<void> {
			if (!folder) return;

			const scan = await scanWorkspace(async (relative) =>
				workspace.fs.readDirectory(relative ? Uri.joinPath(folder.uri, ...relative.split('/')) : folder.uri)
			);
			for (const dir of scan.unreadable) log(`mirror: could not read directory "${dir || '.'}"`);

			let seeded = 0;
			for (const file of scan.files) {
				if (disposed) return;
				if (await push(Uri.joinPath(folder.uri, ...file.split('/')))) seeded++;
			}
			// Both numbers: the gap is what the editor already owns, which is the
			// first thing to check when a module unexpectedly does not resolve.
			log(`mirror: seeded ${seeded} of ${scan.files.length} file(s) from ${folder.uri.scheme}:`);
		},

		dispose(): void {
			disposed = true;
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
			for (const subscription of subscriptions) subscription.dispose();
			subscriptions.length = 0;
		},
	};
}
