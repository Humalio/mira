import { enabledProviders } from '../auth';
import { newId, slugify } from '#lib/server/ids.js';
import { db } from '#lib/server/db.js';
import { deleteAlbum } from '#lib/server/admin.js';
import { getAlbumOptions, saveAlbumOptions, settingsUnavailable } from '#lib/server/album-options.js';
import { getAlbum } from '#lib/server/guard.js';
import { albums, members, moments, photos } from '#lib/server/schema.js';
import { getSettings } from '#lib/server/users.js';
import { LIMITS, requireContentLength, requiredText } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { translator } from '#lib/i18n/index.js';
import { DEFAULT_SKIN } from '#lib/theme/skins.js';
import { DEFAULT_VIDEO_QUALITY, isVideoQuality, type VideoQuality } from '#lib/video-quality.js';
import { error, fail, redirect } from '@sveltejs/kit';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

/** Postgres unique-violation (SQLSTATE 23505), as thrown by postgres-js. */
function isUniqueViolation(err: unknown): boolean {
	return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === '23505';
}

/** The quality the form asked for, or `fallback` when it sent none or an unknown one. */
const chosenQuality = (value: FormDataEntryValue | null, fallback: VideoQuality): VideoQuality =>
	isVideoQuality(value) ? value : fallback;

