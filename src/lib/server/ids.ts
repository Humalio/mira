import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Opaque primary key. */
export const newId = (): string => randomUUID();

/**
 * The id of the item a member uploads under a retry key of their own choosing.
 *
 * A browser sends a random key with each photo so that sending it again after a lost
 * answer is recognised instead of stored twice. The key must never be used as the
 * item's id directly: ids name folders on disk and rows other people own, and a key
 * chosen to equal somebody else's id would address their media. Hashing it together
 * with the member makes the result repeatable for that member (the same key gives the
 * same id, so a retry is recognised) and unreachable for everyone else. Members belong
 * to exactly one album, so the id is tied to the album as well.
 */
export function memberScopedId(memberId: string, clientKey: string): string {
	const h = createHash('sha256').update(`mira:media|${memberId}|${clientKey.toLowerCase()}`).digest('hex');
	// Laid out as a version-8 ("custom") UUID so it is valid wherever an id is expected.
	const variant = '89ab'[Number.parseInt(h[16], 16) & 3];
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Unambiguous alphabet (no 0/o/1/l) for human-shareable slugs.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Short random token for share links / QR. */
export function shortId(len = 6): string {
	const bytes = randomBytes(len);
	let out = '';
	for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
	return out;
}

/** Readable album slug with a random suffix. The suffix is the only secret gating
 * album access, so it carries 60 bits of entropy before rate limiting. */
export function slugify(name: string): string {
	const base =
		name
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 24) || 'album';
	return `${base}-${shortId(12)}`;
}
