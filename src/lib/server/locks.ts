/**
 * Transaction-scoped advisory locks, each kind in its own namespace.
 *
 * PostgreSQL has two separate key spaces for advisory locks: one 64-bit key, or two
 * 32-bit keys. They never overlap. The process-wide locks (`mira:single-instance`,
 * `mira:admin-governance`, `mira:initial-schema`) live in the one-key space and stay
 * there: an old and a new server must still exclude each other across an upgrade.
 * Every per-row lock lives in the two-key space under a namespace of its own, so a
 * hash collision can only ever make two locks of the same kind wait for each other,
 * never an owner's uploads wait for the single-instance lock or for admin governance.
 *
 * Every site that takes one kind of lock must use the same helper here: a lock taken
 * in another space or namespace excludes nothing.
 */
import { sql } from 'drizzle-orm';
import type { db } from './db';

/** A drizzle transaction handle (same query surface as `db`). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The first key of each kind of lock ("MIR" and a number, to stand out in pg_locks). */
export const LOCK_NAMESPACE = {
	/** One account's storage: uploads, deletions, album creation, counters. */
	owner: 0x4d495201,
	/** One media item: deleting it, or replacing its poster. */
	mediaItem: 0x4d495202,
	/** Creating a moment in one album. */
	momentCreate: 0x4d495203
} as const;

async function lock(tx: Tx, namespace: number, key: string): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(${namespace}::int, hashtext(${key}))`);
}

/** Hold the per-owner lock until the transaction ends. */
export const lockOwner = (tx: Tx, ownerUserId: string) => lock(tx, LOCK_NAMESPACE.owner, ownerUserId);

/** Hold the lock of one media item until the transaction ends. */
export const lockMediaItem = (tx: Tx, mediaItemId: string) => lock(tx, LOCK_NAMESPACE.mediaItem, mediaItemId);

/** Hold the lock for creating moments in one album until the transaction ends. */
export const lockMomentCreate = (tx: Tx, albumId: string) => lock(tx, LOCK_NAMESPACE.momentCreate, albumId);
