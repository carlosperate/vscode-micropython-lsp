import { commands, Disposable, OutputChannel, Uri, window, workspace, WorkspaceFolder } from 'vscode';
import { CloseAction, ErrorAction, ErrorHandler, LanguageClientOptions, Trace } from 'vscode-languageclient';
import { LanguageClient } from 'vscode-languageclient/browser';

import { PRODUCT, readLogLevel, readTarget } from './config';
import { createClientSink, createMirror, type Mirror } from './fs-bridge';
import { Heartbeat, startHeartbeat } from './heartbeat';
import { logger } from './log';
import { traceValueFor } from './log-level';
import { ping } from './ping';
import { DEFAULT_RESTART_POLICY, decideRestart, RestartPolicy } from './restart-policy';
import { serverSettings, SERVER_TYPESHED } from './settings';
import { loadTarget, type ReadStub, type Seed, TARGET_TYPESHED_URI } from './target';
import { createUriMap, SERVER_ROOT, type UriMap } from './uri-map';
import { type EngineUrls, PyrightWorker, startPyrightWorker } from './worker';

/**
 * A dead server never answers `shutdown`, and dead is what this path mostly
 * stops. Hitting the timeout is cheap (the browser build holds nothing worth
 * flushing, so an unclean stop costs one log line), while the default 2s would
 * be added to every restart.
 */
const STOP_TIMEOUT_MS = 1_000;

/**
 * Deliberately not `micropython-lsp`, and the only thing this id is used for.
 *
 * The language client's sole use of its id is `getConfiguration(id)` in
 * `refreshTrace`, where it reads `<id>.trace.server` and applies it. Naming it
 * after our settings section would let a value saved under
 * `micropython-lsp.trace.server` set the trace level during startup, before
 * `followTraceLevel` can derive the real one from `logLevel`. Pointing it at a
 * section nobody contributes makes that read always answer `off`, so the level
 * has exactly one source.
 */
const CLIENT_ID = 'micropython-lsp-server';

/**
 * The language server as one replaceable unit: worker, client and liveness probe.
 *
 * A restart must build a new worker *and* a new client.
 * `LanguageClient.createMessageTransports` rebuilds its reader and writer over
 * the same `Worker` it was constructed with, so `CloseAction.Restart` would
 * reconnect to the worker that just died, which is why the error handler here
 * always answers `DoNotRestart`.
 */
export class AnalysisSession {
	private client: LanguageClient | undefined;
	private workers: PyrightWorker | undefined;
	private heartbeat: Heartbeat | undefined;
	private mirror: Mirror | undefined;
	private folders: Disposable | undefined;
	private traceListener: Disposable | undefined;
	/** The root the live session was built for, to spot a change that matters. */
	private root: string | undefined;
	/** The `micropython-lsp.target` this session was built for, same purpose. */
	private target: string | undefined;
	private restarts: number[] = [];
	private gaveUp = false;
	private disposed = false;
	private warnedMultiRoot = false;
	/** Serialises start, stop and restart, which can otherwise interleave. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly urls: EngineUrls,
		private readonly outputChannel: OutputChannel,
		private readonly readStub: ReadStub,
		private readonly policy: RestartPolicy = DEFAULT_RESTART_POLICY
	) {}

	/** The live client. A restart replaces it, so read it, never cache it. */
	get languageClient(): LanguageClient | undefined {
		return this.client;
	}

	/** The live workers. Replaced by a restart, same as the client. */
	get pyright(): PyrightWorker | undefined {
		return this.workers;
	}

	/** The target this session loaded, so a caller can tell a real change from a no-op. */
	get loadedTarget(): string | undefined {
		return this.target;
	}

	start(): Promise<void> {
		// A root change is *Switch Workspace Storage* in the host app: the map, the
		// reported folder and every mirrored URI are all derived from the root, so
		// the only honest response is to rebuild against the new one.
		this.folders ??= workspace.onDidChangeWorkspaceFolders(() => {
			const root = this.workspaceRoot();
			// `rebind` logs the change; this covers the silent case, a folder added
			// or removed behind the one we analyse.
			if (root === this.root) {
				logger.trace('workspace folders changed, root unchanged');
				return;
			}
			void this.enqueue(() => this.rebind(root));
		});
		return this.enqueue(() => this.startNow());
	}

