import { db } from '#lib/server/db.js';
import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { jsonObject, LIMITS, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { favorites, photos } from '#lib/server/schema.js';
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const { album, member } = await resolveAlbumMember(params.slug, locals);
	rateLimit(`favorite:${album.id}:${member.id}`, 120, 60_000);
	requireContentLength(request, LIMITS.jsonBytes);

	const { mediaItemId: rawMediaItemId, favorited } = jsonObject(await request.json().catch(() => null));
	const mediaItemId = requiredUuid(rawMediaItemId, 'Media item id');
	if (typeof favorited !== 'boolean') throw error(400, 'favorited must be a boolean');
	const mediaItem = (
		await db
			.select({ id: photos.id, approved: photos.approved, memberId: photos.memberId })
			.from(photos)
			.where(and(eq(photos.id, mediaItemId), eq(photos.albumId, album.id)))
			.limit(1)
	)[0];
	if (!mediaItem) throw error(404);
	if (!mediaItem.approved && mediaItem.memberId !== member.id && !(await isAlbumOwner(album, locals))) throw error(404);

	if (!favorited) {
		await db.delete(favorites).where(and(eq(favorites.memberId, member.id), eq(favorites.photoId, mediaItem.id)));
		return Response.json({ favorited: false });
	}
	try {
		await db.insert(favorites).values({ memberId: member.id, photoId: mediaItem.id }).onConflictDoNothing();
	} catch (cause) {
		// The media item may have been deleted after the visibility check.
		if ((cause as { code?: string })?.code === '23503') throw error(404);
		throw cause;
	}
	return Response.json({ favorited: true });
};
