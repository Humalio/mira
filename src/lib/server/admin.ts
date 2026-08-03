/**
 * Platform operations: stats, storage accounting, settings writes, and the
 * destructive paths (delete user, delete album, album takedown).
 *
 * This module is imported ONLY by routes and the upload handlers — never by
 * hooks/auth/db — so it may freely import `storage` (which reads $env) without
 * dragging $env into the server-init graph (the adapter-node TLA cycle).
 */
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from './db';
import { albums, appSettings, members, photos, uploadSessions, users } from './schema';
import { enqueueMediaDeletion } from './media-deletions';
import { getSettings, getUserById, type Settings } from './users';
import { newId } from './ids';
import { reservedUploadBytes } from './uploads';
import { error } from '@sveltejs/kit';

const MB = 1024 * 1024;

/**
 * Recompute every owner's counter from the photos table and repair drift. The
 * triggers keep it exact; this is a cheap daily safety net that also reports.
 */
export async function reconcileStorageCounters(): Promise<number> {
	let fixed = 0;
	const owners = await db.select({ id: users.id }).from(users);
	for (const owner of owners) {
		fixed += await db.transaction(async (tx) => {
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${owner.id}))`);
			// Acquire the counter row before taking the SUM's statement snapshot.
			// Photo triggers also lock this row; a single UPDATE ... SUM statement
			// can otherwise overwrite an increment committed while it waits.
			await tx.execute(sql`select id from users where id = ${owner.id} for update`);
			const [sum] = await tx
				.select({ bytes: sql<string>`coalesce(sum(${photos.sizeBytes}), 0)` })
				.from(photos)
				.innerJoin(albums, eq(photos.albumId, albums.id))
				.where(eq(albums.ownerUserId, owner.id));
			const bytes = Number(sum.bytes);
			const repaired = await tx
				.update(users)
				.set({ usedBytes: bytes })
				.where(and(eq(users.id, owner.id), sql`${users.usedBytes} <> ${bytes}`))
				.returning({ id: users.id });
			return repaired.length;
		});
	}
	if (fixed) console.warn('[storage] repaired used_bytes drift', { users: fixed });
	return fixed;
}

/** A user's effective storage cap in MB (override, else platform default; 0 = unlimited). */
export function effectiveQuotaMb(quotaMb: number | null, settings: Settings): number {
	return quotaMb ?? settings.defaultQuotaMb;
}

/** At-a-glance platform totals for the Overview tab. */
export async function platformStats() {
	const [u] = await db
		.select({
			total: sql<number>`count(*)::int`,
			admins: sql<number>`count(*) filter (where ${users.isAdmin})::int`,
			blocked: sql<number>`count(*) filter (where ${users.isBlocked})::int`
		})
		.from(users);
	const [a] = await db
		.select({
			total: sql<number>`count(*)::int`,
			disabled: sql<number>`count(*) filter (where ${albums.disabled})::int`
		})
		.from(albums);
	const [p] = await db
		.select({
			total: sql<number>`count(*)::int`,
			videos: sql<number>`count(*) filter (where ${photos.kind} = 'video')::int`,
			bytes: sql<string>`coalesce(sum(${photos.sizeBytes}), 0)`
		})
		.from(photos);
	return {
		users: u?.total ?? 0,
		admins: u?.admins ?? 0,
		blocked: u?.blocked ?? 0,
		albums: a?.total ?? 0,
		disabledAlbums: a?.disabled ?? 0,
		photos: (p?.total ?? 0) - (p?.videos ?? 0),
		videos: p?.videos ?? 0,
		bytes: Number(p?.bytes ?? 0)
	};
}

export const ADMIN_PAGE_SIZE = 100;

/** Escape LIKE wildcards so a search for "50%" matches literally. */
function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** One page of accounts (optionally searched), with per-account album counts. */
export async function listUsersForAdmin(q: string, page: number) {
	const where = q
		? or(ilike(users.name, likePattern(q)), ilike(users.email, likePattern(q)), ilike(users.provider, likePattern(q)))
		: undefined;
	const [{ matched }] = await db
		.select({ matched: sql<number>`count(*)::int` })
		.from(users)
		.where(where);
	const rows = await db
		.select()
		.from(users)
		.where(where)
		.orderBy(asc(users.createdAt), asc(users.id))
		.limit(ADMIN_PAGE_SIZE)
		.offset((page - 1) * ADMIN_PAGE_SIZE);
	const ids = rows.map((r) => r.id);
	const counts = ids.length
		? await db
				.select({ owner: albums.ownerUserId, c: sql<number>`count(*)::int` })
				.from(albums)
				.where(inArray(albums.ownerUserId, ids))
				.groupBy(albums.ownerUserId)
		: [];
	const albumCounts = new Map(counts.map((r) => [r.owner, r.c]));
	return { rows: rows.map((r) => ({ ...r, albums: albumCounts.get(r.id) ?? 0 })), matched };
}

/** One page of albums (optionally searched by album or owner), newest first, with item counts. */
export async function listAlbumsForAdmin(q: string, page: number) {
	const where = q
		? or(ilike(albums.name, likePattern(q)), ilike(users.name, likePattern(q)), ilike(users.email, likePattern(q)))
		: undefined;
	const [{ matched }] = await db
		.select({ matched: sql<number>`count(*)::int` })
		.from(albums)
		.innerJoin(users, eq(albums.ownerUserId, users.id))
		.where(where);
	const rows = await db
		.select({
			id: albums.id,
			slug: albums.slug,
			name: albums.name,
			disabled: albums.disabled,
			ownerUserId: albums.ownerUserId,
			ownerName: users.name,
			ownerEmail: users.email,
			createdAt: albums.createdAt
		})
		.from(albums)
		.innerJoin(users, eq(albums.ownerUserId, users.id))
		.where(where)
		.orderBy(desc(albums.createdAt), asc(albums.id))
		.limit(ADMIN_PAGE_SIZE)
		.offset((page - 1) * ADMIN_PAGE_SIZE);
	const ids = rows.map((r) => r.id);
	const counts = ids.length
		? await db
				.select({ albumId: photos.albumId, c: sql<number>`count(*)::int` })
				.from(photos)
				.where(inArray(photos.albumId, ids))
				.groupBy(photos.albumId)
		: [];
	const cmap = new Map(counts.map((r) => [r.albumId, r.c]));
	return { rows: rows.map((r) => ({ ...r, items: cmap.get(r.id) ?? 0 })), matched };
}

/** Upsert a subset of the singleton settings row. */
async function writeSettings(set: Partial<typeof appSettings.$inferInsert>): Promise<void> {
	await db
		.insert(appSettings)
		.values({ id: 1, ...set })
		.onConflictDoUpdate({ target: appSettings.id, set });
}

export async function saveRegistration(mode: string, allowlist: string): Promise<void> {
	if (!['open', 'closed', 'allowlist'].includes(mode)) throw new Error('invalid registration mode');
	const registrationMode = mode;
	await writeSettings({ registrationMode, registrationAllowlist: allowlist });
}

export async function saveLimits(v: {
	defaultQuotaMb: number;
	maxAlbumsPerUser: number;
	maxUploadMb: number;
	maxVideoMb: number;
}): Promise<void> {
	await writeSettings(v);
}

export async function saveMaintenance(v: { uploadsPaused: boolean; albumCreationPaused: boolean }): Promise<void> {
	await writeSettings(v);
}

export async function setUserQuota(userId: string, quotaMb: number | null): Promise<void> {
	await db.update(users).set({ quotaMb }).where(eq(users.id, userId));
}

export async function setAlbumDisabled(albumId: string, disabled: boolean): Promise<void> {
	await db.update(albums).set({ disabled }).where(eq(albums.id, albumId));
}

/**
 * Permanently delete one album: the row (moments, members, photos and favorites
 * all cascade via FK) and its media directory on disk. Irreversible — callers
 * are responsible for confirming intent and for checking who is allowed to ask.
 */
export async function deleteAlbum(albumId: string, slug: string, ownerUserId: string): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerUserId}))`);
		const pending = await tx
			.select({ id: uploadSessions.id })
			.from(uploadSessions)
			.where(eq(uploadSessions.albumId, albumId));
		for (const upload of pending) await enqueueMediaDeletion(tx, ownerUserId, upload.id, 'upload');
		const deleted = await tx
			.delete(albums)
			.where(and(eq(albums.id, albumId), eq(albums.ownerUserId, ownerUserId)))
			.returning({ id: albums.id });
		if (!deleted[0]) throw new Error('album deletion target no longer exists or changed owner');
		await enqueueMediaDeletion(tx, ownerUserId, slug);
	});
}

