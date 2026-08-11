/**
 * Turning a fully uploaded set of chunks into a video in the album: assemble the
 * original, make a playback copy if the album asks, make a thumbnail, record it. This
 * runs in the background. It is started by the uploader's "complete" request, by the
 * server itself for any upload that is fully received and has a free slot (see
 * `finalizeReady`: nobody has to keep a page open for a video that is waiting its turn),
 * or after a restart (see `resumeInterruptedFinalizations`).
 *
 * A failure that may pass (a full disk, a busy database) puts the upload back in the
 * queue with every chunk kept, and it is tried again later. Only a failure that trying
 * again cannot cure (over the storage limit, a missing chunk) discards the upload.
 */
import { error, isHttpError } from '@sveltejs/kit';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { translator } from '#lib/i18n/index.js';
import { admitWithinQuota } from './admin';
import { getAlbumOptions } from './album-options';
import { createWorkTracker } from './background';
import { createConcurrencyGate } from './concurrency';
import { db } from './db';
import { albums, photos, uploadSessions, type Album, type UploadSession } from './schema';
import {
	assembleUpload,
	cleanupUpload,
	deleteMediaItemDir,
	ensureMediaItemDir,
	mediaWritePath,
	readUploadName,
	reserveVideoSpace,
	saveOriginalName,
	storeVideoPlaceholder
} from './storage';
import { getSettings } from './users';
import { extForVideo, makePlaybackCopy, makeServerPoster, recordingDate, type PlaybackCopy } from './video';

/** How long a `completing` session stays protected from the expiry sweep between renewals. */
export const LEASE_MS = 30 * 60_000;

/** Two videos are put together at a time; a third waits for one of them to finish. */
const acquireFinalizer = createConcurrencyGate(2, 'Video processing is busy; retry shortly', { maxWaiting: 0 });

/** Every finalisation running in this process; a stopping server waits for them (see maintenance.ts). */
export const finalizations = createWorkTracker();

/** How long after its start an upload that keeps failing for passing reasons is still retried. */
export const RETRY_HORIZON_MS = 48 * 60 * 60_000;

/** The pause before retry number `attempt`: one minute, doubling, half an hour at most. */
export const retryDelayMs = (attempt: number): number =>
	Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, Math.min(attempt, 10) - 1));

/**
 * Uploads put back in the queue after a failure that may pass, and when each may be
 * tried again. In memory: a restart forgets the pauses and simply tries at once.
 */
export const finalizeRetries = new Map<string, { attempt: number; notBefore: number }>();

/** A failure that trying again cannot cure: the upload itself is wrong, or no longer wanted. */
class PermanentFailure extends Error {}

/**
 * Might the same finalisation succeed later? Yes unless the failure says something
 * about the upload itself: refused by a limit (4xx), a chunk that is not there, or a
 * row it belongs to that has been deleted (a foreign-key or other integrity error).
 * Everything else (no disk space right now, a lock or connection timeout, an
 * unexplained error) is worth another try, because the alternative is deleting a
 * video somebody finished uploading.
 */
export function worthRetrying(cause: unknown): boolean {
	if (cause instanceof PermanentFailure) return false;
	if (isHttpError(cause)) return cause.status >= 500;
	const code = (cause as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && (code === 'ENOENT' || code.startsWith('23'))) return false;
	return true;
}

/** Last outcome per upload, so a polling client sees the real failure reason (single node). */
export const finalizeOutcomes = new Map<
	string,
	{ status: 'complete' } | { status: 'failed'; httpStatus: number; message: string }
>();

/**
 * What the background job is doing right now, so the uploader's screen can say
 * "compressing, 40%" instead of sitting on a frozen bar for minutes (single node).
 */
export const finalizeStages = new Map<
	string,
	{ phase: 'assembling' | 'queued' | 'compressing' | 'saving'; percent?: number }
>();

/**
 * Run a claimed (`completing`) session to its end in the background and remember the
 * outcome for the polling client. Resolves when the work is over, whatever the result.
 */
