import { error } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { retryDelayMs, worthRetrying } from './video-finalize';

const thrown = (make: () => unknown) => {
	try {
		make();
	} catch (cause) {
		return cause;
	}
};
const coded = (code: string) => Object.assign(new Error(code), { code });

describe('which finalisation failures keep the upload for another try', () => {
	it('retries what may pass: no space right now, a lock or connection timeout, the unexplained', () => {
		expect(worthRetrying(new Error('Insufficient temporary media storage'))).toBe(true);
		expect(worthRetrying(coded('55P03'))).toBe(true); // lock_timeout
		expect(worthRetrying(coded('57014'))).toBe(true); // statement_timeout
		expect(worthRetrying(coded('40P01'))).toBe(true); // deadlock victim
		expect(worthRetrying(coded('ECONNRESET'))).toBe(true);
		expect(worthRetrying(coded('ENOSPC'))).toBe(true);
		expect(worthRetrying(thrown(() => error(503, 'busy')))).toBe(true);
		expect(worthRetrying(undefined)).toBe(true);
	});

	it('gives up on what another try cannot cure', () => {
		expect(worthRetrying(thrown(() => error(413, 'Over the storage limit')))).toBe(false);
		expect(worthRetrying(coded('ENOENT'))).toBe(false); // a chunk is gone
		expect(worthRetrying(coded('23503'))).toBe(false); // its album, moment or member was deleted
	});

	it('waits longer after each failure, half an hour at most', () => {
		expect(retryDelayMs(1)).toBe(60_000);
		expect(retryDelayMs(2)).toBe(120_000);
		expect(retryDelayMs(3)).toBe(240_000);
		expect(retryDelayMs(6)).toBe(30 * 60_000);
		expect(retryDelayMs(500)).toBe(30 * 60_000);
	});
});
