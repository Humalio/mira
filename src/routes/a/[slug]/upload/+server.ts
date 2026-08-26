import { admitWithinQuota } from '#lib/server/admin.js';
import { getAlbumOptions } from '#lib/server/album-options.js';
import { db } from '#lib/server/db.js';
import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { translator } from '#lib/i18n/index.js';
import { getSettings } from '#lib/server/users.js';
import { memberScopedId, newId } from '#lib/server/ids.js';
import { moments, photos } from '#lib/server/schema.js';
import { TooManyPixelsError, deleteMediaItemDir, saveOriginalName, storeImage } from '#lib/server/storage.js';
import { error } from '@sveltejs/kit';
import { LIMITS, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { acquireImageProcessing } from '#lib/server/concurrency.js';

const MAX_MEGAPIXELS = Math.floor(LIMITS.imagePixels / 1_000_000);

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const t = translator(locals.locale);
	const { album, member } = await resolveAlbumMember(params.slug, locals, t('srv.joinAlbumFirst'));
	// One request carries one photo and the client sends a batch back to back, so this
	// must fit a real trip dump on a fast connection. CPU is bounded separately by the
	// image-processing gate and storage by the owner's quota.
	rateLimit(`image-upload:${album.id}:${member.id}`, 120, 60_000);

	const settings = await getSettings();
	const isOwner = await isAlbumOwner(album, locals);
	if (settings.uploadsPaused) throw error(503, t('srv.uploadsPaused'));
	if ((await getAlbumOptions(album.slug)).locked) throw error(403, t('srv.albumClosed'));
	const MAX_BYTES = settings.maxUploadMb * 1024 * 1024;
	requireContentLength(request, Math.min(MAX_BYTES, LIMITS.imageBytes) + 1024 * 1024);
	const release = await acquireImageProcessing();
	try {
		const fd = await request.formData();
		const momentId = requiredUuid(fd.get('momentId'), 'Moment id');
		const moment = (
			await db
				.select()
				.from(moments)
				.where(and(eq(moments.id, momentId), eq(moments.albumId, album.id)))
				.limit(1)
		)[0];
		if (!moment) throw error(400, t('srv.unknownMoment'));

		// Optional client idempotency key: a retry after a lost response (proxy 502/504
		// after commit) acknowledges instead of duplicating. The media id is derived from
		// the key AND this member (see memberScopedId), never the key itself, so no key
		// can name another member's item or a video that is still being prepared.
		const clientId = fd.get('clientId') ? requiredUuid(fd.get('clientId'), 'Client id') : null;
		const mediaItemId = clientId ? memberScopedId(member.id, clientId) : newId();
		if (clientId) {
			const [prior] = await db
				.select({ albumId: photos.albumId, memberId: photos.memberId })
				.from(photos)
				.where(eq(photos.id, mediaItemId))
				.limit(1);
			if (prior) {
				if (prior.albumId !== album.id || prior.memberId !== member.id) throw error(409, 'Client id already used');
				return Response.json({
					added: 1,
					skipped: [],
					duplicate: true,
					maxUploadMb: settings.maxUploadMb,
					maxMegapixels: MAX_MEGAPIXELS
				});
			}
		}

		const files = fd.getAll('photos').filter((f): f is File => f instanceof File);
		if (files.length !== 1) throw error(400, 'Upload exactly one image per request');
		let added = 0;
		// Added, but only the uploader and the owner can see them until the owner approves.
		let pending = 0;
		// Per-file skip reason so the client can say *why* (not a blanket "unsupported?").
		const skipped: {
			name: string;
			reason: 'empty' | 'too_large' | 'too_many_pixels' | 'over_quota' | 'unsupported' | 'failed';
		}[] = [];
		for (const f of files) {
			const fileName = f.name.slice(0, LIMITS.originalFilename) || 'image';
			if (f.size === 0) {
				skipped.push({ name: fileName, reason: 'empty' });
				continue;
			}
			if (f.size > MAX_BYTES) {
				skipped.push({ name: fileName, reason: 'too_large' });
				continue;
			}
			let attemptedAdmission = false;
			try {
				const buffer = Buffer.from(await f.arrayBuffer());
				const stored = await storeImage(album.slug, mediaItemId, buffer);
				await saveOriginalName(album.slug, mediaItemId, f.name);
				// Quota check + row insert run together under a per-owner lock, so two
				// concurrent uploads can't both slip past a stale usage total. The file is
				// already on disk; if it doesn't fit, drop it back off.
				attemptedAdmission = true;
				const admitted = await admitWithinQuota(album, stored.sizeBytes, async (tx) => {
					await tx.insert(photos).values({
						id: mediaItemId,
						albumId: album.id,
						momentId: moment.id,
						memberId: member.id,
						approved: album.autoApprove || isOwner,
						...stored
					});
				});
				if (!admitted) {
					await deleteMediaItemDir(album.slug, mediaItemId).catch(() => {});
					skipped.push({ name: fileName, reason: 'over_quota' });
					continue;
				}
				added++;
				if (!(album.autoApprove || isOwner)) pending++;
			} catch (e) {
				// With a client id, a concurrent retry by the same member may own a committed
				// row at this same path — never delete media without first confirming no row
				// references it. (Nobody else can reach this path: the id is member-scoped.)
				if (attemptedAdmission || clientId) {
					try {
						const [recorded] = await db.select({ id: photos.id }).from(photos).where(eq(photos.id, mediaItemId));
						if (recorded) {
							added++;
							continue;
						}
					} catch {
						// A commit may have succeeded while its response was lost. Keep the file
						// for reconciliation rather than deleting a possibly referenced item.
						console.error('[upload] database status unknown; media retained', { mediaItemId });
						skipped.push({ name: fileName, reason: 'failed' });
						continue;
					}
				}
				await deleteMediaItemDir(album.slug, mediaItemId).catch(() => {});
				// Log the real cause (unreadable format vs. a write/permission failure) — the
				// silent catch is what made "nothing added (unsupported?)" undebuggable.
				const msg = e instanceof Error ? e.message : String(e);
				console.error('[upload] media processing failed', {
					mediaItemId,
					error: Array.from(msg, (character) => {
						const code = character.charCodeAt(0);
						return code < 32 || code === 127 ? ' ' : character;
					})
						.join('')
						.slice(0, 500)
				});
				skipped.push({
					name: fileName,
					reason:
						e instanceof TooManyPixelsError
							? 'too_many_pixels'
							: /unsupported image format/i.test(msg)
								? 'unsupported'
								: 'failed'
				});
			}
		}
		return Response.json({ added, pending, skipped, maxUploadMb: settings.maxUploadMb, maxMegapixels: MAX_MEGAPIXELS });
	} finally {
		release();
	}
};