export function runFinalization(session: UploadSession, album: Album, t: ReturnType<typeof translator>): Promise<void> {
	const uploadId = session.id;
	const t0 = Date.now();
	return finalizations.track(
		finalizeUpload(session, album, t)
			.then((result) => {
				// Put back in the queue: there is no outcome yet, the client keeps polling.
				if (result === 'requeued') return;
				finalizeRetries.delete(uploadId);
				finalizeOutcomes.set(uploadId, { status: 'complete' });
			})
			.catch((cause) => {
				const httpStatus = isHttpError(cause) ? cause.status : 500;
				const message = isHttpError(cause) ? cause.body.message : t('srv.uploadIncomplete');
				if (!isHttpError(cause)) console.error('[video] finalize failed', { uploadId, ms: Date.now() - t0, cause });
				finalizeRetries.delete(uploadId);
				finalizeOutcomes.set(uploadId, { status: 'failed', httpStatus, message });
			})
			.finally(() => {
				setTimeout(() => finalizeOutcomes.delete(uploadId), 60 * 60_000).unref();
			})
	);
}

export type FinalizationStart =
	/** Claimed; it now runs in the background. */
	| 'started'
	/** Every finaliser is taken (or the server is stopping). It starts by itself when one is free. */
	| 'busy'
	/** It failed a moment ago for a reason that may pass, and is waiting before the next try. */
	| 'later'
	/** Not a fully received upload waiting to be finalised (any more). */
	| 'not-ready';

/**
 * Claim a fully received upload and finalise it in the background, if a finaliser is
 * free. Safe to call for the same upload from anywhere at any time: the claim is one
 * conditional UPDATE, so exactly one caller wins.
 */
export async function startFinalization(
	uploadId: string,
	t: ReturnType<typeof translator> = translator('en')
): Promise<FinalizationStart> {
	if (!finalizations.accepting) return 'busy';
	if ((finalizeRetries.get(uploadId)?.notBefore ?? 0) > Date.now()) return 'later';
	let release: () => void;
	try {
		release = await acquireFinalizer();
	} catch (cause) {
		if (isHttpError(cause) && cause.status === 503) return 'busy';
		throw cause;
	}
	let handedOff = false;
	try {
		const [claimed] = await db
			.update(uploadSessions)
			.set({ state: 'completing', expiresAt: new Date(Date.now() + LEASE_MS) })
			.where(
				and(
					eq(uploadSessions.id, uploadId),
					eq(uploadSessions.state, 'receiving'),
					eq(uploadSessions.receivedBytes, uploadSessions.declaredBytes),
					gt(uploadSessions.expiresAt, new Date())
				)
			)
			.returning();
		if (!claimed) return 'not-ready';
		const [album] = await db.select().from(albums).where(eq(albums.id, claimed.albumId));
		if (!album) return 'not-ready'; // deleted this instant; the session went with it
		// Assembling up to 5 GB and compressing it (minutes to an hour) cannot live
		// inside one HTTP request: reverse proxies (Cloudflare: 100 s) cut it, the client
		// reports failure while the server later succeeds, and a retry got a 409. Run it
		// in the background and let the client poll (202 → 200).
		handedOff = true;
		void runFinalization(claimed, album, t)
			.finally(release)
			// A finaliser is free again: whoever was waiting for one goes next.
			.then(() => finalizeReady())
			.catch((cause) => console.error('[video] could not start the next waiting upload', cause));
		return 'started';
	} finally {
		if (!handedOff) release();
	}
}

/**
 * Start every fully received upload that is waiting for a finaliser, oldest first,
 * until the finalisers are all taken. Called when a finaliser becomes free and from
 * the maintenance sweep, so a video whose uploader closed the page (or whose phone
 * went to sleep) while it was waiting its turn is still finished.
 * Returns how many were started.
 */
