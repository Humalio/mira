import { getAlbumById, getMembership, getMembershipByUser } from '#lib/server/guard.js';
import { LIMITS, requireContentLength } from '#lib/server/input.js';
import { rateLimit, requestAddress } from '#lib/server/rate-limit.js';
import { canReturn, returnLinkTarget, returnTokenValid, takePlace, tokenMemberId } from '#lib/server/return-link.js';
import { resolveTokens, tokensToStyle } from '#lib/theme/skins.js';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

/** The guest and album a return link is for, or null when the link is no longer good. */
async function resolve(token: string) {
	const memberId = tokenMemberId(token);
	if (!memberId) return null;
	const member = await returnLinkTarget(memberId);
	if (!member || !canReturn(member) || !returnTokenValid(token, member)) return null;
	const album = await getAlbumById(member.albumId);
	return album ? { member, album } : null;
}

/**
 * Is this browser already in the album with an account: the signed-in account's own
 * membership, or that of an account that used this browser before? It cannot be the
 * guest as well. The signed-in account's membership keeps winning (see memberFor), so
 * taking the guest's place would only use the link up: the guest's own device would be
 * forgotten and nobody here would become the guest. That is what happened to an owner
 * who opened a guest's link on their own laptop to try it. Refused instead, and the
 * link stays good for the guest.
 */
async function accountHere(albumId: string, locals: App.Locals): Promise<boolean> {
	const userId = (await locals.auth())?.user?.id;
	if (userId && (await getMembershipByUser(albumId, userId))) return true;
	return Boolean((await getMembership(albumId, locals.deviceToken))?.userId);
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
		accountHere: await accountHere(found.album.id, locals),
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
		if (!found) return fail(410, { gone: true });
		if (await accountHere(found.album.id, locals)) return fail(409, { accountHere: true });
		if (!(await takePlace(params.token, found.member.id, locals.deviceToken))) return fail(410, { gone: true });
		throw redirect(303, `/a/${found.album.slug}`);
	}
};
