import { db } from '#lib/server/db.js';
import { getAlbumById, memberFor } from '#lib/server/guard.js';
import { uploadSessions } from '#lib/server/schema.js';
import { getUploadSession } from '#lib/server/uploads.js';

import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requiredUuid } from '#lib/server/input.js';

/** Cancel a receiving upload owned by this device and the member who started it. */
export const POST: RequestHandler = async ({ params, url, locals }) => {
	const uploadId = requiredUuid(url.searchParams.get('uploadId'), 'Upload id');
	const session = await getUploadSession(uploadId);
	if (session && session.deviceToken === locals.deviceToken && session.state === 'receiving') {
		const album = await getAlbumById(session.albumId);
		// The device token alone is not enough: a browser keeps it after its account signs
		// out, and the next person to use it must not be able to cancel that account's uploads.
		const member = album?.slug === params.slug ? await memberFor(album.id, locals) : undefined;
		if (member && member.id === session.memberId) {
			await db
				.update(uploadSessions)
				.set({ state: 'failed', expiresAt: new Date() })
				.where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.state, 'receiving')))
				.returning({ id: uploadSessions.id });
		}
	}
	return Response.json({ ok: true });
};