export async function finalizeReady(): Promise<number> {
	if (!finalizations.accepting) return 0;
	const ready = await db
		.select({ id: uploadSessions.id })
		.from(uploadSessions)
		.where(
			and(
				eq(uploadSessions.state, 'receiving'),
				eq(uploadSessions.receivedBytes, uploadSessions.declaredBytes),
				gt(uploadSessions.expiresAt, new Date())
			)
		)
		.orderBy(asc(uploadSessions.createdAt), asc(uploadSessions.id))
		.limit(20);
	let started = 0;
	for (const { id } of ready) {
		const outcome = await startFinalization(id);
		if (outcome === 'busy') break;
		if (outcome === 'started') started++;
	}
	return started;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Put a claimed upload back in the queue after a failure that may pass. Its chunks
 * stay where they are; it is tried again after a pause that grows with each failure,
 * for at most `RETRY_HORIZON_MS` after the upload began (the expiry sweep removes it
 * then). Returns false when it is too old to retry or is no longer claimed.
 */
async function requeue(session: UploadSession, cause: unknown): Promise<boolean> {
	const keepUntil = session.createdAt.getTime() + RETRY_HORIZON_MS;
	if (keepUntil <= Date.now()) return false;
	for (let tries = 1; ; tries++) {
		try {
			const [back] = await db
				.update(uploadSessions)
				.set({ state: 'receiving', expiresAt: new Date(keepUntil) })
				.where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, 'completing')))
				.returning({ id: uploadSessions.id });
			if (!back) return false;
			break;
		} catch (failure) {
			// The database itself may be what failed. Give it a minute before giving up.
			if (tries >= 6) throw failure;
			await sleep(10_000);
		}
	}
	const attempt = (finalizeRetries.get(session.id)?.attempt ?? 0) + 1;
	const wait = retryDelayMs(attempt);
	finalizeRetries.set(session.id, { attempt, notBefore: Date.now() + wait });
	console.warn('[video] finalisation will be retried; the upload is kept', {
		uploadId: session.id,
		attempt,
		retryInSeconds: Math.round(wait / 1000),
		cause: isHttpError(cause) ? cause.body.message : String(cause)
	});
	setTimeout(() => {
		finalizeReady().catch((failure) => console.error('[video] retry could not be started', failure));
	}, wait + 1_000).unref();
	return true;
}

