/**
 * Boot and relay for the prebuilt pyright worker.
 *
 * Pyright asks us to create its background worker rather than creating one
 * itself. That indirection is the only reason this runs in VS Code at all: the
 * extension host worker may create one nested worker, but a worker created
 * inside that one throws. So the background worker is created here, one level
 * up.
 *
 * The protocol is undocumented and unversioned. See the upgrade checklist in
 * dev.md before bumping the engine.
 */

interface NewWorkerMessage {
	type: 'browser/newWorker';
	initialData: unknown;
	port: MessagePort;
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
export function startPyrightWorker(workerUrl: string, log: (message: string) => void = () => {}): PyrightWorker {
	const created: Worker[] = [];

	const spawn = (name: string): Worker => {
		const worker = new Worker(workerUrl, { name });
		log(`${name}: created`);
		worker.addEventListener('error', (e) => log(`${name} error: ${e.message || e}`));
		worker.addEventListener('messageerror', (e) => log(`${name} messageerror: ${String(e)}`));
		created.push(worker);
		return worker;
	};

	const foreground = spawn('pyright-foreground');

	// addEventListener, never `onmessage`: BrowserMessageReader attaches with a
	// property assignment, which would clobber this on client.start().
	foreground.addEventListener('message', (event: MessageEvent) => {
		const message = event.data as NewWorkerMessage | undefined;
		if (message?.type !== 'browser/newWorker') return;

		log(`relaying browser/newWorker (port is MessagePort: ${message.port instanceof MessagePort})`);
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
			log(`terminating ${created.length} worker(s)`);
			for (const worker of created) worker.terminate();
			created.length = 0;
		},
	};
}
