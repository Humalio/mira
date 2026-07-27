/**
 * A way back into an album for a guest who lost their place.
 *
 * A guest is recognised by a random code in a cookie, so a new phone or a cleared
 * browser is a stranger: joining again makes a second "Zoe (2)" who cannot delete the
 * first Zoe's uploads. A return link moves an existing guest to the device that opens
 * it. The album's owner issues one for a guest who is locked out (valid a day); a
 * guest can issue one for themselves before switching phones (valid fifteen minutes).
 *
 * The link is a signed statement "this is guest M, until time E", bound to the
 * device code M has right now. It needs no database table, and it works exactly once:
 * using it changes M's device code, which makes the signature stale.
 *
 * What it is worth: whoever opens a valid link becomes that guest, with their name,
 * their uploads (which they may delete) and their favourites. It is no more than the
 * guest's own cookie was worth, it expires, and an account owner never needs one.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db';
import { favorites, members, photos, uploadSessions, type Member } from './schema';
import { UUID_PATTERN } from './input';

export const OWNER_ISSUED_MS = 24 * 60 * 60_000;
export const SELF_ISSUED_MS = 15 * 60_000;

function secret(): string {
	const value = process.env.AUTH_SECRET;
	if (!value) throw new Error('AUTH_SECRET is required to issue return links');
	return value;
}

const sign = (memberId: string, expires: number, deviceToken: string) =>
	createHmac('sha256', secret()).update(`mira:return|${memberId}|${expires}|${deviceToken}`).digest('base64url');

/** A link token for this guest, valid for `ttlMs` and until it is first used. */
export function returnToken(member: Pick<Member, 'id' | 'deviceToken'>, ttlMs: number, now = Date.now()): string {
	const expires = now + ttlMs;
	return `${member.id}.${expires.toString(36)}.${sign(member.id, expires, member.deviceToken)}`;
}

/** Whom a token names, without yet trusting it. */
export function tokenMemberId(token: string): string | null {
	const [memberId, expires, signature, extra] = token.split('.');
	return memberId && expires && signature && !extra && UUID_PATTERN.test(memberId) ? memberId : null;
}

/** Is this token a current, unused return link for exactly this guest? */
export function returnTokenValid(token: string, member: Pick<Member, 'id' | 'deviceToken'>, now = Date.now()): boolean {
	const [memberId, expiresText, signature] = token.split('.');
	const expires = Number.parseInt(expiresText ?? '', 36);
	if (memberId !== member.id || !Number.isSafeInteger(expires) || expires <= now) return false;
	const given = Buffer.from(signature ?? '');
	const wanted = Buffer.from(sign(member.id, expires, member.deviceToken));
	return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Only an account-free guest can be moved; someone with an account simply signs in. */
export const canReturn = (member: Pick<Member, 'userId' | 'deviceToken'>): boolean =>
	!member.userId && !member.deviceToken.startsWith('retired:');

/**
 * Give the guest named by a valid token to the device `deviceToken`. If that device
 * had already joined the album again as a new guest, the newcomer is folded into the
 * returning guest (uploads, favourites and unfinished uploads move over) so nobody is
 * left twice in the album. Returns false when the token is no longer valid.
 */
export async function takePlace(token: string, memberId: string, deviceToken: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		// "No key update": nobody else may move or change these guests meanwhile, but a
		// video of theirs that finishes being prepared this instant may still be recorded
		// under them (its insert only needs the member to keep existing).
		const [member] = await tx.select().from(members).where(eq(members.id, memberId)).for('no key update');
		if (!member || !canReturn(member) || !returnTokenValid(token, member)) return false;
		if (member.deviceToken === deviceToken) return true; // already theirs
		const [duplicate] = await tx
			.select()
			.from(members)
			.where(and(eq(members.albumId, member.albumId), eq(members.deviceToken, deviceToken)))
			.for('no key update');
		if (duplicate?.userId) return false; // that browser is an account's member; nothing to take over
		if (duplicate) {
			// Unfinished uploads first. A video being recorded at this very moment holds
			// its session row (see video-finalize.ts), so this waits for it, and the next
			// statement then sees and moves the item it became. The other way round, an
			// item recorded between the two statements would stay with the duplicate and
			// be deleted with it.
			await tx.update(uploadSessions).set({ memberId: member.id }).where(eq(uploadSessions.memberId, duplicate.id));
			await tx.update(photos).set({ memberId: member.id }).where(eq(photos.memberId, duplicate.id));
			await tx.execute(sql`
				insert into ${favorites} (member_id, photo_id, created_at)
				select ${member.id}, photo_id, created_at from ${favorites} where member_id = ${duplicate.id}
				on conflict do nothing`);
			await tx.delete(members).where(eq(members.id, duplicate.id)); // its favourites cascade
		}
		await tx.update(members).set({ deviceToken }).where(eq(members.id, member.id));
		return true;
	});
}
