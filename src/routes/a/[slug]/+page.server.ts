import { db } from '#lib/server/db.js';
import { newId } from '#lib/server/ids.js';
import { getAlbum, isAlbumOwner, memberFor } from '#lib/server/guard.js';
import { LIMITS, requireContentLength, requiredText, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { translator } from '#lib/i18n/index.js';
import { distinctNames } from '#lib/names.js';
import { albums, favorites, members, moments, photos } from '#lib/server/schema.js';
import { getAlbumOptions, saveAlbumOptions, settingsUnavailable } from '#lib/server/album-options.js';
import { inviteUrl, resetInvitation } from '#lib/server/invite.js';
import { OWNER_ISSUED_MS, SELF_ISSUED_MS, canReturn, returnToken } from '#lib/server/return-link.js';
import { albumStamp, preparingVideos } from '#lib/server/pulse.js';
import { mediaAbsPath } from '#lib/server/storage.js';
import { publicOrigin } from '#lib/server/origin.js';
import { originalKept, playbackKey } from '#lib/server/video.js';
import { SKINS } from '#lib/theme/skins.js';
import { error, fail } from '@sveltejs/kit';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { stat } from 'node:fs/promises';
import QRCode from 'qrcode';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url }) => {
	const { album, member, isOwner } = await parent();
	const pageSize = 200;
	// Taken BEFORE the data below is read: if something changes while this load runs,
	// the page's next check sees a different stamp and reloads, instead of missing it.
	const viewer = { memberId: member.id, isOwner };
	const stamp = await albumStamp(album, viewer);
	const visibleMedia = isOwner
		? eq(photos.albumId, album.id)
		: and(eq(photos.albumId, album.id), or(eq(photos.approved, true), eq(photos.memberId, member.id)));
	const [summary] = await db
		.select({
			total: sql<number>`count(*)::int`,
			pending: sql<number>`count(*) filter (where not ${photos.approved})::int`
		})
		.from(photos)
		.where(visibleMedia);
	const lastPage = Math.max(1, Math.ceil((summary?.total ?? 0) / pageSize));
	const requestedPage = Number(url.searchParams.get('page'));
	const mediaPage =
		Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 1000
			? Math.min(requestedPage, lastPage)
			: lastPage;

	// Join link plus a QR encoding it.
	const joinUrl = await inviteUrl(album.slug, url);
	const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 240 });

	const momentRows = await db
		.select()
		.from(moments)
		.where(eq(moments.albumId, album.id))
		.orderBy(asc(moments.position), asc(moments.createdAt));

	const pageRows = await db
		.select({
			id: photos.id,
			momentId: photos.momentId,
			memberId: photos.memberId,
			storageKey: photos.storageKey,
			thumbKey: photos.thumbKey,
			width: photos.width,
			height: photos.height,
			takenAt: photos.takenAt,
			createdAt: photos.createdAt,
			by: members.displayName,
			kind: photos.kind,
			approved: photos.approved,
			sizeBytes: photos.sizeBytes,
			optimized: photos.optimized
		})
		.from(photos)
		.innerJoin(members, eq(photos.memberId, members.id))
		.where(visibleMedia)
		.orderBy(asc(sql`coalesce(${photos.takenAt}, ${photos.createdAt})`), asc(photos.id))
		.limit(pageSize + 1)
		.offset((mediaPage - 1) * pageSize);
	const hasNextPage = pageRows.length > pageSize;
	const photoRows = pageRows.slice(0, pageSize);
	const pagePhotoIds = photoRows.map((row) => row.id);

	const favoriteRows = pagePhotoIds.length
		? await db
				.select({ mediaItemId: favorites.photoId })
				.from(favorites)
				.where(and(eq(favorites.memberId, member.id), inArray(favorites.photoId, pagePhotoIds)))
		: [];
	const favoriteSet = new Set(favoriteRows.map((row) => row.mediaItemId));

	// Total favorites per photo across all members.
	const likeRows = pagePhotoIds.length
		? await db
				.select({ mediaItemId: favorites.photoId, count: sql<number>`count(*)::int` })
				.from(favorites)
				.where(inArray(favorites.photoId, pagePhotoIds))
				.groupBy(favorites.photoId)
		: [];
	const favoriteTotals = new Map(likeRows.map((row) => [row.mediaItemId, Number(row.count)]));

	const memberRows = await db
		.select({
			id: members.id,
			name: members.displayName,
			userId: members.userId,
			deviceToken: members.deviceToken
		})
		.from(members)
		.where(eq(members.albumId, album.id))
		.orderBy(asc(members.createdAt), asc(members.id));
	// Two guests may have picked the same name; number the later ones so every list
	// and caption can tell them apart ("Zoe", "Zoe (2)").
	const memberLabels = distinctNames(memberRows);
	const memberCountRows = await db
		.select({ memberId: photos.memberId, c: sql<number>`count(*)::int` })
		.from(photos)
		.where(visibleMedia)
		.groupBy(photos.memberId);
	const counts = new Map(memberCountRows.map((row) => [row.memberId, row.c]));
	const momentCountRows = await db
		.select({ momentId: photos.momentId, c: sql<number>`count(*)::int` })
		.from(photos)
		.where(visibleMedia)
		.groupBy(photos.momentId);
	const momentCounts = new Map(momentCountRows.map((row) => [row.momentId, row.c]));
	const options = await getAlbumOptions(album.slug);
	// Does anything here exist in two sizes? Then the download sheet offers the choice.
	const [twoSizes] = await db
		.select({ id: photos.id })
		.from(photos)
		.where(
			and(
				visibleMedia,
				eq(photos.kind, 'video'),
				eq(photos.optimized, true),
				sql`${photos.storageKey} not like '%/opt.mp4'`
			)
		)
		.limit(1);
	const [favoriteSummary] = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(favorites)
		.innerJoin(photos, eq(favorites.photoId, photos.id))
		.where(and(eq(favorites.memberId, member.id), visibleMedia));

	// A video that keeps its original AND a playback copy records their combined size
	// (that is what the owner's storage is charged). The viewer shows the two apart, so
	// measure the copy; the original is the rest.
	const copySizes = new Map<string, number>();
	await Promise.all(
		photoRows.map(async (p) => {
			const key = playbackKey(p);
			const abs = key && mediaAbsPath(key);
			if (!abs) return;
			const info = await stat(abs).catch(() => null);
			if (info) copySizes.set(p.id, info.size);
		})
	);

	type MediaItem = {
		id: string;
		by: string;
		memberId: string;
		favorited: boolean;
		thumb: string;
		/** What the viewer shows: the photo itself, or a video's playback copy if it has one. */
		full: string;
		/** The file as it was uploaded (for a reduced video, the only file there is). */
		download: string;
		/** The playback copy as a download, for someone who prefers the small file. */
		downloadCopy: string;
		width: number | null;
		height: number | null;
		kind: string;
		likes: number;
		approved: boolean;
		/** Size of the file `download` gives. */
		sizeBytes: number;
		/** Size of the playback copy when the video plays from one; otherwise null. */
		copyBytes: number | null;
		/** True for a video whose original was not kept: only a compressed copy exists. */
		reduced: boolean;
		/** When it was taken, if the file says so; see `whenTaken`. */
		taken: { wall: string } | { at: string } | null;
		addedAt: string;
	};
	// A photo's EXIF time has no time zone: it is the clock on the camera. It was read
	// in this server's zone, so reading it back in the same zone returns exactly the
	// digits the camera wrote, wherever the server and the viewer are. A video's
	// container time is a real instant (UTC), which the viewer shows in their own zone.
	const two = (n: number) => String(n).padStart(2, '0');
	const whenTaken = (kind: string, at: Date | null): MediaItem['taken'] =>
		!at
			? null
			: kind === 'video'
				? { at: at.toISOString() }
				: {
						wall: `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`
					};
	const byMoment = new Map<string, MediaItem[]>(momentRows.map((m) => [m.id, []]));
	for (const p of photoRows) {
		const favorited = favoriteSet.has(p.id);
		const item = {
			id: p.id,
			by: memberLabels.get(p.memberId) ?? p.by,
			memberId: p.memberId,
			favorited,
			thumb: `/media/${p.id}/preview`,
			full: `/media/${p.id}/${p.kind === 'video' ? 'play' : 'original'}`,
			download: `/media/${p.id}/original?download`,
			downloadCopy: `/media/${p.id}/play?download`,
			width: p.width,
			height: p.height,
			kind: p.kind,
			likes: favoriteTotals.get(p.id) ?? 0,
			approved: p.approved,
			sizeBytes: p.sizeBytes - (copySizes.get(p.id) ?? 0),
			copyBytes: copySizes.get(p.id) ?? null,
			reduced: !originalKept(p),
			taken: whenTaken(p.kind, p.takenAt),
			addedAt: p.createdAt.toISOString()
		};
		byMoment.get(p.momentId)?.push(item);
	}

	return {
		slug: album.slug,
		albumName: album.name,
		joinUrl,
		qr,
		skin: album.skin,
		accent: album.accent,
		// Said to the person adding a video, before they add it.
		videosReduced: album.videoQuality !== 'original' && options.keepOnlyCopy,
		videosInTwoSizes: Boolean(twoSizes),
		// Closed by its owner: nothing new can be added; looking and downloading still work.
		locked: options.locked,
		moments: momentRows.map((m) => ({
			id: m.id,
			name: m.name,
			count: momentCounts.get(m.id) ?? 0,
			photos: byMoment.get(m.id) ?? []
		})),
		people: memberRows.map((mr) => ({
			id: mr.id,
			name: memberLabels.get(mr.id) ?? mr.name,
			count: counts.get(mr.id) ?? 0,
			// A guest (no account) can be let back in on a new device; see return-link.ts.
			guest: canReturn(mr)
		})),
		stamp,
		// Videos still uploading or being compressed, so nobody stares at an album that
		// looks unchanged while a friend's clip is on its way.
		preparing: await preparingVideos(album.id, viewer),
		totalItems: summary?.total ?? 0,
		favoriteCount: favoriteSummary?.total ?? 0,
		pendingCount: summary?.pending ?? 0,
		mediaPage,
		hasPreviousPage: mediaPage > 1,
		hasNextPage,
		isOwner
	};
};

