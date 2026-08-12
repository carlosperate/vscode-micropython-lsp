import { ExtensionContext, ProgressLocation, Uri, window, workspace } from 'vscode';

import { clientChannel, initLogging, logger } from './log';
import { AnalysisSession, readTarget } from './session';
import { type ReadStub } from './target';
import { type EngineUrls } from './worker';

const ENABLE_SECTION = 'micropython-lsp.enable';
const TARGET_SECTION = 'micropython-lsp.target';

/** Where the generated stub catalogue and its layers live inside the extension. */
const STUBS = 'assets/stubs';

let session: AnalysisSession | undefined;
let engineUrls: EngineUrls;
let readStub: ReadStub;
/** Serialises the enable and target transitions, which can otherwise interleave. */
let queue: Promise<unknown> = Promise.resolve();

export async function activate(context: ExtensionContext) {
	initLogging(context);
	engineUrls = {
		host: Uri.joinPath(context.extensionUri, 'client/dist/engineWorkerMain.js').toString(true),
		engine: Uri.joinPath(context.extensionUri, 'assets/pyright.worker.js').toString(true),
	};
	readStub = stubReader(context);

	// Before the first start, not after: starting fetches the worker and waits for
	// the LSP handshake, and a setting changed during those seconds would
	// otherwise land on no listener and be lost.
	context.subscriptions.push(
		workspace.onDidChangeConfiguration((event) => {
			// Nothing awaits these, so a failure has to be reported here or it
			// becomes an unhandled rejection with nothing in the output channel.
			if (event.affectsConfiguration(ENABLE_SECTION)) {
				void enqueue(syncEnabled).catch((error) => logger.error(`could not apply ${ENABLE_SECTION}: ${String(error)}`));
			}
			if (event.affectsConfiguration(TARGET_SECTION)) {
				void enqueue(applyTarget).catch((error) => logger.error(`could not apply ${TARGET_SECTION}: ${String(error)}`));
			}
		})
	);

	// The same path as a later toggle, and awaited, so a failure to start still
	// fails activation the way VS Code expects.
	await enqueue(syncEnabled);

	// Test seam, not a public API. Getters, because a restart replaces both.
	return {
		get client() {
			return session?.languageClient;
		},
		get pyright() {
			return session?.pyright;
		},
		checkHealth: () => session?.checkHealth() ?? Promise.resolve(false),
	};
}

export async function deactivate(): Promise<void> {
	await enqueue(stopSession);
}

function isEnabled(): boolean {
	return workspace.getConfiguration().get<boolean>(ENABLE_SECTION, true);
}

/**
 * Reads a bundled stub asset.
 *
 * `workspace.fs`, never `fetch`: on desktop the extension URI is `file:`, which
 * `fetch` cannot read. A `fetch` here passes every browser test and then fails
 * on desktop as "no board modules resolve", which reads like a missing
 * catalogue entry rather than a wrong API.
 */
function stubReader(context: ExtensionContext): ReadStub {
	return async (path) =>
		new TextDecoder().decode(await workspace.fs.readFile(Uri.joinPath(context.extensionUri, STUBS, path)));
}

/**
 * Converge on whatever the setting says now.
 *
 * The value is read here rather than captured at the event, so a queue holding
 * two toggles settles on the current setting rather than replaying a stale one.
 *
 * `session` is the record of whether we are running, not `languageClient`: a
 * restart leaves the client undefined for a moment, and keying on that would
 * build a second session over the top of one that is merely mid-restart.
 */
async function syncEnabled(): Promise<void> {
	const enabled = isEnabled();
	const running = session !== undefined;
	if (enabled === running) return;

	if (!enabled) {
		logger.info(`${ENABLE_SECTION} = false; stopping the language server`);
		await stopSession();
		return;
	}

	logger.info(`${ENABLE_SECTION} = true; starting the language server`);
	await startSession();
}

/**
 * A new board is a new server, not a reconfigured one.
 *
 * The engine reads its seed once, at `initialize`, and merges it into a
 * filesystem it never removes from, so re-initialising the same worker would
 * leave the previous board's exclusive modules resolvable: switch an ESP32 for a
 * Pico and `esp32` and `espnow` quietly survive. The language client is no help
 * either, since it re-wraps the `Worker` it was constructed with. Replacing the
 * session is what builds a new worker and a new client.
 */
async function applyTarget(): Promise<void> {
	// Off: the next start reads the setting itself, so there is nothing to do.
	if (!session) return;

	// The event fires for any write to the key, including one that sets the value
	// it already had, and for a scope change that leaves the effective value
	// alone. Comparing against what the session actually loaded is also what stops
	// a save that changes `enable` and `target` together from booting a worker
	// twice: `syncEnabled` runs first and already starts on the new target.
	const wanted = readTarget();
	if (wanted === session.loadedTarget) {
		logger.trace(`${TARGET_SECTION} changed to the target already loaded (${wanted}); nothing to do`);
		return;
	}

	logger.info(`${TARGET_SECTION} is now "${wanted}"; rebuilding the language server`);
	await window.withProgress(
		// The engine is already in the HTTP cache, so this is parse and analysis
		// rather than a re-download, but it is not instant either.
		{ location: ProgressLocation.Window, title: 'MicroPython IntelliSense: loading stubs' },
		async () => {
			await stopSession();
			await startSession();
		}
	);
}

async function startSession(): Promise<void> {
	// Off means off: the large basedpyright worker is only fetched here, so a
	// project that would rather use a different Python server pays nothing for
	// this one being installed.
	const starting = new AnalysisSession(engineUrls, clientChannel(), readStub);
	session = starting;
	try {
		await starting.start();
	} catch (error) {
		// Or the next toggle sees a session that never started and does nothing.
		if (session === starting) session = undefined;
		throw error;
	}
}

async function stopSession(): Promise<void> {
	const stopping = session;
	// Cleared first: a stop takes a round trip, and until it returns the
	// extension must already look off to anything reading this.
	session = undefined;
	await stopping?.stop();
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const result = queue.then(task);
	// The chain must not carry a rejection forward, or one failed start blocks
	// every later toggle.
	queue = result.catch(() => {});
	return result;
}