async function finalizeUpload(
	session: UploadSession,
	album: Album,
	t: ReturnType<typeof translator>
): Promise<'done' | 'requeued'> {
	const uploadId = session.id;

	const ext = extForVideo(session.mime);
	// Reuse the durable upload id so expiry cleanup can find crash-left partial output.
	const mediaItemId = uploadId;
	const storageKey = `${album.slug}/${mediaItemId}/orig.${ext}`;
	const thumbKey = `${album.slug}/${mediaItemId}/poster.webp`;
	const absPath = mediaWritePath(storageKey);

	let attemptedAdmission = false;
	let releaseSpace: (() => void) | undefined;
	// The claim gave this session a 30-minute lease; the expiry sweep treats a lapsed
	// `completing` session as crashed and deletes its files. A long video, or one
	// queued behind another encode, legitimately takes longer, so keep renewing the
	// lease for as long as this process is really working on it.
	const lease = setInterval(() => {
		db.update(uploadSessions)
			.set({ expiresAt: new Date(Date.now() + LEASE_MS) })
			.where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.state, 'completing')))
			.catch((cause) => console.error('[video] could not renew the finalisation lease', { uploadId, cause }));
	}, 60_000);
	try {
		finalizeStages.set(uploadId, { phase: 'assembling' });
		releaseSpace = await reserveVideoSpace(session.declaredBytes);
		await ensureMediaItemDir(album.slug, mediaItemId);
		await storeVideoPlaceholder(album.slug, mediaItemId);
		await saveOriginalName(album.slug, mediaItemId, await readUploadName(uploadId));
		const size = await assembleUpload(uploadId, session.totalChunks, absPath);
		if (size !== session.declaredBytes) throw new PermanentFailure('assembled size does not match upload manifest');

		// Re-check the per-file size cap against the bytes actually written; the quota
		// check happens atomically at insert time, on everything the video then occupies.
		const settings = await getSettings();
		const maxVideoBytes = settings.maxVideoMb * 1024 * 1024;
		if (size > maxVideoBytes) throw error(413, t('srv.videoTooLarge', { max: settings.maxVideoMb }));

		// When it was recorded, so it sorts into the timeline beside the photos taken
		// then and the viewer can say so. Null when the file does not state it.
		const recordedAt = await recordingDate(absPath);

		// The upload is the original and stays exactly as it arrived. If the album asks
		// for it, a smaller copy is made beside it for playback (see `originalKept`).
		let finalKey = storageKey;
		let finalMime = session.mime;
		let copy: PlaybackCopy | null = null;
		if (session.quality !== 'original') {
			copy = await makePlaybackCopy(album.slug, mediaItemId, absPath, size, session.quality, (stage) =>
				finalizeStages.set(uploadId, stage)
			);
		}
		if (copy && (await getAlbumOptions(album.slug)).keepOnlyCopy) {
			// The owner's explicit "Save space: keep only the small copy". From here the
			// copy is the item: downloads give it, and the lightbox says so.
			await rm(absPath, { force: true });
			finalKey = copy.key;
			finalMime = 'video/mp4';
		}
		// The copy, when the original is kept beside it (the normal case).
		const beside = copy && finalKey === storageKey ? copy : null;

		finalizeStages.set(uploadId, { phase: 'saving' });
		// A thumbnail that does not depend on the uploader's browser staying open. Taken
		// from the copy when there is one: it is H.264, which every ffmpeg build decodes.
		const poster = await makeServerPoster(album.slug, mediaItemId, mediaWritePath(copy?.key ?? finalKey));

		// Quota check + insert under a per-owner lock (see admitWithinQuota); the files
		// are already on disk, so if they don't fit we remove them and report over-limit.
		// `sizeBytes` counts every file the item keeps, so the owner's usage stays true.
		const record = (sizeBytes: number, optimized: boolean) =>
			admitWithinQuota(
				album,
				sizeBytes,
				async (tx) => {
					// Whose video this is NOW, not when the work began: while it was being
					// compressed, a return link may have folded its uploader into the guest
					// they really are (return-link.ts moves the session and deletes the
					// duplicate). The row lock makes that move wait for this insert, or this
					// insert see the move.
					const [current] = await tx
						.select({ memberId: uploadSessions.memberId, state: uploadSessions.state })
						.from(uploadSessions)
						.where(eq(uploadSessions.id, uploadId))
						.for('update');
					if (current?.state !== 'completing')
						throw new PermanentFailure('upload session disappeared during completion');
					await tx.insert(photos).values({
						id: mediaItemId,
						albumId: album.id,
						momentId: session.momentId,
						memberId: current.memberId,
						storageKey: finalKey,
						thumbKey,
						mime: finalMime,
						kind: 'video',
						approved: session.approved,
						sizeBytes,
						optimized,
						takenAt: recordedAt ? new Date(recordedAt) : null,
						width: poster?.width ?? null,
						height: poster?.height ?? null
					});
					const completed = await tx
						.update(uploadSessions)
						.set({ state: 'complete', mediaItemId, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) })
						.where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.state, 'completing')))
						.returning({ id: uploadSessions.id });
					if (!completed[0]) throw new PermanentFailure('upload session disappeared during completion');
				},
				uploadId
			);
		attemptedAdmission = true;
		let admitted = await record(beside ? size + beside.size : (copy?.size ?? size), copy !== null);
		if (!admitted && beside) {
			// Original plus copy is over the owner's limit, but the original alone may fit.
			// The original is what people came for, so give up the convenience copy first.
			await rm(mediaWritePath(beside.key), { force: true });
			admitted = await record(size, false);
		}
		if (!admitted) throw error(413, t('srv.storageLimit'));
	} catch (cause) {
		if (attemptedAdmission) {
			try {
				const [recorded] = await db.select({ id: photos.id }).from(photos).where(eq(photos.id, mediaItemId));
				if (recorded) {
					await cleanupUpload(uploadId).catch(() => {});
					return 'done';
				}
			} catch {
				console.error('[video] database status unknown; media retained', { mediaItemId });
				throw error(503, 'Completion status unknown; retry after the database recovers');
			}
		}
		// Whatever was assembled or encoded so far can be made again from the chunks.
		await deleteMediaItemDir(album.slug, mediaItemId).catch(() => {});
		if (worthRetrying(cause) && (await requeue(session, cause))) return 'requeued';
		await db
			.update(uploadSessions)
			.set({ state: 'failed' })
			.where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.state, 'completing')));
		await cleanupUpload(uploadId).catch(() => {});
		throw cause;
	} finally {
		clearInterval(lease);
		finalizeStages.delete(uploadId);
		releaseSpace?.();
	}
	await cleanupUpload(uploadId).catch(() => {});
	return 'done';
}

