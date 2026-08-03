/**
 * The invitation link of an album, and whether a visitor's link is still the current one.
 *
 * An album's link is `/j/<slug>`. When its owner resets the invitation, the album gets
 * an invite key and the link becomes `/j/<slug>?k=<key>`: the link and QR code handed
 * out earlier still name the album but no longer let anyone join. People already in
 * the album are not affected.
 */
import { timingSafeEqual } from 'node:crypto';
import { getAlbumOptions, saveAlbumOptions } from './album-options';
import { shortId } from './ids';
import { publicOrigin } from './origin';

/** The link to hand out for this album right now. */
export async function inviteUrl(slug: string, url: URL): Promise<string> {
	const { inviteKey } = await getAlbumOptions(slug);
	return `${publicOrigin(url)}/j/${slug}${inviteKey ? `?k=${inviteKey}` : ''}`;
}

/** Does this visitor's link carry the album's current invitation? */
export async function invitationValid(slug: string, url: URL): Promise<boolean> {
	const { inviteKey, unreadable } = await getAlbumOptions(slug);
	// Whether the invitation was replaced cannot be told right now: let nobody in.
	if (unreadable) return false;
	if (!inviteKey) return true;
	const given = Buffer.from(url.searchParams.get('k') ?? '');
	const wanted = Buffer.from(inviteKey);
	return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Replace the album's invitation: every link and QR code handed out before stops letting people in. */
export async function resetInvitation(slug: string): Promise<void> {
	await saveAlbumOptions(slug, { inviteKey: shortId(12) });
}
