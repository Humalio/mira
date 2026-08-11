/**
 * What an open album page asks every few seconds: "has anything changed, and is a
 * video on its way?". One small query for the first, one for the second, so a room
 * full of open phones costs the server next to nothing. The page reloads its data only
 * when the stamp differs from the one it was rendered with.
 */
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from './db';
import { members, uploadSessions, type Album } from './schema';
import { finalizeStages } from './video-finalize';

/** How long a silent upload still counts as "on its way" (one 12 MB piece may take minutes on a weak signal). */
const QUIET_UPLOAD_MS = 5 * 60_000;

// When each upload last sent a piece or asked for its result. In memory: a restart
// forgets it, and uploads still alive show up again with their next piece. This is
// what keeps an upload abandoned half-way (kept 24 hours for resuming) from showing
// as "being prepared" all day.
const lastHeard = new Map<string, number>();

/** Note that an upload is alive right now. */
export function heardFromUpload(uploadId: string): void {
	const now = Date.now();
	lastHeard.set(uploadId, now);
	if (lastHeard.size > 500) for (const [id, at] of lastHeard) if (now - at > QUIET_UPLOAD_MS) lastHeard.delete(id);
}

export type Preparing = {
	id: string;
	memberId: string;
	momentId: string;
	by: string;
	/** uploading: pieces still arriving. compressing: the copy is being made. preparing: everything else. */
	phase: 'uploading' | 'compressing' | 'preparing';
	percent: number | null;
};

type Viewer = { memberId: string; isOwner: boolean };

/**
 * Videos that are uploading, being put together or being compressed in this album.
 * Visibility follows the item they will become: an upload that will need the owner's
 * approval is shown only to its uploader and the owner.
 */
export async function preparingVideos(albumId: string, viewer: Viewer): Promise<Preparing[]> {
	const rows = await db
		.select({
			id: uploadSessions.id,
			memberId: uploadSessions.memberId,
			momentId: uploadSessions.momentId,
			by: members.displayName,
			state: uploadSessions.state,
			approved: uploadSessions.approved,
			receivedBytes: uploadSessions.receivedBytes,
			declaredBytes: uploadSessions.declaredBytes
		})
		.from(uploadSessions)
		.innerJoin(members, eq(uploadSessions.memberId, members.id))
		.where(
			and(
				eq(uploadSessions.albumId, albumId),
				inArray(uploadSessions.state, ['receiving', 'completing']),
				gt(uploadSessions.expiresAt, new Date())
			)
		)
		.orderBy(uploadSessions.createdAt, uploadSessions.id);
	const now = Date.now();
	const preparing: Preparing[] = [];
	for (const row of rows) {
		if (!row.approved && !viewer.isOwner && row.memberId !== viewer.memberId) continue;
		const base = { id: row.id, memberId: row.memberId, momentId: row.momentId, by: row.by };
		if (row.state === 'receiving') {
			if (now - (lastHeard.get(row.id) ?? 0) > QUIET_UPLOAD_MS) continue; // abandoned, or not started yet
			const percent = Math.min(99, Math.floor((row.receivedBytes / row.declaredBytes) * 100));
			// Fully received and waiting for a free finaliser is no longer "uploading".
			preparing.push(
				row.receivedBytes < row.declaredBytes
					? { ...base, phase: 'uploading', percent }
					: { ...base, phase: 'preparing', percent: null }
			);
			continue;
		}
		const stage = finalizeStages.get(row.id);
		preparing.push(
			stage?.phase === 'compressing'
				? { ...base, phase: 'compressing', percent: stage.percent ?? 0 }
				: { ...base, phase: 'preparing', percent: null }
		);
	}
	return preparing;
}

/**
 * A short string that changes whenever what this viewer can see in the album changes:
 * an item added, approved or deleted, a moment added or renamed, someone joining, or
 * the album renamed or restyled.
 */
export async function albumStamp(
	album: Pick<Album, 'id' | 'name' | 'skin' | 'accent' | 'autoApprove' | 'videoQuality'>,
	viewer: Viewer
): Promise<string> {
	const visible = viewer.isOwner ? sql`true` : sql`(p.approved or p.member_id = ${viewer.memberId})`;
	const [row] = await db.execute<{ media: string; moments: string; people: string }>(sql`
		select
			(select concat_ws(':', count(*), count(*) filter (where not p.approved),
					coalesce(extract(epoch from max(p.created_at)), 0))
				from photos p where p.album_id = ${album.id} and ${visible}) as media,
			(select coalesce(md5(string_agg(m.id || m.name, ',' order by m.position, m.created_at)), '')
				from moments m where m.album_id = ${album.id}) as moments,
			(select count(*)::text from members e where e.album_id = ${album.id}) as people
	`);
	const parts = [
		row.media,
		row.moments,
		row.people,
		album.name,
		album.skin,
		album.accent ?? '',
		album.autoApprove ? 1 : 0,
		album.videoQuality
	];
	return createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 22);
}