/** Serialize administrator changes and keep at least one unblocked administrator. */
export async function assertAdminMutationAllowed(
	tx: Tx,
	actorId: string,
	targetId: string,
	deactivateTarget: boolean
): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mira:admin-governance'))`);
	const [actor] = await tx
		.select({ isAdmin: users.isAdmin, isBlocked: users.isBlocked })
		.from(users)
		.where(eq(users.id, actorId));
	if (!actor?.isAdmin || actor.isBlocked) throw error(403, 'Administrator access was revoked');
	const [target] = await tx
		.select({ isAdmin: users.isAdmin, isBlocked: users.isBlocked })
		.from(users)
		.where(eq(users.id, targetId));
	if (!target) throw error(404, 'No such account');
	if (deactivateTarget && target.isAdmin && !target.isBlocked) {
		const [{ active }] = await tx
			.select({ active: sql<number>`count(*)::int` })
			.from(users)
			.where(and(eq(users.isAdmin, true), eq(users.isBlocked, false)));
		if (active <= 1) throw error(409, 'Cannot remove the last active administrator');
	}
}

/** Delete an account and every album it owns, preserving the ownership invariant. */
export async function deleteAccount(accountId: string, actorId: string): Promise<void> {
	await db.transaction(async (tx) => {
		await assertAdminMutationAllowed(tx, actorId, accountId, true);
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${accountId}))`);
		// Hold the account row against a concurrent join's FK check while retiring
		// its memberships; any new join after commit fails rather than becoming a guest.
		await tx.execute(sql`select id from users where id = ${accountId} for update`);
		const owned = await tx
			.select({ id: albums.id, slug: albums.slug })
			.from(albums)
			.where(eq(albums.ownerUserId, accountId));
		for (const album of owned) {
			await enqueueMediaDeletion(tx, accountId, album.slug);
			const pending = await tx
				.select({ id: uploadSessions.id })
				.from(uploadSessions)
				.where(eq(uploadSessions.albumId, album.id));
			for (const upload of pending) await enqueueMediaDeletion(tx, accountId, upload.id, 'upload');
		}
		if (owned.length) {
			await tx.delete(albums).where(
				inArray(
					albums.id,
					owned.map((album) => album.id)
				)
			);
		}
		// Keep contributions to other people's albums but anonymize their uploader
		// and revoke the old device token before each row becomes a guest.
		const linked = await tx.select({ id: members.id }).from(members).where(eq(members.userId, accountId));
		for (const row of linked) {
			await tx
				.update(members)
				.set({ userId: null, deviceToken: `retired:${newId()}`, displayName: 'Former member' })
				.where(and(eq(members.id, row.id), eq(members.userId, accountId)));
		}
		await tx.delete(users).where(eq(users.id, accountId));
	});
}

/** A drizzle transaction handle (same query surface as `db`). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Admit one uploaded file against the owner's storage quota and, if it fits, run
 * `insert` — both inside one transaction holding a per-owner advisory lock. The
 * lock (auto-released at transaction end) serializes concurrent uploads for the
 * same owner, so the "read usage → insert row" step can't race two uploads both
 * past a stale total. Returns false (nothing inserted) if the file would exceed
 * the quota. Keep slow work (filesystem writes, ffmpeg) OUTSIDE this call so the lock
 * is held only for the fast check-and-insert.
 *
 * Space that unfinished video uploads have reserved counts as used, so a video that was
 * let start can also finish; a completing video passes its own upload as `ownUpload`.
 */
export async function admitWithinQuota(
	album: { ownerUserId: string },
	fileBytes: number,
	insert: (tx: Tx) => Promise<void>,
	ownUpload?: string
): Promise<boolean> {
	// Resolve the cap outside the transaction so the locked section holds only one
	// connection (no nested pool acquisitions under the lock).
	const settings = await getSettings();
	const owner = await getUserById(album.ownerUserId);
	const mb = effectiveQuotaMb(owner?.quotaMb ?? null, settings);
	const quotaBytes = mb > 0 ? mb * MB : null;
	return db.transaction(async (tx) => {
		// Always lock, even for an explicitly unlimited owner: deletion uses the same
		// key and must not race a file write/row insert into an album being removed.
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${album.ownerUserId}))`);
		if (quotaBytes != null) {
			// Serialize same-owner uploads; the lock releases when this tx commits, so
			// the counter below already includes every prior upload's committed row.
			const [row] = await tx.select({ b: users.usedBytes }).from(users).where(eq(users.id, album.ownerUserId));
			const [reserved] = await tx
				.select({ bytes: reservedUploadBytes() })
				.from(uploadSessions)
				.innerJoin(albums, eq(uploadSessions.albumId, albums.id))
				.where(
					and(
						eq(albums.ownerUserId, album.ownerUserId),
						inArray(uploadSessions.state, ['receiving', 'completing']),
						ownUpload ? ne(uploadSessions.id, ownUpload) : undefined
					)
				);
			if (Number(row?.b ?? 0) + Number(reserved?.bytes ?? 0) + fileBytes > quotaBytes) return false;
		}
		await insert(tx);
		return true;
	});
}
