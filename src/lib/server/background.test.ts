import { describe, expect, it } from 'vitest';
import { createWorkTracker } from './background';

describe('work that outlives a request', () => {
	it('a stopping server waits for running work and accepts no more', async () => {
		const tracker = createWorkTracker();
		let finish!: () => void;
		const work = tracker.track(new Promise<void>((resolve) => (finish = resolve)));
		expect(tracker.active).toBe(1);
		expect(tracker.accepting).toBe(true);

		let drained = false;
		const draining = tracker.drain().then(() => (drained = true));
		expect(tracker.accepting).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(drained).toBe(false); // still running: the singleton lock must not be released yet

		finish();
		await work;
		await draining;
		expect(drained).toBe(true);
		expect(tracker.active).toBe(0);
	});

	it('work that fails is over too, and drains at once when nothing is running', async () => {
		const tracker = createWorkTracker();
		await tracker.drain();
		const failing = tracker.track(Promise.reject(new Error('boom')));
		await expect(failing).rejects.toThrow('boom');
		await tracker.drain();
		expect(tracker.active).toBe(0);
	});
});
