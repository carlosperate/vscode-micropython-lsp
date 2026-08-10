import { describe, expect, it, vi } from 'vitest';

import {
	ENGINE_ERROR,
	ENGINE_FAILED,
	LOAD_ENGINE,
	loadEngineOnRequest,
	type PortPrototype,
	reportUncaughtErrors,
	startPortsOnListen,
	type WorkerScope,
} from '../client/src/engine-host';

/** A worker global scope stand-in, with the listeners it currently holds. */
function fakeScope() {
	const listeners = new Set<(event: MessageEvent) => void>();
	const posted: unknown[] = [];
	const scope: WorkerScope = {
		addEventListener: (_type, listener) => void listeners.add(listener),
		removeEventListener: (_type, listener) => void listeners.delete(listener),
		postMessage: (message) => void posted.push(message),
	};
	const deliver = (data: unknown) => {
		for (const listener of [...listeners]) listener({ data } as MessageEvent);
	};
	return { scope, listeners, posted, deliver };
}

describe('starting ports on listen', () => {
	// Two ports, so "started the right one" is distinguishable from "started the
	// only one", and one non-message listener, so it cannot just start everything.
	it('starts the port a message listener was attached to, and only that one', () => {
		const started: unknown[] = [];
		const listeners: string[] = [];
		class FakePort implements PortPrototype {
			addEventListener(type: string, ..._rest: unknown[]) {
				listeners.push(type);
			}
			start() {
				started.push(this);
			}
		}
		startPortsOnListen(FakePort.prototype);

		const quiet = new FakePort();
		const listening = new FakePort();
		quiet.addEventListener('error', () => {});
		expect(started).toEqual([]);

		listening.addEventListener('message', () => {});
		expect(started).toEqual([listening]);
		// The original still has to run, or the engine hears nothing on the ports
		// it does start itself.
		expect(listeners).toEqual(['error', 'message']);
	});
});

describe('loading the engine on request', () => {
	it('loads the url the extension host names', () => {
		const load = vi.fn();
		const { scope, deliver } = fakeScope();
		loadEngineOnRequest(scope, load);

		deliver({ type: LOAD_ENGINE, url: 'https://example.test/pyright.worker.js' });

		expect(load).toHaveBeenCalledWith('https://example.test/pyright.worker.js');
	});

	// The engine installs its own message listener while `importScripts` runs, so
	// anything left listening here would see the traffic meant for it.
	it('stops listening before it loads, so the engine owns every later message', () => {
		const seen: string[] = [];
		const { scope, listeners, deliver } = fakeScope();
		loadEngineOnRequest(scope, () => seen.push('loaded'));

		deliver({ type: LOAD_ENGINE, url: 'engine.js' });
		expect(listeners.size).toBe(0);

		deliver({ type: LOAD_ENGINE, url: 'second-engine.js' });
		expect(seen).toEqual(['loaded']);
	});

	it('ignores anything that is not a load request', () => {
		const load = vi.fn();
		const { scope, deliver } = fakeScope();
		loadEngineOnRequest(scope, load);

		deliver({ type: 'browser/boot', mode: 'foreground' });
		deliver(undefined);
		deliver('a string');

		expect(load).not.toHaveBeenCalled();
	});

	// Nothing else reports it: VS Code's nested-worker polyfill dispatches no
	// error event, so without this a worker that cannot load its engine is
	// indistinguishable from one that is simply slow.
	it('reports a failed load instead of throwing into silence', () => {
		const { scope, posted, deliver } = fakeScope();
		loadEngineOnRequest(scope, () => {
			throw new Error('404');
		});

		expect(() => deliver({ type: LOAD_ENGINE, url: 'engine.js' })).not.toThrow();
		expect(posted).toEqual([
			{ type: ENGINE_FAILED, url: 'engine.js', reason: 'Error: 404' },
		]);
	});
});

describe('reporting what the worker throws', () => {
	it('passes an uncaught error out, since VS Code drops it', () => {
		const posted: unknown[] = [];
		let thrown: ((event: ErrorEvent) => void) | undefined;
		reportUncaughtErrors({
			addEventListener: (_type, listener) => void (thrown = listener),
			postMessage: (message) => void posted.push(message),
		});

		thrown?.({ message: 'ReferenceError: x', filename: 'engine.js', lineno: 12 } as ErrorEvent);

		expect(posted).toEqual([{ type: ENGINE_ERROR, reason: 'ReferenceError: x (engine.js:12)' }]);
	});

	it('leaves out the location when there is none to give', () => {
		const posted: unknown[] = [];
		let thrown: ((event: ErrorEvent) => void) | undefined;
		reportUncaughtErrors({
			addEventListener: (_type, listener) => void (thrown = listener),
			postMessage: (message) => void posted.push(message),
		});

		thrown?.({ message: 'boom', filename: '', lineno: 0 } as ErrorEvent);

		expect(posted).toEqual([{ type: ENGINE_ERROR, reason: 'boom' }]);
	});
});
