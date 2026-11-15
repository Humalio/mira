import { sql, type SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from './db';
import { LOCK_NAMESPACE, lockMediaItem, lockOwner } from './locks';

describe('advisory locks', () => {
	/** Could another connection take this lock right now? (Released again at once.) */
	const free = async (query: SQL) => (await db.execute(query))[0].ok;
	const kinds = (id: string) => ({
		owner: sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE.owner}::int, hashtext(${id})) as ok`,
		mediaItem: sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE.mediaItem}::int, hashtext(${id})) as ok`,
		oneKey: sql`select pg_try_advisory_xact_lock(hashtext(${id})) as ok`
	});

	it("an owner's lock holds off that owner only, and nothing in the one-key space", async () => {
		const id = crypto.randomUUID();
		const other = crypto.randomUUID();
		await db.transaction(async (tx) => {
			await lockOwner(tx, id);
			expect(await free(kinds(id).owner)).toBe(false);
			expect(await free(kinds(other).owner)).toBe(true);
			// The single-instance and governance locks live in the one-key space; an
			// owner whose id hashed like them used to wait on them.
			expect(await free(kinds(id).oneKey)).toBe(true);
			expect(await free(kinds(id).mediaItem)).toBe(true);
		});
		expect(await free(kinds(id).owner)).toBe(true);
	});

	it("a media item's lock is a kind of its own", async () => {
		const id = crypto.randomUUID();
		await db.transaction(async (tx) => {
			await lockMediaItem(tx, id);
			expect(await free(kinds(id).mediaItem)).toBe(false);
			expect(await free(kinds(id).owner)).toBe(true);
		});
	});
});