export const actions: Actions = {
	/** Close or reopen the album (owner). Closed: nothing new can be added. */
	setLocked: async ({ request, params, locals }) => {
		const album = await getAlbum(params.slug);
		if (!album) throw error(404);
		if (!(await isAlbumOwner(album, locals))) throw error(403, translator(locals.locale)('srv.ownerOnly'));
		rateLimit(`album-lock:${album.id}`, 30, 60_000);
		requireContentLength(request, LIMITS.formBytes);
		const locked = (await request.formData()).get('locked') === '1';
		await saveAlbumOptions(album.slug, { locked }).catch(
			settingsUnavailable(translator(locals.locale)('srv.albumSettingsUnreadable'))
		);
		return { ok: true, locked };
	},

	/** Replace the invitation link (owner): the old link and QR code stop letting people in. */
	resetInvite: async ({ request, params, locals }) => {
		const album = await getAlbum(params.slug);
		if (!album) throw error(404);
		if (!(await isAlbumOwner(album, locals))) throw error(403, translator(locals.locale)('srv.ownerOnly'));
		rateLimit(`album-invite-reset:${album.id}`, 10, 60 * 60_000);
		requireContentLength(request, LIMITS.formBytes);
		await resetInvitation(album.slug).catch(
			settingsUnavailable(translator(locals.locale)('srv.albumSettingsUnreadable'))
		);
		return { ok: true };
	},

	/**
	 * A one-time link that moves a guest to another device: issued by the owner for a
	 * guest who lost their place, or by a guest for themselves.
	 */
	returnLink: async ({ request, params, locals, url }) => {
		const album = await getAlbum(params.slug);
		if (!album) throw error(404);
		const caller = await memberFor(album.id, locals);
		if (!caller) throw error(403);
		rateLimit(`return-link:${album.id}:${caller.id}`, 20, 60 * 60_000);
		requireContentLength(request, LIMITS.formBytes);
		const memberId = requiredUuid((await request.formData()).get('memberId'), 'Member id');
		const self = memberId === caller.id;
		if (!self && !(await isAlbumOwner(album, locals))) throw error(403, translator(locals.locale)('srv.ownerOnly'));
		const [target] = await db
			.select()
			.from(members)
			.where(and(eq(members.id, memberId), eq(members.albumId, album.id)));
		if (!target || !canReturn(target)) throw error(400, translator(locals.locale)('srv.returnGuestsOnly'));
		const link = `${publicOrigin(url)}/r/${returnToken(target, self ? SELF_ISSUED_MS : OWNER_ISSUED_MS)}`;
		return {
			ok: true,
			returnLink: { link, self, memberId, qr: await QRCode.toDataURL(link, { margin: 1, width: 240 }) }
		};
	},

	createMoment: async ({ request, params, locals }) => {
		// getAlbum() (not a raw slug lookup) so a taken-down album is refused here too —
		// form actions don't run the layout load, so its 404 guard never fires for them.
		const album = await getAlbum(params.slug);
		if (!album) throw error(404);
		const member = await memberFor(album.id, locals);
		if (!member) throw error(403);
		rateLimit(`moment-create:${album.id}:${member.id}`, 20, 60_000);
		requireContentLength(request, LIMITS.formBytes);
		if ((await getAlbumOptions(album.slug)).locked)
			return fail(403, { error: translator(locals.locale)('srv.albumClosed') });

		const fd = await request.formData();
		let name: string;
		try {
			name = requiredText(fd.get('name'), 'Moment name', LIMITS.momentName);
		} catch {
			return fail(400, { error: translator(locals.locale)('srv.nameRequired') });
		}

		await db.transaction(async (tx) => {
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`moment-create:${album.id}`}))`);
			const max = await tx
				.select({ m: sql<number>`coalesce(max(${moments.position}), -1)` })
				.from(moments)
				.where(eq(moments.albumId, album.id));
			await tx.insert(moments).values({
				id: newId(),
				albumId: album.id,
				name,
				position: Number(max[0]?.m ?? -1) + 1
			});
		});
		return { ok: true };
	},

	renameMoment: async ({ request, params, locals }) => {
		// getAlbum() (not a raw slug lookup) so a taken-down album is refused here too —
		// form actions don't run the layout load, so its 404 guard never fires for them.
		const album = await getAlbum(params.slug);
		if (!album) throw error(404);
		// Moments are shared structure: any guest may add one, but only the owner may
		// rename (a guest could otherwise relabel everyone's groupings).
		if (!(await isAlbumOwner(album, locals))) throw error(403, translator(locals.locale)('srv.ownerOnly'));
		rateLimit(`moment-rename:${album.id}`, 60, 60_000);
		requireContentLength(request, LIMITS.formBytes);

		const fd = await request.formData();
		const id = requiredUuid(fd.get('momentId'), 'Moment id');
		let name: string;
		try {
			name = requiredText(fd.get('name'), 'Moment name', LIMITS.momentName);
		} catch {
			return fail(400, { error: translator(locals.locale)('srv.nameRequired') });
		}
		await db
			.update(moments)
			.set({ name })
			.where(and(eq(moments.id, id), eq(moments.albumId, album.id)));
		return { ok: true };
	},

	personalize: async ({ request, params, locals }) => {
		// getAlbum() (not a raw slug lookup) so a taken-down album is refused here too —
		// form actions don't run the layout load, so its 404 guard never fires for them.
		const album = await getAlbum(params.slug);
		if (!album) throw error(404);
		if (!(await isAlbumOwner(album, locals))) throw error(403, translator(locals.locale)('srv.ownerOnly'));
		rateLimit(`album-personalize:${album.id}`, 30, 60_000);
		requireContentLength(request, LIMITS.formBytes);

		const fd = await request.formData();
		let name: string;
		try {
			name = requiredText(fd.get('name'), 'Album name', LIMITS.albumName);
		} catch {
			return fail(400, { error: translator(locals.locale)('srv.nameAlbum') });
		}
		const skin = String(fd.get('skin') ?? '');
		const accentRaw = String(fd.get('accent') ?? '').trim();

		const accent = /^#[0-9a-fA-F]{6}$/.test(accentRaw) ? accentRaw : null;
		await db
			.update(albums)
			.set({
				name,
				skin: Object.hasOwn(SKINS, skin) ? skin : album.skin,
				accent
			})
			.where(eq(albums.id, album.id));
		return { ok: true };
	}
};
