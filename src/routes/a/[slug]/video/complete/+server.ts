import { db } from '#lib/server/db.js';
import { getAlbumById, memberFor } from '#lib/server/guard.js';
import { translator } from '#lib/i18n/index.js';
import { jsonObject, LIMITS, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { uploadSessions } from '#lib/server/schema.js';
import { cleanupUpload, deleteMediaItemDir } from '#lib/server/storage.js';
import { getUploadSession } from '#lib/server/uploads.js';
import { finalizeOutcomes, finalizeStages, startFinalization } from '#lib/server/video-finalize.js';
import { heardFromUpload } from '#lib/server/pulse.js';
import { error } from '@sveltejs/kit';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** Reassemble the staged chunks, optimize if the album asks, and record the video. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const t = translator(locals.locale);
	requireContentLength(request, LIMITS.jsonBytes);
	const body = jsonObject(await request.json().catch(() => null));
	let uploadId: string;
	try {
		uploadId = requiredUuid(body.uploadId, 'Upload id');
	} catch {
		throw error(400, t('srv.badCompletion'));
	}

	let session = await getUploadSession(uploadId);
	if (!session) throw error(404, t('srv.unknownUpload'));
	const album = await getAlbumById(session.albumId);
	if (!album || album.slug !== params.slug) throw error(404);
	if (session.deviceToken !== locals.deviceToken) throw error(403);
	heardFromUpload(uploadId); // still wanted: it may be waiting for a free finaliser
	// `pending` tells the uploader's page to say "waiting for approval", not "added".
	const done = (s: { mediaItemId: string | null; approved: boolean }) =>
		Response.json({ mediaItemId: s.mediaItemId, pending: !s.approved });
	if (session.state === 'complete' && session.mediaItemId) return done(session);
	const outcome = finalizeOutcomes.get(uploadId);
	if (outcome?.status === 'failed') throw error(outcome.httpStatus as Parameters<typeof error>[0], outcome.message);
	if (session.state === 'failed') throw error(500, t('srv.uploadIncomplete'));
	if (session.state === 'completing' && session.expiresAt.getTime() > Date.now()) {
		return Response.json({ status: 'processing', ...finalizeStages.get(uploadId) }, { status: 202 }); // poll again
	}
	if (session.expiresAt.getTime() <= Date.now()) {
		const expired = await db
			.update(uploadSessions)
			.set({ state: 'failed' })
			.where(
				and(
					eq(uploadSessions.id, uploadId),
					lte(uploadSessions.expiresAt, new Date()),
					inArray(uploadSessions.state, ['receiving', 'completing', 'failed'])
				)
			)
			.returning({ id: uploadSessions.id });
		if (expired[0]) {
			await cleanupUpload(uploadId).catch(() => {});
			await deleteMediaItemDir(album.slug, uploadId).catch(() => {});
		} else {
			const current = await getUploadSession(uploadId);
			if (current?.state === 'complete' && current.mediaItemId) return done(current);
		}
		throw error(410, t('srv.unknownUpload'));
	}
	const member = await memberFor(album.id, locals);
	if (!member || member.id !== session.memberId) throw error(403);

	// The work runs in the background (see startFinalization); the client polls this
	// endpoint (202 → 200).
	const started = await startFinalization(uploadId, t);
	if (started === 'started') return Response.json({ status: 'processing', phase: 'assembling' }, { status: 202 });
	if (started === 'busy' || started === 'later') {
		// Every finaliser is taken, or the last try failed for a reason that may pass.
		// The upload is kept and the server starts it by itself when it can, whether or
		// not this page is still open to ask.
		return Response.json({ status: 'waiting' }, { status: 202, headers: { 'retry-after': '3' } });
	}
	session = (await getUploadSession(uploadId)) ?? session;
	if (session.state === 'complete' && session.mediaItemId) return done(session);
	if (session.state === 'completing')
		return Response.json({ status: 'processing', ...finalizeStages.get(uploadId) }, { status: 202 });
	throw error(
		409,
		session.receivedBytes === session.declaredBytes ? 'Upload is already completing' : t('srv.uploadIncomplete')
	);
};
