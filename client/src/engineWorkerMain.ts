import {
	type ErrorScope,
	loadEngineOnRequest,
	type PortPrototype,
	reportUncaughtErrors,
	startPortsOnListen,
	type WorkerScope,
} from './engine-host';

/**
 * The worker the extension starts, which loads the engine rather than being it.
 * A classic script both ways: VS Code's polyfill boots it with `importScripts`,
 * and it loads the engine the same way. See `engine-host.ts` for all three parts.
 */

declare function importScripts(...urls: string[]): void;

/** The worker global, which is neither a `Window` nor typed as a worker here. */
const scope = self as unknown as WorkerScope & ErrorScope;

startPortsOnListen(MessagePort.prototype as unknown as PortPrototype);
reportUncaughtErrors(scope);
// Wrapped, not by reference: `importScripts` detached from the worker global is
// not reliably portable.
loadEngineOnRequest(scope, (url) => importScripts(url));
