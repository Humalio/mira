import { and, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from './db';
import { albums, uploadSessions, type UploadSession } from './schema';
import { cleanupUpload, deleteMediaItemDir } from './storage';

/**
 * How long an unfinished upload is kept before the sweep removes its chunks. The
 * clock starts again with every chunk that arrives, so `expires_at` also says when
 * the upload was last heard from (there is no column for that, and none can be added).
 */
export const UPLOAD_TTL_MS = 24 * 60 * 60_000;

/**
 * An upload that has sent nothing for this long is taken to be abandoned as far as
 * limits go: a closed tab, a phone that died. It is longer than the ten minutes the
 * page itself keeps retrying through a lost connection. The chunks are still kept for
 * the full `UPLOAD_TTL_MS`.
 */
export const UPLOAD_QUIET_MS = 30 * 60_000;

/** SQL condition: this upload session is being sent right now, or is being finalised. */
export const uploadUnderWay = (now = Date.now()) =>
	or(
		eq(uploadSessions.state, 'completing'),
		and(
			eq(uploadSessions.state, 'receiving'),
			gt(uploadSessions.expiresAt, new Date(now + UPLOAD_TTL_MS - UPLOAD_QUIET_MS))
		)
	);

/**
 * SQL expression: the storage one unfinished upload holds back from its album's owner.
 * An upload under way holds everything it declared, so that a video which was let
 * start can also finish. An abandoned one holds only what actually arrived: five
 * dead 2 GB uploads used to keep a 10 GB account "full" for a day with an empty disk.
 */
export const reservedUploadBytes = (now = Date.now()) =>
	sql<string>`coalesce(sum(case when ${uploadUnderWay(now)} then ${uploadSessions.declaredBytes} else ${uploadSessions.receivedBytes} end), 0)`;

export async function getUploadSession(id: string): Promise<UploadSession | undefined> {
	return (await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)).limit(1))[0];
}

/** Bounded cleanup batch; run from the maintenance loop (see maintenance.ts), not the request path. */
export async function cleanupExpiredUploadSessions(now = new Date()): Promise<void> {
	const expired = await db
		.select({ id: uploadSessions.id, state: uploadSessions.state, albumSlug: albums.slug })
		.from(uploadSessions)
		.innerJoin(albums, eq(uploadSessions.albumId, albums.id))
		.where(lt(uploadSessions.expiresAt, now))
		.limit(100);
	for (const row of expired) {
		try {
			if (row.state !== 'complete') {
				// A completing request can win the race after the initial SELECT. Claim
				// the expired row first; a committed completion never has its media removed.
				const [claimed] = await db
					.update(uploadSessions)
					.set({ state: 'failed' })
					.where(
						and(
							eq(uploadSessions.id, row.id),
							lt(uploadSessions.expiresAt, now),
							inArray(uploadSessions.state, ['receiving', 'completing', 'failed'])
						)
					)
					.returning({ id: uploadSessions.id });
				if (!claimed) continue;
				await deleteMediaItemDir(row.albumSlug, row.id);
			} else {
				const current = await getUploadSession(row.id);
				if (current?.state !== 'complete' || current.expiresAt >= now) continue;
			}
			await cleanupUpload(row.id);
			await db.delete(uploadSessions).where(and(eq(uploadSessions.id, row.id), lt(uploadSessions.expiresAt, now)));
		} catch (cause) {
			// Keep the row as a cleanup retry marker rather than losing track of files,
			// but say so: a silently stuck sweeper is how disks fill up.
			console.error('[uploads] expired-session cleanup failed; will retry', { uploadId: row.id, cause });
		}
	}
}
