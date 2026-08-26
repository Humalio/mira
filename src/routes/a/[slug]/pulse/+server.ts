import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { albumStamp, preparingVideos } from '#lib/server/pulse.js';
import { rateLimit } from '#lib/server/rate-limit.js';

import type { RequestHandler } from './$types';

/**
 * The open album page asks this every few seconds while its tab is visible: has
 * anything changed (then it reloads its data), and which videos are on their way.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { album, member } = await resolveAlbumMember(params.slug, locals);
	// The page asks every 4 to 10 seconds; this only stops a runaway client.
	rateLimit(`pulse:${album.id}:${member.id}`, 60, 60_000);
	const viewer = { memberId: member.id, isOwner: await isAlbumOwner(album, locals) };
	const [stamp, preparing] = await Promise.all([albumStamp(album, viewer), preparingVideos(album.id, viewer)]);
	return Response.json({ stamp, preparing }, { headers: { 'cache-control': 'private, no-store' } });
};
