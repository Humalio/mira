import { createHash } from 'node:crypto';
import { admitWithinQuota } from '#lib/server/admin.js';
import { db } from '#lib/server/db.js';
import { getAlbumById, memberFor } from '#lib/server/guard.js';
import { translator } from '#lib/i18n/index.js';
import { LIMITS, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { uploadChunks, uploadSessions } from '#lib/server/schema.js';
import { readChunk, writeChunk } from '#lib/server/storage.js';
import { UPLOAD_TTL_MS, getUploadSession, isUnderWay } from '#lib/server/uploads.js';
import { error } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { acquireVideoChunk } from '#lib/server/concurrency.js';
import { heardFromUpload } from '#lib/server/pulse.js';

export const POST: RequestHandler = async ({ params, request, url, locals }) => {
	const t = translator(locals.locale);
	const uploadId = requiredUuid(url.searchParams.get('uploadId'), 'Upload id');
	const index = Number(url.searchParams.get('index') || NaN);
	if (!Number.isInteger(index) || index < 0) throw error(400, 'Invalid chunk');

	const session = await getUploadSession(uploadId);
	if (!session) throw error(404, 'Unknown upload');
	const album = await getAlbumById(session.albumId);
	if (!album || album.slug !== params.slug) throw error(404);
	if (session.deviceToken !== locals.deviceToken) throw error(403);
	// The device token alone is not enough: a browser keeps it after its account signs
	// out, and the next person to use that browser must not be able to touch the
	// account's uploads. The same membership the upload was started under is required.
	const member = await memberFor(album.id, locals);
	if (!member || member.id !== session.memberId) throw error(403);
	if (session.state !== 'receiving' || session.expiresAt <= new Date())
		throw error(409, 'Upload is not receiving chunks');
	if (index >= session.totalChunks) throw error(400, 'Chunk index is outside the upload');
	rateLimit(`video-chunk:${session.id}`, Math.min(session.totalChunks * 2 + 10, 1000), 60 * 60_000); // headroom for retries

	const expected =
		index === session.totalChunks - 1 ? session.declaredBytes - index * session.chunkSize : session.chunkSize;
	if (expected <= 0 || expected > LIMITS.chunkBytes) throw error(400, 'Invalid expected chunk size');
	requireContentLength(request, expected);
	heardFromUpload(uploadId);
	// The body is read before a slot is taken: a phone on slow Wi-Fi can take minutes to
	// send 12 MB, and holding a slot all that time left everyone else with 503s. Its size
	// is bounded by the Content-Length check above.
	const buf = Buffer.from(await request.arrayBuffer());
	if (buf.byteLength !== expected) throw error(400, 'Chunk size does not match the upload manifest');
	const release = await acquireVideoChunk();
	try {
		const digest = createHash('sha256').update(buf).digest('hex');
		// An upload that went quiet gave back the space it had not used yet (see
		// uploadUnderWay), and another upload may have been let in there since. Coming back,
		// it is admitted again, under the owner's lock as at the start, before it holds its
		// full size once more; letting it simply take that space back promised the same
		// bytes twice, and one of the two videos then failed at the very end, after
		// gigabytes had been sent. If it no longer fits, it is told now, with the same
		// answer the start of an upload gets.
		if (session.receivedBytes < session.declaredBytes && !isUnderWay(session)) {
			const admitted = await admitWithinQuota(
				album,
				session.declaredBytes,
				async (tx) => {
					const [current] = await tx
						.select({ state: uploadSessions.state, expiresAt: uploadSessions.expiresAt })
						.from(uploadSessions)
						.where(eq(uploadSessions.id, uploadId))
						.for('update');
					if (!current || current.state !== 'receiving' || current.expiresAt <= new Date())
						throw error(409, 'Upload is not receiving chunks');
					await tx
						.update(uploadSessions)
						.set({ expiresAt: new Date(Date.now() + UPLOAD_TTL_MS) })
						.where(eq(uploadSessions.id, uploadId));
				},
				uploadId
			);
			if (!admitted) throw error(413, t('srv.storageLimit'));
		}
		await db.transaction(async (tx) => {
			const [current] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, uploadId)).for('update');
			if (!current || current.state !== 'receiving' || current.expiresAt <= new Date())
				throw error(409, 'Upload is not receiving chunks');
			// It went quiet in the moment since it was looked at above: have it come back
			// through the admission (the client resends a chunk after a 503).
			if (current.receivedBytes < current.declaredBytes && !isUnderWay(current))
				throw error(503, 'Upload was paused; send this chunk again');
			const [receipt] = await tx
				.select()
				.from(uploadChunks)
				.where(and(eq(uploadChunks.uploadId, uploadId), eq(uploadChunks.index, index)));
			if (receipt && (receipt.digest !== digest || receipt.bytes !== buf.length))
				throw error(409, 'Chunk contents differ');
			if (!(await writeChunk(uploadId, index, buf))) {
				const existing = await readChunk(uploadId, index);
				if (!existing.equals(buf)) throw error(409, 'Chunk contents differ');
			}
			// Every chunk, a repeated one included, shows the upload is alive: keep it for
			// another full period (limits read the same clock; see uploads.ts).
			const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
			if (receipt) {
				await tx.update(uploadSessions).set({ expiresAt }).where(eq(uploadSessions.id, uploadId));
				return;
			}
			if (current.receivedBytes + buf.length > current.declaredBytes) throw error(409, 'Upload accounting rejected');
			await tx.insert(uploadChunks).values({ uploadId, index, bytes: buf.length, digest });
			await tx
				.update(uploadSessions)
				.set({ receivedBytes: sql`${uploadSessions.receivedBytes} + ${buf.length}`, expiresAt })
				.where(eq(uploadSessions.id, uploadId));
		});
		// Retain immutable bytes on SQL failure: a retry repairs a missing receipt,
		// or recognizes one committed before its acknowledgement was lost.
		heardFromUpload(uploadId);
		return Response.json({ ok: true });
	} finally {
		release();
	}
};
