import { db } from '#lib/server/db.js';
import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { translator } from '#lib/i18n/index.js';
import { photos } from '#lib/server/schema.js';
import { enqueueMediaDeletion } from '#lib/server/media-deletions.js';
import { error } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { jsonObject, LIMITS, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';

/** Delete a photo/video — only the member who uploaded it may remove it. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const t = translator(locals.locale);
	const { album, member } = await resolveAlbumMember(params.slug, locals);
	rateLimit(`delete-media:${album.id}:${member.id}`, 30, 60_000);
	requireContentLength(request, LIMITS.jsonBytes);

	const { mediaItemId: rawMediaItemId } = jsonObject(await request.json().catch(() => null));
	const mediaItemId = requiredUuid(rawMediaItemId, 'Media item id');
	const mediaItem = (
		await db
			.select()
			.from(photos)
			.where(and(eq(photos.id, mediaItemId), eq(photos.albumId, album.id)))
			.limit(1)
	)[0];
	if (!mediaItem) throw error(404);
	if (mediaItem.memberId !== member.id && !(await isAlbumOwner(album, locals))) {
		throw error(403, t('srv.uploaderOrOwnerOnly'));
	}

	await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${album.ownerUserId}))`);
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`media:${mediaItem.id}`}))`);
		await tx.delete(photos).where(eq(photos.id, mediaItem.id));
		await enqueueMediaDeletion(tx, album.ownerUserId, `${album.slug}/${mediaItem.id}`);
	});
	return Response.json({ ok: true });
};
