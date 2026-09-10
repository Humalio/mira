import { db } from '#lib/server/db.js';
import { getAlbumById } from '#lib/server/guard.js';
import { LIMITS, requireContentLength } from '#lib/server/input.js';
import { rateLimit, requestAddress } from '#lib/server/rate-limit.js';
import { canReturn, returnTokenValid, takePlace, tokenMemberId } from '#lib/server/return-link.js';
import { members } from '#lib/server/schema.js';
import { resolveTokens, tokensToStyle } from '#lib/theme/skins.js';
import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

/** The guest and album a return link is for, or null when the link is no longer good. */
async function resolve(token: string) {
	const memberId = tokenMemberId(token);
	if (!memberId) return null;
	const [member] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
	if (!member || !canReturn(member) || !returnTokenValid(token, member)) return null;
	const album = await getAlbumById(member.albumId);
	return album ? { member, album } : null;
}

export const load: PageServerLoad = async ({ params, locals, request, getClientAddress }) => {
	rateLimit(`return:${locals.deviceToken}`, 30, 60_000);
	rateLimit(`return-ip:${requestAddress(request, getClientAddress)}`, 300, 60_000);
	const found = await resolve(params.token);
	// Opening the link changes nothing: chat apps fetch links to preview them, and a
	// one-time link must not be used up by a preview. The person confirms below.
	if (!found) return { valid: false as const };
	return {
		valid: true as const,
		albumName: found.album.name,
		memberName: found.member.displayName,
		themeStyle: tokensToStyle(resolveTokens(found.album.skin, found.album.accent, locals.theme))
	};
};

export const actions: Actions = {
	default: async ({ params, request, locals, getClientAddress }) => {
		rateLimit(`return:${locals.deviceToken}`, 30, 60_000);
		rateLimit(`return-ip:${requestAddress(request, getClientAddress)}`, 300, 60_000);
		requireContentLength(request, LIMITS.formBytes);
		const found = await resolve(params.token);
		if (!found || !(await takePlace(params.token, found.member.id, locals.deviceToken)))
			return fail(410, { gone: true });
		throw redirect(303, `/a/${found.album.slug}`);
	}
};
