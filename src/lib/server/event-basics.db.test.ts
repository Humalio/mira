import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAlbumOptions } from './album-options';
import { db } from './db';
import { invitationValid, inviteUrl, resetInvitation } from './invite';
import { OWNER_ISSUED_MS, canReturn, returnToken, returnTokenValid, takePlace, tokenMemberId } from './return-link';
import { albums, favorites, members, moments, photos, users } from './schema';
import { deleteMediaTree } from './storage';
import { actions as joinActions, load as joinLoad } from '../../routes/j/[slug]/+page.server';
import { POST as upload } from '../../routes/a/[slug]/upload/+server';
import { POST as videoInit } from '../../routes/a/[slug]/video/init/+server';

// What an event needs after the party: close the album, replace a link that travelled
// too far, and let a guest with a new phone back in as themselves.

describe('closing an album, resetting its link, and getting a guest back in', () => {
	const owners: string[] = [];
	const slugs: string[] = [];
	const secretBefore = process.env.AUTH_SECRET;

	beforeAll(() => {
		process.env.AUTH_SECRET = 'test-only-secret-for-return-links-0123456789';
	});
	afterAll(async () => {
		process.env.AUTH_SECRET = secretBefore;
		for (const id of owners) {
			await db.delete(albums).where(eq(albums.ownerUserId, id));
			await db.delete(users).where(eq(users.id, id));
		}
		for (const slug of slugs) await deleteMediaTree(slug);
	});

	async function album() {
		const ownerId = crypto.randomUUID();
		const albumId = crypto.randomUUID();
		const slug = `event-${albumId}`;
		owners.push(ownerId);
		slugs.push(slug);
		await db.insert(users).values({ id: ownerId, provider: 'test-event', providerAccountId: ownerId, quotaMb: 0 });
		await db.insert(albums).values({ id: albumId, slug, name: 'Ana 40', ownerUserId: ownerId });
		const momentId = crypto.randomUUID();
		await db.insert(moments).values({ id: momentId, albumId, name: 'Day 1' });
		const guest = async (name: string, userId: string | null = null) => {
			const id = crypto.randomUUID();
			const deviceToken = crypto.randomUUID();
			await db.insert(members).values({ id, albumId, deviceToken, displayName: name, userId });
			return { id, deviceToken };
		};
		return { albumId, slug, ownerId, momentId, guest };
	}
	const locals = (deviceToken: string) => ({ deviceToken, locale: 'en', auth: async () => null });
	const member = async (id: string) => (await db.select().from(members).where(eq(members.id, id)))[0];

	async function sendPhoto(slug: string, momentId: string, deviceToken: string) {
		const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } })
			.jpeg()
			.toBuffer();
		const form = new FormData();
		form.append('momentId', momentId);
		form.append('photos', new File([new Uint8Array(image)], 'IMG_1.jpg', { type: 'image/jpeg' }));
		const encoded = new Response(form);
		const body = Buffer.from(await encoded.arrayBuffer());
		return upload({
			params: { slug },
			request: new Request(`http://localhost/a/${slug}/upload`, {
				method: 'POST',
				headers: { 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.length) },
				body
			}),
			locals: locals(deviceToken)
		} as unknown as Parameters<typeof upload>[0]);
	}

	it('a closed album takes no new photos or videos, and a reopened one does', async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		expect((await sendPhoto(a.slug, a.momentId, marta.deviceToken)).status).toBe(200);

		await saveAlbumOptions(a.slug, { locked: true });
		await expect(sendPhoto(a.slug, a.momentId, marta.deviceToken)).rejects.toMatchObject({ status: 403 });
		const body = JSON.stringify({ momentId: a.momentId, mime: 'video/mp4', totalBytes: 1000 });
		const startVideo = () =>
			videoInit({
				params: { slug: a.slug },
				request: new Request(`http://localhost/a/${a.slug}/video/init`, {
					method: 'POST',
					headers: { 'content-length': String(body.length) },
					body
				}),
				locals: locals(marta.deviceToken)
			} as unknown as Parameters<typeof videoInit>[0]);
		await expect(startVideo()).rejects.toMatchObject({ status: 403 });
		// What is already there stays.
		expect(await db.select().from(photos).where(eq(photos.albumId, a.albumId))).toHaveLength(1);

		await saveAlbumOptions(a.slug, { locked: false });
		expect((await sendPhoto(a.slug, a.momentId, marta.deviceToken)).status).toBe(200);
	});

	it('resetting the invitation stops the old link and keeps the people already in', async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		const plain = new URL(`http://localhost/j/${a.slug}`);
		expect(await invitationValid(a.slug, plain)).toBe(true);
		expect(await inviteUrl(a.slug, plain)).toBe(`http://localhost/j/${a.slug}`);

		await resetInvitation(a.slug);
		const fresh = new URL(await inviteUrl(a.slug, plain));
		expect(fresh.searchParams.get('k')).toMatch(/^[a-z0-9]{12}$/);
		expect(await invitationValid(a.slug, fresh)).toBe(true);
		expect(await invitationValid(a.slug, plain)).toBe(false);
		expect(await invitationValid(a.slug, new URL(`${plain}?k=wrongwrongwr`))).toBe(false);

		// A newcomer with the old link sees "no longer works" and cannot join with it...
		const newcomer = locals(crypto.randomUUID());
		const event = (url: URL, name: string) => {
			const body = new URLSearchParams({ name }).toString();
			return {
				params: { slug: a.slug },
				url,
				locals: newcomer,
				request: new Request(url, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) },
					body
				}),
				getClientAddress: () => '127.0.0.1'
			};
		};
		const shown = await joinLoad(event(plain, 'Iker') as unknown as Parameters<typeof joinLoad>[0]);
		expect(shown).toMatchObject({ expired: true });
		await expect(
			joinActions.default(event(plain, 'Iker') as unknown as Parameters<typeof joinActions.default>[0])
		).rejects.toMatchObject({ status: 403 });
		// ...and gets in with the new one.
		await expect(
			joinActions.default(event(fresh, 'Iker') as unknown as Parameters<typeof joinActions.default>[0])
		).rejects.toMatchObject({ status: 303, location: `/a/${a.slug}` });
		// Marta, who joined before the reset, is still a member.
		expect(await member(marta.id)).toMatchObject({ deviceToken: marta.deviceToken });

		// A second reset replaces the key again.
		await resetInvitation(a.slug);
		expect(await invitationValid(a.slug, fresh)).toBe(false);
	});

	it('a return link moves a guest to a new device, exactly once', async () => {
		const a = await album();
		const zoe = await a.guest('Zoe');
		const token = returnToken(await member(zoe.id), OWNER_ISSUED_MS);
		expect(tokenMemberId(token)).toBe(zoe.id);
		expect(returnTokenValid(token, await member(zoe.id))).toBe(true);

		const newPhone = crypto.randomUUID();
		expect(await takePlace(token, zoe.id, newPhone)).toBe(true);
		expect((await member(zoe.id)).deviceToken).toBe(newPhone);

		// Used: the same link is worth nothing now, to anyone.
		expect(returnTokenValid(token, await member(zoe.id))).toBe(false);
		expect(await takePlace(token, zoe.id, crypto.randomUUID())).toBe(false);
		expect((await member(zoe.id)).deviceToken).toBe(newPhone);
	});

	it('refuses a link that is expired, altered, or for someone else', async () => {
		const a = await album();
		const zoe = await member((await a.guest('Zoe')).id);
		const other = await member((await a.guest('Iker')).id);
		const token = returnToken(zoe, OWNER_ISSUED_MS);

		expect(returnTokenValid(returnToken(zoe, -1), zoe)).toBe(false); // already expired
		expect(returnTokenValid(token, zoe, Date.now() + OWNER_ISSUED_MS + 1)).toBe(false);
		expect(returnTokenValid(token, other)).toBe(false);
		// Stretching the expiry or renaming the guest breaks the signature.
		const [id, expires, signature] = token.split('.');
		expect(returnTokenValid(`${id}.${(Date.now() + 10 * OWNER_ISSUED_MS).toString(36)}.${signature}`, zoe)).toBe(false);
		expect(returnTokenValid(`${other.id}.${expires}.${signature}`, other)).toBe(false);
		expect(tokenMemberId('not-a-token')).toBeNull();
		expect(await takePlace(`${id}.${expires}.${'x'.repeat(signature.length)}`, zoe.id, crypto.randomUUID())).toBe(
			false
		);
	});

	it('folds "Zoe (2)" back into Zoe when the new phone had already joined again', async () => {
		const a = await album();
		const zoe = await a.guest('Zoe');
		const again = await a.guest('Zoe'); // the new phone joined afresh before asking for help
		const picture = async (memberId: string) => {
			const id = crypto.randomUUID();
			await db.insert(photos).values({
				id,
				albumId: a.albumId,
				momentId: a.momentId,
				memberId,
				storageKey: `${a.slug}/${id}/orig.jpg`,
				thumbKey: `${a.slug}/${id}/thumb.webp`,
				mime: 'image/jpeg',
				sizeBytes: 5
			});
			return id;
		};
		const old = await picture(zoe.id);
		const recent = await picture(again.id);
		await db.insert(favorites).values([
			{ memberId: zoe.id, photoId: old },
			{ memberId: again.id, photoId: old }, // the same favourite on both: must not clash
			{ memberId: again.id, photoId: recent }
		]);

		expect(await takePlace(returnToken(await member(zoe.id), OWNER_ISSUED_MS), zoe.id, again.deviceToken)).toBe(true);

		expect(await member(again.id)).toBeUndefined();
		expect((await member(zoe.id)).deviceToken).toBe(again.deviceToken);
		const hers = await db.select({ id: photos.id }).from(photos).where(eq(photos.memberId, zoe.id));
		expect(hers.map((p) => p.id).sort()).toEqual([old, recent].sort());
		const liked = await db.select().from(favorites).where(eq(favorites.memberId, zoe.id));
		expect(liked.map((f) => f.photoId).sort()).toEqual([old, recent].sort());
	});

	it('never moves someone who has an account', async () => {
		const a = await album();
		const owner = await a.guest('Owner', a.ownerId);
		const row = await member(owner.id);
		expect(canReturn(row)).toBe(false);
		expect(await takePlace(returnToken(row, OWNER_ISSUED_MS), owner.id, crypto.randomUUID())).toBe(false);
		expect((await member(owner.id)).deviceToken).toBe(owner.deviceToken);
	});
});
