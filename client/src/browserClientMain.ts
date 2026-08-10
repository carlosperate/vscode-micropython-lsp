import { ExtensionContext, Uri, workspace } from 'vscode';

import { clientChannel, initLogging, logger } from './log';
import { AnalysisSession } from './session';
import { type EngineUrls } from './worker';

const ENABLE_SECTION = 'micropython-lsp.enable';

let session: AnalysisSession | undefined;
let engineUrls: EngineUrls;
/** Serialises the enable transitions, which can otherwise interleave. */
let queue: Promise<unknown> = Promise.resolve();

export async function activate(context: ExtensionContext) {
	initLogging(context);
	engineUrls = {
		host: Uri.joinPath(context.extensionUri, 'client/dist/engineWorkerMain.js').toString(true),
		engine: Uri.joinPath(context.extensionUri, 'assets/pyright.worker.js').toString(true),
	};

	// Before the first start, not after: starting fetches the worker and waits for
	// the LSP handshake, and a setting changed during those seconds would
	// otherwise land on no listener and be lost.
	context.subscriptions.push(
		workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration(ENABLE_SECTION)) return;
			// Nothing awaits this, so a failed start has to be reported here or it
			// becomes an unhandled rejection with nothing in the output channel.
			void enqueue(syncEnabled).catch((error) => logger.error(`could not apply ${ENABLE_SECTION}: ${String(error)}`));
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
	await enqueue(async () => {
		await session?.stop();
		session = undefined;
	});
}

function isEnabled(): boolean {
	return workspace.getConfiguration().get<boolean>(ENABLE_SECTION, true);
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
		const stopping = session;
		// Cleared first: a stop takes a round trip, and until it returns the
		// extension must already look off to anything reading this.
		session = undefined;
		await stopping?.stop();
		return;
	}

	logger.info(`${ENABLE_SECTION} = true; starting the language server`);
	// Off means off: the large basedpyright worker is only fetched here, so a
	// project that would rather use a different Python server pays nothing for
	// this one being installed.
	const starting = new AnalysisSession(engineUrls, clientChannel());
	session = starting;
	try {
		await starting.start();
	} catch (error) {
		// Or the next toggle sees a session that never started and does nothing.
		if (session === starting) session = undefined;
		throw error;
	}
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const result = queue.then(task);
	// The chain must not carry a rejection forward, or one failed start blocks
	// every later toggle.
	queue = result.catch(() => {});
	return result;
}
