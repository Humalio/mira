import { ensureMembership, getAlbum, getMembershipByUser, isAlbumOwner, memberFor } from '#lib/server/guard.js';
import { translator } from '#lib/i18n/index.js';
import { resolveTokens, tokensToStyle } from '#lib/theme/skins.js';
import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { rateLimit, requestAddress } from '#lib/server/rate-limit.js';

export const load: LayoutServerLoad = async ({ params, locals, request, getClientAddress }) => {
	// Per-device budget plus a generous per-IP ceiling: a whole wedding on one venue
	// Wi-Fi (or a mobile carrier's CGNAT) shares a single address. 60-bit slugs make
	// enumeration impractical; the IP ceiling only bounds a cookie-clearing scraper.
	rateLimit(`album-lookup:${locals.deviceToken}`, 120, 60_000);
	rateLimit(`album-lookup-ip:${requestAddress(request, getClientAddress)}`, 3_000, 60_000);
	const album = await getAlbum(params.slug);
	if (!album) throw error(404, translator(locals.locale)('srv.albumNotFound'));

	// Logged-in owners came from their album list and need a way back to it.
	const session = await locals.auth();

	// Prefer the caller's account identity (same user = one member across devices).
	let member = await memberFor(album.id, locals);
	if (member && session?.user && !member.userId) {
		member = await ensureMembership(album.id, locals.deviceToken, member.displayName, session.user.id);
	}
	if (!member && session?.user) {
		// A signed-in user already a member on another device is recognised here (no
		// duplicate); an owner opening their own album on a fresh device auto-joins.
		member =
			(await getMembershipByUser(album.id, session.user.id)) ??
			(album.ownerUserId === session.user.id
				? await ensureMembership(
						album.id,
						locals.deviceToken,
						session.user.name || session.user.email || 'Me',
						session.user.id
					)
				: undefined);
	}
	if (!member) throw redirect(303, `/j/${params.slug}`);

	const themeStyle = tokensToStyle(resolveTokens(album.skin, album.accent, locals.theme));
	const isOwner = await isAlbumOwner(album, locals);

	return {
		isUser: Boolean(session?.user),
		album: {
			id: album.id,
			slug: album.slug,
			name: album.name,
			skin: album.skin,
			accent: album.accent,
			videoQuality: album.videoQuality,
			autoApprove: album.autoApprove
		},
		member: { id: member.id, name: member.displayName },
		isOwner,
		themeStyle
	};
};