	async stop(): Promise<void> {
		this.disposed = true;
		this.folders?.dispose();
		this.folders = undefined;
		await this.enqueue(() => this.stopNow());
	}

	/** Probe now rather than waiting for the next beat. `false` means it did not answer. */
	async checkHealth(): Promise<boolean> {
		return (await this.heartbeat?.check()) ?? false;
	}

	private async startNow(): Promise<void> {
		if (this.disposed) return;

		logger.info(`starting pyright worker from ${this.urls.engine}`);
		this.workers = startPyrightWorker(this.urls, logger);

		// After the worker, so fetching the engine overlaps reading the assets, and
		// per start, because the seed is only readable at `initialize`: a target
		// changed mid-session is a new session, never a reconfigured server.
		const seed = await this.loadSeed();

		// Rebuilt per start, so a restart picks up a workspace root that moved.
		this.root = this.workspaceRoot();
		const uris = createUriMap(this.root);
		const options = this.clientOptions(uris, seed);
		const client = new LanguageClient(CLIENT_ID, PRODUCT, options, this.workers.worker);
		this.client = client;

		// Before `start()`, which is where the client subscribes to the document
		// events itself. VS Code calls listeners in subscription order, and the
		// mirror has to release a document before the client opens it.
		this.mirror = createMirror({
			sink: createClientSink(client),
			uris,
			folder: workspace.workspaceFolders?.[0],
			log: logger,
		});

		try {
			await client.start();
		} catch (error) {
			await this.stopNow(); // or the workers outlive the failed start
			throw error;
		}

		this.traceListener = followTraceLevel(client);

		// A fresh worker starts with an empty filesystem, so every start re-seeds.
		// Not awaited: a large workspace must not hold up activation, and open
		// files already work through the client's own document sync.
		void this.mirror.seed().catch((error) => logger.error(`mirror: seeding failed: ${String(error)}`));

		// A heartbeat never reports a death after it has been disposed, so a probe
		// left in flight by a restart cannot kill the server that replaced it.
		this.heartbeat = startHeartbeat({
			probe: () => ping(client),
			onDead: () => void this.enqueue(() => this.restart('the server stopped answering')),
			log: logger,
		});
		logger.info('language client started');
	}

	private async stopNow(): Promise<void> {
		this.heartbeat?.dispose();
		this.heartbeat = undefined;
		this.traceListener?.dispose();
		this.traceListener = undefined;
		// Before the client goes: a push landing on a stopped client throws, and a
		// seed still walking would otherwise write into the worker that replaced it.
		this.mirror?.dispose();
		this.mirror = undefined;
		try {
			await this.client?.stop(STOP_TIMEOUT_MS);
		} catch (error) {
			// Expected whenever the worker is already gone: nothing answers `shutdown`.
			logger.trace(`stopping the language client failed: ${String(error)}`);
		} finally {
			this.client = undefined;
			this.workers?.dispose();
			this.workers = undefined;
		}
	}

	/**
	 * Rebuild for a new workspace root. Deliberate, not a failure, so it must not
	 * spend the restart budget: a user switching storage five times would
	 * otherwise be told the server gave up.
	 */
	private async rebind(root: string): Promise<void> {
		if (this.disposed) return;
		logger.info(`workspace root is now ${root}; rebuilding the session`);
		await this.stopNow();
		await this.startNow();
	}

