import { describe, expect, it } from 'vitest';
import { createConcurrencyGate } from './concurrency';

describe('createConcurrencyGate', () => {
	it('queues excess work and hands the slot to the next waiter', async () => {
		const acquire = createConcurrencyGate(1, 'busy', { maxWaiting: 1, maxWaitMs: 1_000 });
		const release = await acquire();
		const waiting = acquire();
		await expect(acquire()).rejects.toMatchObject({ status: 503, body: { message: 'busy' } });
		release();
		release(); // idempotent
		const next = await waiting;
		expect(next).toBeTypeOf('function');
		next();
		(await acquire())();
	});

	it('rejects a waiter whose wait expires', async () => {
		const acquire = createConcurrencyGate(1, 'busy', { maxWaiting: 1, maxWaitMs: 10 });
		const release = await acquire();
		await expect(acquire()).rejects.toMatchObject({ status: 503 });
		release();
		(await acquire())();
	});
});
