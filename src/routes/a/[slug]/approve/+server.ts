import { db } from '#lib/server/db.js';
import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { translator } from '#lib/i18n/index.js';
import { photos } from '#lib/server/schema.js';
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { jsonObject, LIMITS, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';

/** Approve a pending upload — album owner only. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const t = translator(locals.locale);
	const { album } = await resolveAlbumMember(params.slug, locals);
	if (!(await isAlbumOwner(album, locals))) throw error(403, t('srv.ownerOnly'));
	rateLimit(`approve:${album.id}`, 60, 60_000);
	requireContentLength(request, LIMITS.jsonBytes);

	const { mediaItemId: rawMediaItemId } = jsonObject(await request.json().catch(() => null));
	const mediaItemId = requiredUuid(rawMediaItemId, 'Media item id');
	await db
		.update(photos)
		.set({ approved: true })
		.where(and(eq(photos.id, mediaItemId), eq(photos.albumId, album.id)));
	return Response.json({ ok: true });
};
