import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startHeartbeat } from '../client/src/heartbeat';

const options = { intervalMs: 1_000, timeoutMs: 500, missesBeforeDead: 2 };

describe('startHeartbeat', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('probes on the interval', async () => {
		const probe = vi.fn().mockResolvedValue(undefined);
		const beat = startHeartbeat({ ...options, probe, onDead: () => {} });

		await vi.advanceTimersByTimeAsync(2_500);
		expect(probe).toHaveBeenCalledTimes(2);
		beat.dispose();
	});

	it('counts a rejected probe as a miss', async () => {
		// Deciding which rejections mean "the worker replied" is `ping.ts`'s job.
		// Here, resolving is the only thing that means alive.
		const onDead = vi.fn();
		const beat = startHeartbeat({ ...options, probe: () => Promise.reject(new Error('no')), onDead });

		await expect(beat.check()).resolves.toBe(false);
		await expect(beat.check()).resolves.toBe(false);
		expect(onDead).toHaveBeenCalledTimes(1);
	});

	it('counts a probe that throws synchronously as a miss, not a crash', async () => {
		const onDead = vi.fn();
		const beat = startHeartbeat({
			...options,
			probe: () => {
				throw new Error('client is not running');
			},
			onDead,
		});

		await expect(beat.check()).resolves.toBe(false);
		expect(onDead).not.toHaveBeenCalled();
		beat.dispose();
	});

	it('declares death only after consecutive misses', async () => {
		const onDead = vi.fn();
		const beat = startHeartbeat({ ...options, probe: () => new Promise(() => {}), onDead });

		const first = beat.check();
		await vi.advanceTimersByTimeAsync(500);
		await expect(first).resolves.toBe(false);
		expect(onDead).not.toHaveBeenCalled();

		const second = beat.check();
		await vi.advanceTimersByTimeAsync(500);
		await expect(second).resolves.toBe(false);
		expect(onDead).toHaveBeenCalledTimes(1);

		// Once dead it stops probing, so it cannot report the same death twice.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(onDead).toHaveBeenCalledTimes(1);
	});

	it('forgets a miss once the server answers again', async () => {
		const onDead = vi.fn();
		let hang = true;
		const beat = startHeartbeat({
			...options,
			probe: () => (hang ? new Promise(() => {}) : Promise.resolve()),
			onDead,
		});

		const missed = beat.check();
		await vi.advanceTimersByTimeAsync(500);
		await expect(missed).resolves.toBe(false);

		hang = false;
		await expect(beat.check()).resolves.toBe(true);

		hang = true;
		const again = beat.check();
		await vi.advanceTimersByTimeAsync(500);
		await expect(again).resolves.toBe(false);
		expect(onDead).not.toHaveBeenCalled();
		beat.dispose();
	});

	it('shares one probe between concurrent checks', async () => {
		const probe = vi.fn().mockResolvedValue(undefined);
		const beat = startHeartbeat({ ...options, probe, onDead: () => {} });

		await Promise.all([beat.check(), beat.check(), beat.check()]);
		expect(probe).toHaveBeenCalledTimes(1);
		beat.dispose();
	});

	it('never reports a death from a probe that was in flight when it was disposed', async () => {
		// The session disposes a heartbeat when it replaces the server. A late
		// timeout from the old one would otherwise kill the new server.
		const onDead = vi.fn();
		const beat = startHeartbeat({ ...options, probe: () => new Promise(() => {}), onDead });

		const first = beat.check();
		await vi.advanceTimersByTimeAsync(500);
		await expect(first).resolves.toBe(false);

		// The second probe is in flight when the session replaces the server.
		void beat.check();
		beat.dispose();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(onDead).not.toHaveBeenCalled();
	});

	it('stops probing once disposed', async () => {
		const probe = vi.fn().mockResolvedValue(undefined);
		const beat = startHeartbeat({ ...options, probe, onDead: () => {} });

		beat.dispose();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(probe).not.toHaveBeenCalled();
		// `false` throughout means "did not answer", never "no opinion".
		await expect(beat.check()).resolves.toBe(false);
	});
});