	private async restart(reason: string): Promise<void> {
		if (this.disposed || this.gaveUp) return;

		const now = Date.now();
		// Prune first, so a long-lived session's history cannot grow forever.
		this.restarts = this.restarts.filter((at) => at > now - this.policy.windowMs);
		const decision = decideRestart(this.restarts, now, this.policy);
		await this.stopNow();

		if (!decision.restart) {
			this.gaveUp = true;
			logger.error(`${reason}; giving up after ${this.policy.maxRestarts} restarts`);
			reportGiveUp().catch((error) => logger.error(`could not report the failure: ${String(error)}`));
			return;
		}

		this.restarts.push(now);
		logger.warn(`${reason}; restarting (${decision.attempt} of ${this.policy.maxRestarts}) in ${decision.delayMs}ms`);
		await delay(decision.delayMs);
		if (this.disposed) return;

		try {
			await this.startNow();
		} catch (error) {
			logger.error(`restart failed: ${String(error)}`);
			void this.enqueue(() => this.restart('the server failed to restart'));
		}
	}

	/**
	 * The root the URI map translates from.
	 *
	 * One folder, deliberately. Several would need collision-free synthetic
	 * roots and per-folder mapping, and a device project is one folder. With no
	 * folder open there is nothing to translate, so the map is rooted at the
	 * server root and passes everything through unchanged.
	 */
	private workspaceRoot(): string {
		const folders = workspace.workspaceFolders ?? [];
		if (folders.length > 1 && !this.warnedMultiRoot) {
			this.warnedMultiRoot = true;
			logger.warn(`${folders.length} workspace folders open; analysing only "${folders[0].name}"`);
		}
		return folders[0]?.uri.toString() ?? SERVER_ROOT;
	}

	/**
	 * The stubs this session analyses against, or nothing if they could not be
	 * read.
	 *
	 * Failing is loud but never fatal. The engine reads exactly one stdlib root,
	 * so the alternative to falling back to its own is pointing it at a root with
	 * no `builtins.pyi`, where nothing resolves at all and every hover is
	 * `Unknown`. Wrong types beat no editor.
	 */
	private async loadSeed(): Promise<Seed | undefined> {
		const id = readTarget();
		// Cleared until the assets are actually read. A session that claims a
		// target it failed to load can never be asked to try again: the caller's
		// no-op guard sees the value it wants as already live, so re-selecting the
		// same board does nothing and the user is stuck on the fallback.
		this.target = undefined;
		try {
			const seed = await loadTarget(this.readStub, id);
			if (seed.id !== id) logger.warn(`no target "${id}" in the stub catalogue; analysing as "${seed.id}"`);
			logger.info(`target "${seed.id}" (${seed.label}): ${Object.keys(seed.files).length} stub files`);
			// The id that was asked for, not `seed.id`. A stale setting naming a
			// board that has left the catalogue loads `auto`, and recording `auto`
			// here would make every later configuration change look like a switch.
			this.target = id;
			return seed;
		} catch (error) {
			logger.error(`no device stubs, falling back to the bundled CPython typeshed: ${String(error)}`);
			return undefined;
		}
	}

	private clientOptions(uris: UriMap, seed: Seed | undefined): LanguageClientOptions {
		// One root or the other, never both. The engine resolves the stdlib from a
		// single typeshed, so this value alone decides whether the user is offered
		// their board's modules or desktop CPython's.
		const typeshed = seed ? TARGET_TYPESHED_URI : SERVER_TYPESHED;
		return {
			documentSelector: [{ language: 'python' }],
			// Mirrored, not the real channel. The trace stream needs no separate
			// channel: the client falls back to this one when none is given.
			outputChannel: this.outputChannel,
			workspaceFolder: serverWorkspaceFolder(uris),
			// Every URI the client sends or receives passes through here, so an
			// editor document and its mirrored copy are one file to the server
			// rather than two. Falling back to the original leaves URIs the
			// server owns, typeshed above all, untouched in both directions.
			uriConverters: {
				code2Protocol: (uri) => uris.toServerUri(uri.toString()) ?? uri.toString(),
				protocol2Code: (value) => Uri.parse(uris.toWorkspaceUri(value) ?? value),
			},
			errorHandler: this.errorHandler(),
			// The engine asks for its config by the section names it was built with,
			// which belong to another extension. Answering here is what keeps those
			// names out of our manifest, and another extension's settings out of this
			// engine. See `settings.ts`.
			middleware: {
				workspace: {
					// The level is read per request so a change applies without a
					// restart; the typeshed root is captured, because it cannot.
					configuration: (params) =>
						params.items.map((item) => serverSettings(item.section, { logLevel: readLogLevel(), typeshed })),
				},
			},
			// The only channel stubs have. The server destructures `files`
			// unguarded, applies its embedded typeshed only when it is an object,
			// and merges without ever removing, so this is read once and a later
			// `pyright/createFile` would write an empty file.
			//
			// The placeholder makes the root exist in the engine's in-memory
			// filesystem. Without it the engine tells the user "File or directory
			// /workspace does not exist" whenever the mirror has nothing to seed,
			// which is any workspace whose Python files are all open in editors.
			initializationOptions: {
				files: { ...seed?.files, [`${Uri.parse(uris.serverRoot).path}/.keep`]: '' },
			},
		};
	}

