import { commands, OutputChannel, Uri, window, workspace, WorkspaceFolder } from 'vscode';
import { CloseAction, ErrorAction, ErrorHandler, LanguageClientOptions } from 'vscode-languageclient';
import { LanguageClient } from 'vscode-languageclient/browser';

import { Heartbeat, startHeartbeat } from './heartbeat';
import { debug, log, traceChannel } from './log';
import { ping } from './ping';
import { DEFAULT_RESTART_POLICY, decideRestart, RestartPolicy } from './restart-policy';
import { PyrightWorker, startPyrightWorker } from './worker';

/**
 * A dead server never answers `shutdown`, and dead is what this path mostly
 * stops. Hitting the timeout is cheap (the browser build holds nothing worth
 * flushing, so an unclean stop costs one log line), while the default 2s would
 * be added to every restart.
 */
const STOP_TIMEOUT_MS = 1_000;

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
	private restarts: number[] = [];
	private gaveUp = false;
	private disposed = false;
	/** Serialises start, stop and restart, which can otherwise interleave. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly workerUrl: string,
		private readonly outputChannel: OutputChannel,
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

	start(): Promise<void> {
		return this.enqueue(() => this.startNow());
	}

	async stop(): Promise<void> {
		this.disposed = true;
		await this.enqueue(() => this.stopNow());
	}

	/** Probe now rather than waiting for the next beat. `false` means it did not answer. */
	async checkHealth(): Promise<boolean> {
		return (await this.heartbeat?.check()) ?? false;
	}

	private async startNow(): Promise<void> {
		if (this.disposed) return;

		log(`starting pyright worker from ${this.workerUrl}`);
		this.workers = startPyrightWorker(this.workerUrl, debug);

		const client = new LanguageClient('micropython-lsp', 'MicroPython LSP', this.clientOptions(), this.workers.worker);
		this.client = client;
		try {
			await client.start();
		} catch (error) {
			await this.stopNow(); // or the workers outlive the failed start
			throw error;
		}

		// A heartbeat never reports a death after it has been disposed, so a probe
		// left in flight by a restart cannot kill the server that replaced it.
		this.heartbeat = startHeartbeat({
			probe: () => ping(client),
			onDead: () => void this.enqueue(() => this.restart('the server stopped answering')),
			log,
		});
		log('language client started');
	}

	private async stopNow(): Promise<void> {
		this.heartbeat?.dispose();
		this.heartbeat = undefined;
		try {
			await this.client?.stop(STOP_TIMEOUT_MS);
		} catch (error) {
			// Expected whenever the worker is already gone: nothing answers `shutdown`.
			debug(`stopping the language client failed: ${String(error)}`);
		} finally {
			this.client = undefined;
			this.workers?.dispose();
			this.workers = undefined;
		}
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
			log(`${reason}; giving up after ${this.policy.maxRestarts} restarts`);
			reportGiveUp().catch((error) => log(`could not report the failure: ${String(error)}`));
			return;
		}

		this.restarts.push(now);
		log(`${reason}; restarting (${decision.attempt} of ${this.policy.maxRestarts}) in ${decision.delayMs}ms`);
		await delay(decision.delayMs);
		if (this.disposed) return;

		try {
			await this.startNow();
		} catch (error) {
			log(`restart failed: ${String(error)}`);
			void this.enqueue(() => this.restart('the server failed to restart'));
		}
	}

	private clientOptions(): LanguageClientOptions {
		return {
			documentSelector: [{ language: 'python' }],
			outputChannel: this.outputChannel,
			traceOutputChannel: traceChannel(),
			workspaceFolder: serverWorkspaceFolder(),
			errorHandler: this.errorHandler(),
			// Sent even when empty: the server destructures `files` unguarded, and
			// only applies its embedded typeshed when it is an object. Device stubs
			// go here once they are bundled.
			initializationOptions: { files: {} },
		};
	}

	private errorHandler(): ErrorHandler {
		return {
			error: (error, _message, count) => {
				log(`connection error (${count ?? 1}): ${error.message}`);
				// This is where a worker `error` event surfaces, and most are not
				// fatal. Ask the server whether it is still there rather than guess.
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
		'MicroPython IntelliSense stopped and could not be restarted. Reload the window to try again.',
		reload
	);
	if (choice === reload) await commands.executeCommand('workbench.action.reloadWindow');
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
