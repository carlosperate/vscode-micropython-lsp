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
	/**
	 * Without `text`, only the path: enough for `import` to resolve it, which is
	 * all the mirror may do for a file the editor is syncing.
	 */
	put(uri: string, text?: string): Promise<void>;
	/** The file is genuinely gone. */
	drop(uri: string): Promise<void>;
	/** Hand the content back to VS Code, keeping the path. */
	release(uri: string): Promise<void>;
	/** The server's copy went away without us: the next `put` must open, not patch. */
	forget(uri: string): void;
}

export function createClientSink(client: LanguageClient): MirrorSink {
	/** Paths the server has. `createFile` blanks the entry, so it is sent once. */
	const created = new Set<string>();
	const versions = new Map<string, number>();

	return {
		async put(uri, text) {
			const sends: Promise<void>[] = [];
			if (!created.has(uri)) {
				created.add(uri);
				sends.push(client.sendNotification('pyright/createFile', { uri, kind: 'create' }));
			}

			const version = versions.get(uri);
			if (text !== undefined) {
				versions.set(uri, (version ?? 0) + 1);
				// Queued in the same turn as `createFile`, or the editor's own
				// `didOpen` can land between them and lose to ours.
				sends.push(
					version === undefined
						? client.sendNotification('textDocument/didOpen', {
								textDocument: { uri, languageId: 'python', version: 1, text },
							})
						: client.sendNotification('textDocument/didChange', {
								textDocument: { uri, version: version + 1 },
								contentChanges: [{ text }],
							})
				);
			}

			await Promise.all(sends);
		},

		async drop(uri) {
			if (versions.delete(uri)) {
				await client.sendNotification('textDocument/didClose', { textDocument: { uri } });
			}
			// Only if the server has it: deleting an unknown path answers ENOENT.
			if (created.delete(uri)) {
				await client.sendNotification('pyright/deleteFile', { uri, kind: 'delete' });
			}
		},

		async release(uri) {
			if (!versions.delete(uri)) return;
			await client.sendNotification('textDocument/didClose', { textDocument: { uri } });
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
	/**
	 * Per-URI intent counter. Reads are async, so without it a read that started
	 * before a delete can land after it and resurrect the module, and an older
	 * read can overwrite the content a newer one already published.
	 */
	const revisions = new Map<string, number>();
	let disposed = false;

	/** Supersedes whatever is in flight for this URI. */
	const bump = (uri: Uri): number => {
		const next = (revisions.get(uri.toString()) ?? 0) + 1;
		revisions.set(uri.toString(), next);
		return next;
	};
	const current = (uri: Uri, revision: number) => revisions.get(uri.toString()) === revision;

	const serverUri = (uri: Uri) => uris.toServerUri(uri.toString());

	/** VS Code syncs what it has open, under the same URI, so the mirror stays off it. */
	const editorOwned = (uri: Uri) =>
		workspace.textDocuments.some((doc) => doc.languageId === 'python' && doc.uri.toString() === uri.toString());

	/**
	 * `false` when only the path was sent, which is the case for anything the
	 * editor is syncing: it supplies the content, but a document is not a file,
	 * and `import` resolves against files.
	 */
	const push = async (uri: Uri): Promise<boolean> => {
		const target = serverUri(uri);
		if (disposed || !target) return false;
		const revision = bump(uri);
		try {
			if (editorOwned(uri)) {
				await sink.put(target);
				return false;
			}
			const bytes = await workspace.fs.readFile(uri);
			// Re-checked after the read: if the user opened it meanwhile, disk content
			// landing after the editor's `didOpen` desyncs every later keystroke. And
			// if anything else touched this URI, that intent is the newer one.
			if (disposed || !current(uri, revision)) return false;
			if (editorOwned(uri)) {
				await sink.put(target);
				return false;
			}
			await sink.put(target, new TextDecoder().decode(bytes));
			return true;
		} catch (error) {
			// Routine: a file deleted between the watcher event and this read.
			log(`mirror: skipped ${uri.toString()}: ${String(error)}`);
			return false;
		}
	};

	const cancel = (uri: Uri): void => {
		const key = uri.toString();
		clearTimeout(pending.get(key));
		pending.delete(key);
	};

	const schedule = (uri: Uri): void => {
		const key = uri.toString();
		cancel(uri);
		pending.set(
			key,
			setTimeout(() => {
				pending.delete(key);
				void push(uri);
			}, DEBOUNCE_MS)
		);
	};

	const sourceUri = (uri: Uri) => (/\.pyi?$/.test(uri.path) ? serverUri(uri) : undefined);

	/** Every send that is not `push`: one place to swallow a shutdown race. */
	const hand = async (send: () => Promise<void>, uri: Uri, what: string): Promise<void> => {
		if (disposed) return;
		try {
			await send();
		} catch (error) {
			log(`mirror: could not ${what} ${uri.toString()}: ${String(error)}`);
		}
	};

	const remove = (uri: Uri): Promise<void> => {
		// A read already in flight must not put the file back, and a pending one
		// must not go looking for a file we know has gone.
		bump(uri);
		cancel(uri);
		const target = serverUri(uri);
		return target ? hand(() => sink.drop(target), uri, 'drop') : Promise.resolve();
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
			// The handover out. This listener is registered before the language
			// client's own, so the order on the wire is our `didClose` then VS
			// Code's `didOpen`. The other way round, the server rejects the second
			// open with an error the user sees as a notification.
			workspace.onDidOpenTextDocument((doc) => {
				const target = sourceUri(doc.uri);
				if (target) void hand(() => sink.release(target), doc.uri, 'release');
			}),
			// The handover back. VS Code's own `didClose` drops the server's copy
			// and nothing else puts it back, so a file the user merely looked at
			// would stop resolving for everything that imports it. The debounce is
			// what puts this after the client's `didClose` rather than before it.
			workspace.onDidCloseTextDocument((doc) => {
				const target = sourceUri(doc.uri);
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
