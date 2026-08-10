/**
 * What our worker entry does around the engine: fix its port handling, load it,
 * and report what VS Code drops. Loading the engine rather than being it keeps
 * the vendored bundle as published and gives us a foothold in its global scope.
 *
 * The URL has to be sent because `self.location` here is the polyfill's blob,
 * not our script. CLAUDE.md has the reasoning behind all three.
 */

/** The one message our worker entry understands, before the engine exists. */
export const LOAD_ENGINE = 'micropython-lsp/loadEngine';

/** Sent back when the engine could not be loaded. See `loadEngineOnRequest`. */
export const ENGINE_FAILED = 'micropython-lsp/engineFailed';

/** Sent back for anything the worker throws afterwards. See `reportUncaughtErrors`. */
export const ENGINE_ERROR = 'micropython-lsp/engineError';

export interface LoadEngineMessage {
	readonly type: typeof LOAD_ENGINE;
	readonly url: string;
}

export interface EngineFailedMessage {
	readonly type: typeof ENGINE_FAILED;
	readonly url: string;
	readonly reason: string;
}

export interface EngineErrorMessage {
	readonly type: typeof ENGINE_ERROR;
	readonly reason: string;
}

/** Just enough of `MessagePort.prototype` to patch it, and to fake it in a test. */
export interface PortPrototype {
	addEventListener(type: string, ...rest: unknown[]): void;
	start(): void;
}

/**
 * Start a port when a message listener is attached, which Node does implicitly
 * and the web does not. Without it the engine awaits reply ports it never
 * starts, answers no `textDocument/diagnostic`, and nothing shows a squiggle.
 * Probably permanent; CLAUDE.md says why, and when it stops being needed.
 */
export function startPortsOnListen(prototype: PortPrototype): void {
	const listen = prototype.addEventListener;
	prototype.addEventListener = function (this: PortPrototype, type: string, ...rest: unknown[]) {
		listen.call(this, type, ...rest);
		if (type === 'message') this.start();
	};
}

/** Just enough of the worker global scope to load the engine, and to fake it. */
export interface WorkerScope {
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
	removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
	postMessage(message: unknown): void;
}

/**
 * Load the engine named by the first `LOAD_ENGINE` message, and only the first.
 * Ordered delivery and a synchronous `importScripts` put the engine's own
 * listener in place before the next message, so nothing needs replaying.
 * Failures are posted by hand because no `error` event escapes a nested worker.
 */
export function loadEngineOnRequest(scope: WorkerScope, load: (url: string) => void): void {
	const listener = (event: MessageEvent) => {
		const message = event.data as LoadEngineMessage | undefined;
		if (message?.type !== LOAD_ENGINE) return;
		// Off before loading: one engine per worker, and every message after this
		// one belongs to the listener the engine is about to install.
		scope.removeEventListener('message', listener);
		try {
			load(message.url);
		} catch (error) {
			const failed: EngineFailedMessage = { type: ENGINE_FAILED, url: message.url, reason: String(error) };
			scope.postMessage(failed);
		}
	};
	scope.addEventListener('message', listener);
}

/** Just enough of the worker global scope to report what it throws. */
export interface ErrorScope {
	addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
	postMessage(message: unknown): void;
}

/**
 * Pass on anything the worker throws afterwards, which VS Code also drops. Best
 * effort: the engine's boot handler calls `self.close()` before rethrowing, and
 * a closing worker may never dispatch the event.
 */
export function reportUncaughtErrors(scope: ErrorScope): void {
	scope.addEventListener('error', (event) => {
		const where = event.filename ? ` (${event.filename}:${event.lineno})` : '';
		const error: EngineErrorMessage = { type: ENGINE_ERROR, reason: `${event.message}${where}` };
		scope.postMessage(error);
	});
}
