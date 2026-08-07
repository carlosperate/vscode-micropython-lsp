import { describe, expect, it } from 'vitest';

import { DEFAULT_RESTART_POLICY, decideRestart, type RestartPolicy } from '../client/src/restart-policy';

// The give-up path is otherwise only reachable by killing a worker five times in
// a browser, which is why the decision is a pure function in the first place.
const policy: RestartPolicy = { maxRestarts: 3, windowMs: 10_000, backoffMs: [0, 100, 500] };

describe('decideRestart', () => {
	it('restarts immediately the first time', () => {
		expect(decideRestart([], 1_000, policy)).toEqual({ restart: true, attempt: 1, delayMs: 0 });
	});

	it('backs off further on each successive restart', () => {
		expect(decideRestart([1_000], 1_100, policy)).toMatchObject({ attempt: 2, delayMs: 100 });
		expect(decideRestart([1_000, 1_100], 1_200, policy)).toMatchObject({ attempt: 3, delayMs: 500 });
	});

	it('gives up once the window is full', () => {
		expect(decideRestart([1_000, 1_100, 1_200], 1_300, policy)).toEqual({ restart: false });
	});

	it('forgets restarts that fall out of the window', () => {
		// A server that dies once an hour should keep being restarted forever.
		expect(decideRestart([1_000, 1_100, 1_200], 30_000, policy)).toMatchObject({ restart: true, attempt: 1 });
	});

	it('holds the last backoff step rather than running off the end', () => {
		const short: RestartPolicy = { maxRestarts: 4, windowMs: 10_000, backoffMs: [0, 100] };
		expect(decideRestart([1, 2, 3], 4, short)).toMatchObject({ attempt: 4, delayMs: 100 });
	});

	it('ships a default that gives up rather than looping forever', () => {
		const history = Array.from({ length: DEFAULT_RESTART_POLICY.maxRestarts }, (_, i) => i);
		expect(decideRestart(history, 0, DEFAULT_RESTART_POLICY).restart).toBe(false);
	});
});
