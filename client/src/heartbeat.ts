import { type Logger, SILENT_LOGGER } from './log-level';

/**
 * Liveness probe for the language server.
 *
 * A terminated worker is silent: `BrowserMessageReader` never fires `close`,
 * and `postMessage` into a dead worker throws nothing, so the LSP layer never
 * learns anything happened. Asking and timing out is the only detector.
 *
 * `probe()` resolving is the only thing that counts as alive; what a reply looks
 * like is the caller's business (see `ping.ts`). A miss counts against the
 * server only when repeated. The engine cannot cancel an in-flight analysis,
 * so one slow reply is normal.
 */

export interface HeartbeatOptions {
	probe: () => Promise<unknown>;
	onDead: () => void;
	/** How often to probe. */
	intervalMs?: number;
	/** How long one probe may take before it counts as a miss. */
	timeoutMs?: number;
	/** Consecutive misses before `onDead`. */
	missesBeforeDead?: number;
	log?: Logger;
}

export interface Heartbeat {
	/** Probe now. `false` means the server did not answer in time. */
	check(): Promise<boolean>;
	dispose(): void;
}

export function startHeartbeat(options: HeartbeatOptions): Heartbeat {
	const intervalMs = options.intervalMs ?? 30_000;
	const timeoutMs = options.timeoutMs ?? 8_000;
	const missesBeforeDead = options.missesBeforeDead ?? 2;
	const log = options.log ?? SILENT_LOGGER;

	let misses = 0;
	let disposed = false;
	let inFlight: Promise<boolean> | undefined;

	const timer = setInterval(() => void check(), intervalMs);

	function dispose(): void {
		disposed = true;
		clearInterval(timer);
	}

	function check(): Promise<boolean> {
		if (disposed) return Promise.resolve(false);
		// One probe in flight at a time, or the interval and a forced check both
		// count the same silence and kill the server on one slow analysis.
		return (inFlight ??= probe().finally(() => (inFlight = undefined)));
	}

	async function probe(): Promise<boolean> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<false>((resolve) => {
			timeout = setTimeout(() => resolve(false), timeoutMs);
		});

		// Started off a fresh promise so a probe that throws synchronously is a
		// miss rather than an exception thrown out of the heartbeat.
		const asked = Promise.resolve()
			.then(() => options.probe())
			.then(() => true, () => false);

		const answered = await Promise.race([asked, expiry]);
		clearTimeout(timeout);

		// A probe already in flight when `dispose()` ran belongs to a server that
		// has been replaced. Its silence is not news, and reporting it would kill
		// the *next* server.
		if (disposed) return false;

		if (answered) {
			misses = 0;
			return true;
		}

		misses += 1;
		log.warn(`no answer within ${timeoutMs}ms (miss ${misses} of ${missesBeforeDead})`);
		if (misses >= missesBeforeDead) {
			dispose();
			options.onDead();
		}
		return false;
	}

	return { check, dispose };
}
