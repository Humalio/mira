import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { albums, mediaDeletions, photos } from './schema';
import { cleanupUpload, deleteMediaTree } from './storage';
import { newId } from './ids';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Job = typeof mediaDeletions.$inferSelect;

/** Call within the same transaction that removes the corresponding database rows. */
export async function enqueueMediaDeletion(tx: Tx, ownerId: string, key: string, kind = 'media'): Promise<void> {
	await tx.insert(mediaDeletions).values({ id: newId(), ownerId, key, kind });
}

let draining = false;

/**
 * One item's folder (`<slug>/<id>`). Small and quick, and the one case where a writer
 * could still be about: a retried upload of the same item. So it is done under the
 * owner's lock, which uploads take to record a row, and skipped if a row for the item
 * exists again.
 */
async function removeItemFolder(job: Job): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${job.ownerId}))`);
		const [current] = await tx.select().from(mediaDeletions).where(eq(mediaDeletions.id, job.id)).for('update');
		if (!current) return;
		const [live] = await tx
			.select({ id: photos.id })
			.from(photos)
			.where(eq(photos.id, current.key.slice(current.key.lastIndexOf('/') + 1)));
		if (!live) await deleteMediaTree(current.key);
		await tx.delete(mediaDeletions).where(eq(mediaDeletions.id, job.id));
	});
}

/**
 * A whole album's folder, or an upload's staging folder. These can hold many gigabytes
 * and take a long time to remove, so no transaction and no lock is held meanwhile:
 * holding the owner's lock here made every upload to that owner's other albums fail
 * on the five-second lock timeout while a big album was being removed. Nothing can be
 * writing to either: the album (and every upload session in it) is gone from the
 * database, and its address is never used again. The job row is removed only after
 * the files are, so a crash in between simply repeats a harmless removal.
 */
async function removeTree(job: Job): Promise<void> {
	if (job.kind === 'upload') await cleanupUpload(job.key);
	else {
		// Never on the word of a stale row: an album that exists keeps its folder.
		const [live] = await db.select({ id: albums.id }).from(albums).where(eq(albums.slug, job.key));
		if (!live) await deleteMediaTree(job.key);
	}
	await db.delete(mediaDeletions).where(eq(mediaDeletions.id, job.id));
}

/** Never remove live files before commit. Failed or interrupted jobs remain retryable. */
export async function drainMediaDeletions(): Promise<void> {
	// A removal that outlasts the sweep interval must not be started a second time.
	if (draining) return;
	draining = true;
	try {
		const jobs = await db.select().from(mediaDeletions).orderBy(mediaDeletions.createdAt).limit(100);
		for (const job of jobs) {
			try {
				if (job.kind !== 'upload' && job.kind !== 'media') throw new Error('Unknown media deletion kind');
				if (job.kind === 'media' && job.key.includes('/')) await removeItemFolder(job);
				else await removeTree(job);
			} catch (cause) {
				console.error('[maintenance] media deletion retained for retry', { id: job.id, cause });
			}
		}
	} finally {
		draining = false;
	}
}
