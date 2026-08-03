import { error } from '@sveltejs/kit';

/**
 * Single-process concurrency gate for memory/disk-heavy request stages. Excess
 * work queues (bounded) for up to `maxWaitMs` instead of failing instantly — a
 * burst of guests uploading at once must slow down, not lose photos. Only when
 * the queue is full or the wait expires does the caller get a retryable 503.
 */
export function createConcurrencyGate(
	maxActive: number,
	busyMessage: string,
	{ maxWaiting = maxActive * 8, maxWaitMs = 30_000 }: { maxWaiting?: number; maxWaitMs?: number } = {}
): () => Promise<() => void> {
	let active = 0;
	const waiters: Array<() => void> = [];

	const releaser = () => {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = waiters.shift();
			if (next)
				next(); // hand the slot straight to the next waiter
			else active--;
		};
	};

	return async () => {
		if (active < maxActive) {
			active++;
			return releaser();
		}
		if (waiters.length >= maxWaiting) throw error(503, busyMessage);
		await new Promise<void>((resolve, reject) => {
			const grant = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				const i = waiters.indexOf(grant);
				if (i >= 0) waiters.splice(i, 1);
				try {
					error(503, busyMessage); // Kit's error() throws; capture it for reject()
				} catch (httpError) {
					reject(httpError);
				}
			}, maxWaitMs);
			waiters.push(grant);
		});
		return releaser();
	};
}

export const acquireImageProcessing = createConcurrencyGate(2, 'The image processor is busy; try again shortly', {
	maxWaiting: 32
});
export const acquireVideoChunk = createConcurrencyGate(8, 'The upload service is busy; retry this chunk shortly', {
	maxWaiting: 32
});
