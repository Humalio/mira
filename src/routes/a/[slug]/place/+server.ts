import { db } from '#lib/server/db.js';
import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { requiredUuid } from '#lib/server/input.js';
import { placeOf } from '#lib/server/place.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { photos } from '#lib/server/schema.js';
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** Where an item was taken, for the viewer's caption. Same visibility as the item itself. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const { album, member } = await resolveAlbumMember(params.slug, locals);
	rateLimit(`place:${album.id}:${member.id}`, 240, 60_000);
	const id = requiredUuid(url.searchParams.get('id'), 'Media item id');
	const [item] = await db
		.select({
			id: photos.id,
			kind: photos.kind,
			storageKey: photos.storageKey,
			approved: photos.approved,
			memberId: photos.memberId
		})
		.from(photos)
		.where(and(eq(photos.id, id), eq(photos.albumId, album.id)))
		.limit(1);
	if (!item) throw error(404);
	if (!item.approved && item.memberId !== member.id && !(await isAlbumOwner(album, locals))) throw error(404);
	// The file never changes, so neither does the answer.
	return Response.json({ place: await placeOf(item) }, { headers: { 'cache-control': 'private, max-age=86400' } });
};