export const load: PageServerLoad = async ({ locals, url }) => {
	const session = await locals.auth();
	const user = session?.user;

	// Logged out: show the login screen with whichever providers are configured.
	if (!user) {
		// Auth.js sends a refused sign-in back here with ?error=...; say which kind.
		const failure = url.searchParams.get('error');
		const signInProblem = !failure ? null : failure === 'AccessDenied' ? ('denied' as const) : ('failed' as const);
		return { user: null, providers: enabledProviders, albums: [], signInProblem };
	}

	// Taken-down albums are hidden here to match getAlbum(), which refuses them — listing one
	// would render a tile that 404s the moment it's opened.
	const rows = await db
		.select()
		.from(albums)
		.where(and(eq(albums.ownerUserId, user.id), eq(albums.disabled, false)));
	const albumIds = rows.map((a) => a.id);
	const counts = new Map<string, number>();
	if (albumIds.length) {
		const countRows = await db
			.select({ albumId: photos.albumId, c: sql<number>`count(*)` })
			.from(photos)
			.where(inArray(photos.albumId, albumIds))
			.groupBy(photos.albumId);
		for (const r of countRows) counts.set(r.albumId, Number(r.c));
	}
	// Newest approved item per album, shown as the tile's cover.
	const covers = new Map<string, string>();
	if (albumIds.length) {
		const coverRows = await db
			.selectDistinctOn([photos.albumId], { albumId: photos.albumId, id: photos.id })
			.from(photos)
			.where(and(inArray(photos.albumId, albumIds), eq(photos.approved, true)))
			.orderBy(photos.albumId, desc(photos.createdAt), desc(photos.id));
		for (const r of coverRows) covers.set(r.albumId, `/media/${r.id}/preview`);
	}

	const options = new Map(await Promise.all(rows.map(async (a) => [a.id, await getAlbumOptions(a.slug)] as const)));
	const list = rows
		.map((a) => ({
			slug: a.slug,
			name: a.name,
			itemCount: counts.get(a.id) ?? 0,
			cover: covers.get(a.id) ?? null,
			createdAt: a.createdAt,
			autoApprove: a.autoApprove,
			videoQuality: a.videoQuality,
			keepOnlyCopy: options.get(a.id)?.keepOnlyCopy ?? false,
			locked: options.get(a.id)?.locked ?? false
		}))
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

	// Whether this owner may create another album right now (drives the button).
	const settings = await getSettings();
	const atLimit = settings.maxAlbumsPerUser > 0 && list.length >= settings.maxAlbumsPerUser;
	const t = translator(locals.locale);
	const createBlockedReason = settings.albumCreationPaused
		? t('srv.albumCreationPaused')
		: atLimit
			? t('srv.albumLimit', { max: settings.maxAlbumsPerUser })
			: null;

	return {
		user: { name: user.name ?? null, email: user.email ?? null, isAdmin: user.isAdmin },
		providers: enabledProviders,
		albums: list,
		canCreate: createBlockedReason === null,
		createBlockedReason
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const t = translator(locals.locale);
		const session = await locals.auth();
		if (!session?.user) return fail(401, { error: t('srv.signInToCreate') });
		rateLimit(`album-create:${session.user.id}`, 10, 60 * 60_000);
		requireContentLength(request, LIMITS.formBytes);

		const settings = await getSettings();
		if (settings.albumCreationPaused) return fail(403, { error: t('srv.albumCreationPaused') });
		if (settings.maxAlbumsPerUser > 0) {
			// Taken-down albums don't count against the limit — the owner can neither see
			// nor reuse them, so charging a slot for one would strand them.
			const [{ c }] = await db
				.select({ c: sql<number>`count(*)::int` })
				.from(albums)
				.where(and(eq(albums.ownerUserId, session.user.id), eq(albums.disabled, false)));
			if (Number(c) >= settings.maxAlbumsPerUser) {
				return fail(403, { error: t('srv.albumLimit', { max: settings.maxAlbumsPerUser }) });
			}
		}

		const formData = await request.formData();
		let albumName: string;
		try {
			albumName = requiredText(formData.get('albumName'), 'Album name', LIMITS.albumName);
		} catch {
			return fail(400, { error: t('srv.nameAlbum') });
		}
		// The owner joins as a member under their account name — no need to ask.
		const ownerName = (session.user.name || session.user.email || 'Me').trim();

		const albumId = newId();
		const ownerUserId = session.user.id;
		const opts = {
			autoApprove: formData.get('autoApprove') !== '0',
			videoQuality: chosenQuality(formData.get('videoQuality'), DEFAULT_VIDEO_QUALITY)
		};

		// Create the album + its first moment + the owner's member row in one transaction,
		// so a mid-sequence failure can't leave an invalid or moment-less album. Retry the
		// slug on the rare UNIQUE collision (the random suffix isn't infinite).
		let slug = slugify(albumName);
		for (let attempt = 0; ; attempt++) {
			try {
				await db.transaction(async (tx) => {
					// The owner id is the shared lock key for album creation/deletion and
					// quota admission, so account deletion cannot race a new album into existence.
					await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerUserId}))`);
					if (settings.maxAlbumsPerUser > 0) {
						const [{ c }] = await tx
							.select({ c: sql<number>`count(*)::int` })
							.from(albums)
							.where(and(eq(albums.ownerUserId, ownerUserId), eq(albums.disabled, false)));
						if (Number(c) >= settings.maxAlbumsPerUser)
							throw error(403, t('srv.albumLimit', { max: settings.maxAlbumsPerUser }));
					}
					await tx.insert(albums).values({
						id: albumId,
						slug,
						name: albumName,
						skin: DEFAULT_SKIN,
						ownerUserId,
						...opts
					});
					await tx.insert(moments).values({ id: newId(), albumId, name: t('srv.defaultMoment'), position: 0 });
					await tx.insert(members).values({
						id: newId(),
						albumId,
						deviceToken: locals.deviceToken,
						userId: ownerUserId,
						displayName: ownerName
					});
				});
				break;
			} catch (err) {
				if (isUniqueViolation(err) && attempt < 5) {
					slug = slugify(albumName);
					continue;
				}
				throw err;
			}
		}
		// Only an owner who asked to give up originals gets a settings file; the default
		// (keep them) needs none.
		if (formData.get('keepOnlyCopy') === '1') await saveAlbumOptions(slug, { keepOnlyCopy: true });
		return redirect(303, `/a/${slug}`);
	},

	update: async ({ request, locals }) => {
		const t = translator(locals.locale);
		const session = await locals.auth();
		if (!session?.user) throw error(401, t('srv.signIn'));
		requireContentLength(request, LIMITS.formBytes);

		const formData = await request.formData();
		const slug = String(formData.get('albumSlug') ?? '');
		let name: string;
		try {
			name = requiredText(formData.get('name'), 'Album name', LIMITS.albumName);
		} catch {
			return fail(400, { error: t('srv.nameAlbum') });
		}
		// getAlbum() refuses taken-down albums, so this action can't edit one.
		const album = await getAlbum(slug);
		if (!album) throw error(404);
		if (album.ownerUserId !== session.user.id) throw error(403, t('srv.ownerOnly'));
		rateLimit(`album-update:${session.user.id}`, 60, 60_000);
		await db
			.update(albums)
			.set({
				name,
				autoApprove: formData.get('autoApprove') !== '0',
				// A form that does not send the field leaves the album's choice alone.
				videoQuality: chosenQuality(formData.get('videoQuality'), album.videoQuality)
			})
			.where(eq(albums.id, album.id));
		// Same rule as the quality: a form that does not send a field changes nothing.
		const current = await getAlbumOptions(album.slug);
		const patch: { keepOnlyCopy?: boolean; locked?: boolean } = {};
		for (const field of ['keepOnlyCopy', 'locked'] as const) {
			const value = formData.get(field);
			if ((value === '1' || value === '0') && current[field] !== (value === '1')) patch[field] = value === '1';
		}
		if (Object.keys(patch).length)
			await saveAlbumOptions(album.slug, patch).catch(settingsUnavailable(t('srv.albumSettingsUnreadable')));
		return { ok: true };
	},

	/**
	 * Permanently delete an album the caller owns, with everything in it. The
	 * confirmation lives in the UI; this only enforces who may ask.
	 */
	deleteAlbum: async ({ request, locals }) => {
		const t = translator(locals.locale);
		const session = await locals.auth();
		if (!session?.user) throw error(401, t('srv.signIn'));
		requireContentLength(request, LIMITS.formBytes);

		const formData = await request.formData();
		const slug = String(formData.get('albumSlug') ?? '');
		const album = await getAlbum(slug);
		if (!album) throw error(404);
		if (album.ownerUserId !== session.user.id) throw error(403, t('srv.ownerOnly'));
		rateLimit(`album-delete:${session.user.id}`, 10, 60 * 60_000);

		await deleteAlbum(album.id, album.slug, album.ownerUserId);
		return { ok: true };
	}
};
