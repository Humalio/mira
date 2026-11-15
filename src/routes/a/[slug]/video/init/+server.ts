import { getSettings, getUserById } from '#lib/server/users.js';
import { effectiveQuotaMb } from '#lib/server/admin.js';
import { getAlbumOptions } from '#lib/server/album-options.js';
import { db } from '#lib/server/db.js';
import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { LIMITS, jsonObject, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { translator } from '#lib/i18n/index.js';
import { memberScopedId, newId } from '#lib/server/ids.js';
import { lockOwner } from '#lib/server/locks.js';
import { albums, moments, uploadSessions, users, type UploadSession } from '#lib/server/schema.js';
import { cleanupUpload, createUpload, hasVideoSpace, saveUploadName } from '#lib/server/storage.js';
import { UPLOAD_TTL_MS, getUploadSession, reservedUploadBytes, uploadUnderWay } from '#lib/server/uploads.js';
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
	// 423, not 503: the page retries a 503 (a busy server) for minutes, while a pause is
	// the operator's decision and is shown to the person at once.
	if (settings.uploadsPaused) throw error(423, t('srv.uploadsPaused'));
	// A closed album takes nothing new. An upload already under way may finish.
	if ((await getAlbumOptions(album.slug)).locked) throw error(403, t('srv.albumClosed'));

	const body = jsonObject(await request.json().catch(() => null));
	const momentId = requiredUuid(body.momentId, 'Moment id');
	const mime = String(body?.mime ?? 'video/mp4')
		.split(';')[0]
		.trim();
	const totalBytes = Number(body?.totalBytes ?? 0);
	if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw error(400, t('srv.badFileSize'));
	if (!isSupportedVideoMime(mime)) throw error(415, t('srv.unsupportedVideo'));
	// Optional retry key, as for photos: an init whose answer was lost and is sent again
	// gets the upload it already started, instead of a second empty one that holds the
	// quota and one of the three upload places until it goes quiet. The id is derived from
	// the key AND this member (see memberScopedId), with its own prefix so that it can
	// never equal the id of a photo sent with the same key: the upload's id becomes the
	// video's, and names its folder.
	const clientId = body.clientId == null ? null : requiredUuid(body.clientId, 'Client id');
	const resend = (prior: UploadSession) => {
		const same =
			prior.albumId === album.id &&
			prior.memberId === member.id &&
			prior.deviceToken === locals.deviceToken &&
			prior.state === 'receiving' &&
			prior.expiresAt > new Date() &&
			prior.declaredBytes === totalBytes &&
			prior.mime === mime;
		if (!same) throw error(409, 'Client id already used');
		heardFromUpload(prior.id);
		return Response.json({
			uploadId: prior.id,
			chunkSize: prior.chunkSize,
			totalChunks: prior.totalChunks,
			duplicate: true
		});
	};
	const uploadId = clientId ? memberScopedId(member.id, `video:${clientId}`) : newId();
	if (clientId) {
		const prior = await getUploadSession(uploadId);
		if (prior) return resend(prior);
	}

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

	const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
	const approved = album.autoApprove || (await isAlbumOwner(album, locals));
	await createUpload(uploadId);
	await saveUploadName(uploadId, body.name);
	let prior: UploadSession | undefined;
	try {
		prior = await db.transaction(async (tx) => {
			// Serialize all reservations for the owner. Completion, image admission,
			// album creation and deletion use the same key.
			await lockOwner(tx, album.ownerUserId);
			if (clientId) {
				// The same init sent twice at once: the first one to get here made it.
				const [made] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, uploadId));
				if (made) return made;
			}
			const [{ active }] = await tx
				.select({ active: sql<number>`count(*)::int` })
				.from(uploadSessions)
				// Uploads this person abandoned (see uploadUnderWay) do not count against them.
				.where(and(eq(uploadSessions.memberId, member.id), uploadUnderWay()));
			// 409, not 429: waiting does not help, finishing or cancelling one does.
			if (active >= 3) throw error(409, t('srv.finishUploadFirst'));
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
			return undefined;
		});
	} catch (cause) {
		await cleanupUpload(uploadId).catch(() => {});
		throw cause;
	}
	if (prior) return resend(prior);
	heardFromUpload(uploadId); // the album shows "being prepared" from the first moment
	return Response.json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks });
};
