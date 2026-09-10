import { getSettings, getUserById } from '#lib/server/users.js';
import { effectiveQuotaMb } from '#lib/server/admin.js';
import { getAlbumOptions } from '#lib/server/album-options.js';
import { db } from '#lib/server/db.js';
import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { LIMITS, jsonObject, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { translator } from '#lib/i18n/index.js';
import { newId } from '#lib/server/ids.js';
import { albums, moments, uploadSessions, users } from '#lib/server/schema.js';
import { cleanupUpload, createUpload, hasVideoSpace, saveUploadName } from '#lib/server/storage.js';
import { UPLOAD_TTL_MS, reservedUploadBytes, uploadUnderWay } from '#lib/server/uploads.js';
import { isSupportedVideoMime } from '#lib/server/video.js';
import { heardFromUpload } from '#lib/server/pulse.js';
import { error } from '@sveltejs/kit';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';

// 12 MB keeps each request comfortably under the ~100 MB proxy body cap while
// keeping the request count low; the client slices the file to this size.
const CHUNK_SIZE = 12 * 1024 * 1024;

/** Begin a chunked video upload: validate quota/limits up front, stage a dir, return its id. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const t = translator(locals.locale);
	const { album, member } = await resolveAlbumMember(params.slug, locals, t('srv.joinAlbumFirst'));
	rateLimit(`video-init:${album.id}:${member.id}`, 10, 60_000);
	requireContentLength(request, LIMITS.jsonBytes);

	// Resolve only the cap here; usage is read inside the locked section below.
	const [settings, owner] = await Promise.all([getSettings(), getUserById(album.ownerUserId)]);
	const quotaMb = effectiveQuotaMb(owner?.quotaMb ?? null, settings);
	const quotaBytes = quotaMb > 0 ? quotaMb * 1024 * 1024 : null;
	if (settings.uploadsPaused) throw error(503, t('srv.uploadsPaused'));
	// A closed album takes nothing new. An upload already under way may finish.
	if ((await getAlbumOptions(album.slug)).locked) throw error(403, t('srv.albumClosed'));

	const body = jsonObject(await request.json().catch(() => null));
	const momentId = requiredUuid(body.momentId, 'Moment id');
	const mime = String(body?.mime ?? 'video/mp4')
		.split(';')[0]
		.trim();
	const totalBytes = Number(body?.totalBytes ?? 0);
	if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw error(400, t('srv.badFileSize'));
	if (!isSupportedVideoMime(mime)) throw error(415, 'Unsupported video type');

	const MAX_VIDEO_BYTES = settings.maxVideoMb * 1024 * 1024;
	if (totalBytes > Math.min(MAX_VIDEO_BYTES, LIMITS.videoBytes))
		throw error(413, t('srv.videoTooLarge', { max: settings.maxVideoMb }));
	const moment = (
		await db
			.select()
			.from(moments)
			.where(and(eq(moments.id, momentId), eq(moments.albumId, album.id)))
			.limit(1)
	)[0];
	if (!moment) throw error(400, t('srv.unknownMoment'));

	// Finalisation checks the disk again, but by then the whole file has been sent and
	// the only thing left to say is that it failed. Refuse now, with the real reason.
	if (!(await hasVideoSpace(totalBytes))) throw error(507, t('srv.serverFull'));

	const uploadId = newId();
	const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
	const approved = album.autoApprove || (await isAlbumOwner(album, locals));
	await createUpload(uploadId);
	await saveUploadName(uploadId, body.name);
	try {
		await db.transaction(async (tx) => {
			// Serialize all reservations for the owner. Completion, image admission,
			// album creation and deletion use the same key.
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${album.ownerUserId}))`);
			const [{ active }] = await tx
				.select({ active: sql<number>`count(*)::int` })
				.from(uploadSessions)
				// Uploads this person abandoned (see uploadUnderWay) do not count against them.
				.where(and(eq(uploadSessions.memberId, member.id), uploadUnderWay()));
			if (active >= 3) throw error(429, 'Finish or cancel an existing upload first');
			if (quotaBytes != null) {
				const [stored] = await tx.select({ bytes: users.usedBytes }).from(users).where(eq(users.id, album.ownerUserId));
				const [reserved] = await tx
					.select({ bytes: reservedUploadBytes() })
					.from(uploadSessions)
					.innerJoin(albums, eq(uploadSessions.albumId, albums.id))
					.where(
						and(eq(albums.ownerUserId, album.ownerUserId), inArray(uploadSessions.state, ['receiving', 'completing']))
					);
				if (Number(stored?.bytes ?? 0) + Number(reserved?.bytes ?? 0) + totalBytes > quotaBytes) {
					throw error(413, t('srv.storageLimit'));
				}
			}
			await tx.insert(uploadSessions).values({
				id: uploadId,
				albumId: album.id,
				momentId: moment.id,
				memberId: member.id,
				deviceToken: locals.deviceToken,
				mime,
				declaredBytes: totalBytes,
				chunkSize: CHUNK_SIZE,
				totalChunks,
				expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
				quality: album.videoQuality,
				approved
			});
		});
	} catch (cause) {
		await cleanupUpload(uploadId).catch(() => {});
		throw cause;
	}
	heardFromUpload(uploadId); // the album shows "being prepared" from the first moment
	return Response.json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks });
};
