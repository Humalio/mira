import { getAlbumOptions } from '#lib/server/album-options.js';
import { ensureMembership, getAlbum, isNameTaken, memberFor } from '#lib/server/guard.js';
import { translator } from '#lib/i18n/index.js';
import { resolveTokens, tokensToStyle } from '#lib/theme/skins.js';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { LIMITS, requireContentLength, requiredText } from '#lib/server/input.js';
import { rateLimit, requestAddress } from '#lib/server/rate-limit.js';
import { publicOrigin } from '#lib/server/origin.js';
import { invitationValid } from '#lib/server/invite.js';

export const load: PageServerLoad = async ({ params, locals, request, url, getClientAddress }) => {
	rateLimit(`album-lookup:${locals.deviceToken}`, 120, 60_000);
	rateLimit(`album-lookup-ip:${requestAddress(request, getClientAddress)}`, 3_000, 60_000);
	const album = await getAlbum(params.slug);
	if (!album) throw error(404, translator(locals.locale)('srv.albumNotFound'));
	// Already a member (by account or device)? Skip the join screen.
	if (await memberFor(album.id, locals)) throw redirect(303, `/a/${params.slug}`);

	return {
		albumName: album.name,
		// The owner replaced the invitation since this link was handed out.
		expired: !(await invitationValid(album.slug, url)),
		// For the preview a chat app builds when the link is pasted into it. Absolute
		// addresses, and a picture that shows nothing from the album.
		joinUrl: `${publicOrigin(url)}/j/${album.slug}${url.search}`,
		previewImage: `${publicOrigin(url)}/invite.png`,
		// Tell a guest the truth before they add anything: this album gives up original videos.
		videosReduced: album.videoQuality !== 'original' && (await getAlbumOptions(album.slug)).keepOnlyCopy,
		themeStyle: tokensToStyle(resolveTokens(album.skin, album.accent, locals.theme))
	};
};

export const actions: Actions = {
	default: async ({ params, request, locals, url, getClientAddress }) => {
		rateLimit(`join:${locals.deviceToken}`, 20, 60_000);
		rateLimit(`join-ip:${requestAddress(request, getClientAddress)}`, 300, 60_000);
		requireContentLength(request, LIMITS.formBytes);
		const album = await getAlbum(params.slug);
		if (!album) throw error(404);
		if (!(await invitationValid(album.slug, url))) throw error(403, translator(locals.locale)('join.expired.title'));
		const fd = await request.formData();
		let name: string;
		try {
			name = requiredText(fd.get('name'), 'Display name', LIMITS.displayName);
		} catch {
			return fail(400, { error: translator(locals.locale)('srv.enterName') });
		}

		// A name someone else already uses makes two people look identical in the album.
		// Say so once and let them adjust it; never block, since "join anyway" is one tap
		// and the album numbers namesakes apart.
		if (fd.get('confirm') !== '1' && (await isNameTaken(album.id, name))) {
			return fail(409, { nameTaken: true, name });
		}

		// Stamp the account when signed in, so this person is one member across devices.
		const userId = (await locals.auth())?.user?.id;
		await ensureMembership(album.id, locals.deviceToken, name, userId);
		return redirect(303, `/a/${params.slug}`);
	}
};
