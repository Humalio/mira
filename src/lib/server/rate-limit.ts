import { error } from '@sveltejs/kit';

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

/**
 * Fixed-window limiter for Mira's single-node deployment. If the application is
 * replicated, replace this module with the same interface backed by Redis.
 */
export function rateLimit(key: string, limit: number, windowMs: number): void {
	const now = Date.now();
	if (now - lastSweep > 60_000) {
		for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
		lastSweep = now;
	}

	const current = buckets.get(key);
	if (!current || current.resetAt <= now) {
		buckets.set(key, { count: 1, resetAt: now + windowMs });
		return;
	}
	if (current.count >= limit) {
		// `retryAfter` lets a well-behaved client (the batch uploader) wait out the
		// window instead of guessing with a blind backoff and giving up.
		const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
		throw error(429, `Too many requests. Try again in ${retryAfter} seconds.`, { retryAfter });
	}
	current.count++;
}

export function requestAddress(request: Request, getClientAddress?: () => string): string {
	// Adapter-node's getClientAddress is authoritative. Forwarded headers are not
	// trusted here because that trust belongs in the reverse-proxy adapter config.
	try {
		return getClientAddress?.() || 'unknown';
	} catch {
		return 'unknown';
	}
}
