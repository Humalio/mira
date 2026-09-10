import { db } from '#lib/server/db.js';
import { getAlbumById } from '#lib/server/guard.js';
import { uploadSessions } from '#lib/server/schema.js';
import { getUploadSession } from '#lib/server/uploads.js';

import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requiredUuid } from '#lib/server/input.js';

/** Cancel a receiving upload owned by this device. */
export const POST: RequestHandler = async ({ params, url, locals }) => {
	const uploadId = requiredUuid(url.searchParams.get('uploadId'), 'Upload id');
	const session = await getUploadSession(uploadId);
	if (session && session.deviceToken === locals.deviceToken && session.state === 'receiving') {
		const album = await getAlbumById(session.albumId);
		if (album?.slug === params.slug) {
			await db
				.update(uploadSessions)
				.set({ state: 'failed', expiresAt: new Date() })
				.where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.state, 'receiving')))
				.returning({ id: uploadSessions.id });
		}
	}
	return Response.json({ ok: true });
};