/**
 * At startup of the single instance, a session still `completing` belonged to a process
 * that died mid-finalisation (a restart or a deploy during compression). Its photo row
 * was never written, because that row and the `complete` state commit together, but
 * every uploaded chunk is still on disk. So do not make the person send a gigabyte
 * again: clear the half-written output and run the finalisation from the start, one
 * video at a time. The uploader may have closed the page long ago; nothing here needs
 * them. Sessions that cannot be resumed are failed, so a polling client gets an answer.
 * Returns how many were resumed and failed; the resumed work continues in the background.
 */
export async function resumeInterruptedFinalizations(): Promise<{
	resumed: number;
	failed: number;
	done: Promise<void>;
}> {
	const stuck = await db.select().from(uploadSessions).where(eq(uploadSessions.state, 'completing'));
	const resumable: { session: UploadSession; album: Album }[] = [];
	let failed = 0;
	for (const session of stuck) {
		try {
			const [album] = await db.select().from(albums).where(eq(albums.id, session.albumId));
			// Remove whatever the dead process left behind, in either case.
			if (album) await deleteMediaItemDir(album.slug, session.id);
			if (album && session.receivedBytes === session.declaredBytes) {
				const [renewed] = await db
					.update(uploadSessions)
					.set({ expiresAt: new Date(Date.now() + LEASE_MS) })
					.where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, 'completing')))
					.returning();
				if (renewed) resumable.push({ session: renewed, album });
				continue;
			}
			await db
				.update(uploadSessions)
				.set({ state: 'failed' })
				.where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, 'completing')));
			await cleanupUpload(session.id);
			failed++;
		} catch (cause) {
			console.error('[uploads] interrupted finalisation could not be recovered; expiry sweep will retry', {
				uploadId: session.id,
				cause
			});
		}
	}
	if (resumable.length || failed)
		console.warn('[uploads] finalisations interrupted by the previous shutdown', { resumed: resumable.length, failed });
	const t = translator('en'); // nobody is necessarily watching; messages only reach a polling client
	// Each running finalisation renews its own lease; this covers the ones still waiting
	// their turn, which could otherwise lapse behind a long encode and be swept away.
	const waiting = new Set(resumable.map(({ session }) => session.id));
	const keepWaitingAlive = setInterval(() => {
		if (!waiting.size) return;
		db.update(uploadSessions)
			.set({ expiresAt: new Date(Date.now() + LEASE_MS) })
			.where(and(inArray(uploadSessions.id, [...waiting]), eq(uploadSessions.state, 'completing')))
			.catch((cause) => console.error('[uploads] could not renew waiting finalisation leases', cause));
	}, 60_000);
	const done = (async () => {
		try {
			for (const { session, album } of resumable) {
				// The server is stopping: leave the rest claimed, the next start resumes them.
				if (!finalizations.accepting) break;
				waiting.delete(session.id);
				await runFinalization(session, album, t);
			}
		} finally {
			clearInterval(keepWaitingAlive);
		}
	})();
	return { resumed: resumable.length, failed, done };
}
