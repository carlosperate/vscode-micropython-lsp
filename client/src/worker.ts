import {
	ENGINE_ERROR,
	ENGINE_FAILED,
	type EngineErrorMessage,
	type EngineFailedMessage,
	LOAD_ENGINE,
	type LoadEngineMessage,
} from './engine-host';
import { type Logger, SILENT_LOGGER } from './log-level';

/**
 * Boot and relay for the prebuilt pyright worker.
 *
 * Pyright asks us to create its background worker rather than creating one
 * itself. That indirection is the only reason this runs in VS Code at all: the
 * extension host worker may create one nested worker, but a worker created
 * inside that one throws. So the background worker is created here, one level
 * up.
 *
 * Every worker started here is `engineWorkerMain.js`, not the engine: it is told
 * where the engine is and loads it itself.
 *
 * The protocol is undocumented and unversioned. See the upgrade checklist in
 * dev.md before bumping the engine.
 */

interface NewWorkerMessage {
	type: 'browser/newWorker';
	initialData: unknown;
	port: MessagePort;
}

export interface EngineUrls {
	/** Our worker entry, which fixes the engine's port handling and loads it. */
	readonly host: string;
	/** The vendored pyright bundle, as published. */
	readonly engine: string;
}

export interface PyrightWorker {
	/** Foreground worker. Speaks LSP over its own message channel. */
	readonly worker: Worker;
	/**
	 * Live background analysis workers. Observable because a broken relay is
	 * otherwise invisible: the foreground worker keeps answering hover and
	 * completion while background analysis silently never runs.
	 */
	readonly backgroundCount: number;
	/** Terminates every worker started here, background ones included. */
	dispose(): void;
}

/** Takes its logger rather than importing one, so it stays free of `vscode`. */
export function startPyrightWorker(urls: EngineUrls, log: Logger = SILENT_LOGGER): PyrightWorker {
	const created: Worker[] = [];
	let disposed = false;

	const spawn = (name: string): Worker => {
		const worker = new Worker(urls.host, { name });
		// Tracked before anything else can throw, or dispose() would never see it.
		created.push(worker);
		log.trace(`${name}: created from ${urls.host}`);
		worker.addEventListener('messageerror', (e) => log.error(`${name} messageerror: ${String(e)}`));
		// Inert today, kept for the day it is not: the nested-worker polyfill never
		// dispatches this, which is why the entry reports its own failures instead.
		worker.addEventListener('error', (e) => log.error(`${name} error: ${e.message || e}`));
		// The only place those reports are heard, background workers included.
		worker.addEventListener('message', (event: MessageEvent) => {
			const message = event.data as EngineFailedMessage | EngineErrorMessage | undefined;
			if (message?.type === ENGINE_FAILED) log.error(`${name}: could not load ${message.url}: ${message.reason}`);
			else if (message?.type === ENGINE_ERROR) log.error(`${name}: uncaught: ${message.reason}`);
		});
		// First, always: delivery is ordered, so whatever a caller sends next lands
		// after the engine has loaded and installed its own listener.
		worker.postMessage({ type: LOAD_ENGINE, url: urls.engine } satisfies LoadEngineMessage);
		return worker;
	};

	const foreground = spawn('pyright-foreground');

	// addEventListener, never `onmessage`: BrowserMessageReader attaches with a
	// property assignment, which would clobber this on client.start().
	foreground.addEventListener('message', (event: MessageEvent) => {
		const message = event.data as NewWorkerMessage | undefined;
		if (message?.type !== 'browser/newWorker') return;
		// A relay after disposal would strand a worker nothing owns.
		if (disposed) return;

		log.trace(`relaying browser/newWorker (port is MessagePort: ${message.port instanceof MessagePort})`);
		spawn('pyright-background').postMessage(
			{ type: 'browser/boot', mode: 'background', initialData: message.initialData, port: message.port },
			[message.port]
		);
	});

	foreground.postMessage({ type: 'browser/boot', mode: 'foreground' });

	return {
		worker: foreground,
		get backgroundCount() {
			return created.filter((worker) => worker !== foreground).length;
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			log.trace(`terminating ${created.length} worker(s)`);
			for (const worker of created) worker.terminate();
			created.length = 0;
		},
	};
}