	private errorHandler(): ErrorHandler {
		return {
			error: (error, _message, count) => {
				logger.warn(`connection error (${count ?? 1}): ${error.message}`);
				// Reached by a protocol failure, not by a dead worker: VS Code's
				// nested-worker polyfill forwards no `error` event, so a worker that
				// throws arrives here as silence. Most of what does arrive is not
				// fatal, so ask the server whether it is still there rather than guess.
				void this.checkHealth();
				return { action: ErrorAction.Continue, handled: true };
			},
			closed: () => {
				void this.enqueue(() => this.restart('the connection closed'));
				return { action: CloseAction.DoNotRestart, handled: true };
			},
		};
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.queue.then(task);
		// The chain must not carry a rejection forward, or one failure blocks
		// every later start and stop.
		this.queue = result.catch(() => {});
		return result;
	}
}

/**
 * Restarting has stopped helping, so say so once and offer the one thing that
 * does work. A silently dead server still looks installed.
 */
async function reportGiveUp(): Promise<void> {
	const reload = 'Reload Window';
	const choice = await window.showErrorMessage(
		`${PRODUCT} stopped and could not be restarted. Reload the window to try again.`,
		reload
	);
	if (choice === reload) await commands.executeCommand('workbench.action.reloadWindow');
}

/**
 * Keep the protocol trace at the level `logLevel` implies, for as long as this
 * client lives.
 *
 * The trace level is the language client's own, and it re-reads its
 * `trace.server` key on *any* configuration change, not just one affecting it,
 * resetting the level to what it finds. `CLIENT_ID` makes that read always
 * answer `off`, so this is the only thing that ever turns tracing on, and the
 * derived value has to be put back after every change. Registering here, after
 * `start()`, is what puts this listener behind the client's.
 */
function followTraceLevel(client: LanguageClient): Disposable {
	// Caught, not `void`ed: this sends a notification, so a worker that died
	// between the change and this call rejects, and an unhandled rejection would
	// report nothing anywhere. At `warn`, because failing to apply the level is an
	// operational problem rather than the protocol detail `trace` carries.
	const apply = () =>
		client
			.setTrace(Trace.fromString(traceValueFor(readLogLevel())))
			.catch((error) => logger.warn(`could not update the trace level: ${String(error)}`));
	apply();
	return workspace.onDidChangeConfiguration(apply);
}

/**
 * The root reported to the server, which must be a `file:` URI.
 *
 * Pyright's browser build is backed by an in-memory filesystem keyed on plain
 * POSIX paths. Under any other scheme it reports non-existent files as existing
 * and nothing resolves, `builtins` included.
 *
 * The map already decides this by scheme, so read it from there rather than
 * repeating the rule: `file:` is its own root, anything else (`vscode-vfs:` on
 * vscode.dev, a virtual provider registered by an embedding app) gets the
 * synthetic root that open documents and the mirror both translate onto.
 *
 * Setting this also keeps `WorkspaceFoldersFeature` unregistered, so VS Code's
 * real folders never reach `initialize` behind the map's back.
 */
function serverWorkspaceFolder(uris: UriMap): WorkspaceFolder {
	const name = workspace.workspaceFolders?.[0]?.name ?? 'micropython-lsp';
	return { uri: Uri.parse(uris.serverRoot), name, index: 0 };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
