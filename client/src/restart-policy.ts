/**
 * When to restart the language server after it dies, and when to stop trying.
 *
 * Pure so the give-up branch is reachable from a unit test. The alternative is
 * killing a worker in a browser five times in three minutes.
 */

export interface RestartPolicy {
	/** Restarts allowed within `windowMs` before giving up. */
	readonly maxRestarts: number;
	readonly windowMs: number;
	/** Delay before each attempt; the last entry repeats. */
	readonly backoffMs: readonly number[];
}

/** Four tries spread over ~11s, then stop. The backoff is short on purpose: `stop()` waits on it. */
export const DEFAULT_RESTART_POLICY: RestartPolicy = {
	maxRestarts: 4,
	windowMs: 180_000,
	backoffMs: [0, 1_000, 5_000],
};

export type RestartDecision =
	| { readonly restart: true; readonly attempt: number; readonly delayMs: number }
	| { readonly restart: false };

/** `history` holds the timestamps of previous restarts. */
export function decideRestart(
	history: readonly number[],
	now: number,
	policy: RestartPolicy = DEFAULT_RESTART_POLICY
): RestartDecision {
	const recent = history.filter((at) => at > now - policy.windowMs);
	if (recent.length >= policy.maxRestarts) return { restart: false };

	const step = Math.min(recent.length, policy.backoffMs.length - 1);
	return { restart: true, attempt: recent.length + 1, delayMs: policy.backoffMs[step] ?? 0 };
}
