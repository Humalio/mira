import { db } from '#lib/server/db.js';
import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { translator } from '#lib/i18n/index.js';
import { photos } from '#lib/server/schema.js';
import { renderPoster, writePoster } from '#lib/server/storage.js';
import { error } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { LIMITS, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { acquireImageProcessing } from '#lib/server/concurrency.js';

/** Attaches a client-generated poster (WebP frame) to an already-uploaded video. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const t = translator(locals.locale);
	const { album, member } = await resolveAlbumMember(params.slug, locals);
	rateLimit(`poster:${album.id}:${member.id}`, 20, 60_000);
	requireContentLength(request, LIMITS.posterBytes + 512 * 1024);

	const fd = await request.formData();
	const mediaItemId = requiredUuid(fd.get('mediaItemId'), 'Media item id');
	const file = fd.get('poster');
	if (!(file instanceof File) || file.size === 0) throw error(400, t('srv.noPoster'));
	if (file.size > LIMITS.posterBytes) throw error(413, 'Poster is too large');

	const ph = (
		await db
			.select({ id: photos.id, memberId: photos.memberId, kind: photos.kind })
			.from(photos)
			.where(and(eq(photos.id, mediaItemId), eq(photos.albumId, album.id)))
			.limit(1)
	)[0];
	if (!ph) throw error(404);
	if (ph.kind !== 'video') throw error(400, t('srv.posterVideosOnly'));
	if (ph.memberId !== member.id && !(await isAlbumOwner(album, locals))) throw error(403);

	// CPU-bound sharp work runs OUTSIDE any transaction. Holding the owner-wide
	// advisory lock (and a pooled connection) across image processing stalled every
	// concurrent upload/delete for that owner and tripped lock_timeout (5 s) into 500s.
	let rendered: Awaited<ReturnType<typeof renderPoster>>;
	const release = await acquireImageProcessing();
	try {
		rendered = await renderPoster(Buffer.from(await file.arrayBuffer()));
	} catch {
		// A malformed frame is a client problem, not a server error — a missing poster
		// just means the video shows no thumbnail, so fail soft rather than 500.
		throw error(400, t('srv.invalidPoster'));
	} finally {
		release();
	}

	// Only the per-item lock (serializes with delete's stage/restore) is needed, and
	// only around a millisecond-scale file swap + one UPDATE.
	await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`media:${ph.id}`}))`);
		const [current] = await tx.select({ id: photos.id }).from(photos).where(eq(photos.id, ph.id)).for('update');
		if (!current) throw error(404);
		const thumbKey = await writePoster(album.slug, mediaItemId, rendered.thumb);
		await tx
			.update(photos)
			.set({ thumbKey, width: rendered.width, height: rendered.height })
			.where(eq(photos.id, ph.id));
	});
	return Response.json({ ok: true });
};
