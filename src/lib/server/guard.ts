import { and, eq, isNull } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { db } from './db';
import { newId } from './ids';
import { nameKey } from '#lib/names.js';
import { albums, members, type Album, type Member } from './schema';

/** Just the bits of `event.locals` membership resolution needs (device + optional account). */
type RequestLocals = {
	deviceToken: string;
	auth: () => Promise<{ user?: { id?: string | null } } | null>;
};

/**
 * Whether the caller owns this album. Ownership always belongs to an account and
 * therefore follows that account across devices.
 */
export async function isAlbumOwner(album: Pick<Album, 'ownerUserId'>, locals: RequestLocals): Promise<boolean> {
	return (await locals.auth())?.user?.id === album.ownerUserId;
}

/**
 * Look up an album by its share slug. Admin-disabled (taken-down) albums are
 * treated as not found, so every guest/owner endpoint that resolves an album
 * through here is locked out at once. Admin re-enables via the album id.
 */
export async function getAlbum(slug: string): Promise<Album | undefined> {
	const rows = await db
		.select()
		.from(albums)
		.where(and(eq(albums.slug, slug), eq(albums.disabled, false)))
		.limit(1);
	return rows[0];
}

/** Resolve an enabled album by primary key. */
export async function getAlbumById(id: string): Promise<Album | undefined> {
	const rows = await db
		.select()
		.from(albums)
		.where(and(eq(albums.id, id), eq(albums.disabled, false)))
		.limit(1);
	return rows[0];
}

/** A device's membership in an album (the account-free guest path). */
export async function getMembership(albumId: string, deviceToken: string): Promise<Member | undefined> {
	const rows = await db
		.select()
		.from(members)
		.where(and(eq(members.albumId, albumId), eq(members.deviceToken, deviceToken)))
		.limit(1);
	return rows[0];
}

/** A signed-in user's membership in an album — one identity across all their devices. */
export async function getMembershipByUser(albumId: string, userId: string): Promise<Member | undefined> {
	const rows = await db
		.select()
		.from(members)
		.where(and(eq(members.albumId, albumId), eq(members.userId, userId)))
		.limit(1);
	return rows[0];
}

/** Does someone in this album already go by this name (ignoring case and spacing)? */
export async function isNameTaken(albumId: string, displayName: string): Promise<boolean> {
	const rows = await db.select({ name: members.displayName }).from(members).where(eq(members.albumId, albumId));
	const wanted = nameKey(displayName);
	return rows.some((row) => nameKey(row.name) === wanted);
}

/**
 * Resolve the caller's membership for a request, preferring their ACCOUNT identity
 * so the same signed-in user is ONE member across devices; guests fall back to the
 * device token. Read-only — does not create. Use this in every endpoint that asks
 * "who is the caller in this album?".
 */
export async function memberFor(albumId: string, locals: RequestLocals): Promise<Member | undefined> {
	const userId = (await locals.auth())?.user?.id;
	if (userId) {
		const byUser = await getMembershipByUser(albumId, userId);
		if (byUser) return byUser;
		const byDevice = await getMembership(albumId, locals.deviceToken);
		// An unlinked guest row may be claimed by this account. Never let a signed-in
		// user inherit a different account's identity from a shared browser cookie.
		return eligibleDeviceMembership(byDevice);
	}
	return eligibleDeviceMembership(await getMembership(albumId, locals.deviceToken));
}

/** A device token never confers an account-linked member's permissions. */
export function eligibleDeviceMembership(member: Member | undefined): Member | undefined {
	return member && !member.userId ? member : undefined;
}

/**
 * The standard album-endpoint gate: resolve the album by slug (404 if missing or
 * admin-disabled) and the caller's membership (403 if not a member), or throw the
 * matching HTTP error. Every `a/[slug]/…` endpoint funnels through this so the
 * guard is written once. Pass `notMemberMessage` to keep an endpoint's specific
 * "you must join first" copy.
 */
export async function resolveAlbumMember(
	slug: string,
	locals: RequestLocals,
	notMemberMessage?: string
): Promise<{ album: Album; member: Member }> {
	const album = await getAlbum(slug);
	if (!album) throw error(404);
	const member = await memberFor(album.id, locals);
	if (!member) throw error(403, notMemberMessage);
	return { album, member };
}

/**
 * Get-or-create the caller's membership. A signed-in user reuses their existing
 * account membership from any device (so opening an album on a new phone does not
 * spawn a duplicate "different user"); a device-only row is upgraded with the
 * account on first sign-in; guests stay device-scoped.
 */
export async function ensureMembership(
	albumId: string,
	deviceToken: string,
	displayName: string,
	userId?: string | null
): Promise<Member> {
	if (userId) {
		const byUser = await getMembershipByUser(albumId, userId);
		if (byUser) return byUser;
	}
	const existing = await getMembership(albumId, deviceToken);
	if (existing) {
		// First time this guest device signs in: link the row to the account.
		if (userId && !existing.userId) {
			try {
				const [claimed] = await db
					.update(members)
					.set({ userId })
					.where(and(eq(members.id, existing.id), isNull(members.userId)))
					.returning();
				if (claimed) return claimed;
				const raced = await getMembershipByUser(albumId, userId);
				if (raced) return raced;
				throw error(409, 'Membership changed while joining; retry');
			} catch (cause) {
				if ((cause as { code?: string })?.code === '23505') {
					const raced = await getMembershipByUser(albumId, userId);
					if (raced) return raced;
				}
				throw cause;
			}
		}
		if (existing.userId && existing.userId !== userId) {
			// The browser changed accounts or signed out. Retire the account's device
			// binding so the next identity joins without taking over its uploads.
			try {
				return await db.transaction(async (tx) => {
					await tx
						.update(members)
						.set({ deviceToken: `retired:${newId()}` })
						.where(eq(members.id, existing.id));
					const [created] = await tx
						.insert(members)
						.values({ id: newId(), albumId, deviceToken, userId: userId ?? null, displayName })
						.returning();
					return created;
				});
			} catch (cause) {
				if ((cause as { code?: string })?.code === '23505') {
					const raced = userId
						? await getMembershipByUser(albumId, userId)
						: eligibleDeviceMembership(await getMembership(albumId, deviceToken));
					if (raced) return raced;
				}
				throw cause;
			}
		} else {
			return existing;
		}
	}
	await db
		.insert(members)
		.values({ id: newId(), albumId, deviceToken, userId: userId ?? null, displayName })
		.onConflictDoNothing();
	const created = await getMembership(albumId, deviceToken);
	if (created && (!created.userId || created.userId === userId)) return created;
	if (userId) {
		const raced = await getMembershipByUser(albumId, userId);
		if (raced) return raced;
	}
	throw error(409, 'Membership changed while joining; retry');
}
