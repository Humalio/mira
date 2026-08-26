import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from './db';
import { albumStamp, heardFromUpload, preparingVideos } from './pulse';
import { albums, members, moments, photos, uploadSessions, users } from './schema';
import { deleteMediaTree } from './storage';
import { finalizeStages } from './video-finalize';
import { GET as pulse } from '../../routes/a/[slug]/pulse/+server';
import { POST as upload } from '../../routes/a/[slug]/upload/+server';

// What an open album page learns without reloading: that something changed, and that
// a video is on its way, each only as far as that viewer is allowed to see.

describe('the album tells its open pages what is new and what is coming', () => {
	const owners: string[] = [];
	const slugs: string[] = [];

	afterAll(async () => {
		for (const id of owners) {
			await db.delete(albums).where(eq(albums.ownerUserId, id));
			await db.delete(users).where(eq(users.id, id));
		}
		for (const slug of slugs) await deleteMediaTree(slug);
	});

	async function album(autoApprove = true) {
		const ownerId = crypto.randomUUID();
		const albumId = crypto.randomUUID();
		const slug = `pulse-${albumId}`;
		owners.push(ownerId);
		slugs.push(slug);
		await db.insert(users).values({ id: ownerId, provider: 'test-pulse', providerAccountId: ownerId, quotaMb: 0 });
		const [row] = await db
			.insert(albums)
			.values({ id: albumId, slug, name: 'Pulse', ownerUserId: ownerId, autoApprove })
			.returning();
		const momentId = crypto.randomUUID();
		await db.insert(moments).values({ id: momentId, albumId, name: 'Day 1' });
		const person = async (name: string, userId: string | null) => {
			const id = crypto.randomUUID();
			const deviceToken = crypto.randomUUID();
			await db.insert(members).values({ id, albumId, deviceToken, displayName: name, userId });
			return {
				id,
				viewer: { memberId: id, isOwner: userId !== null },
				locals: { deviceToken, locale: 'en', auth: async () => (userId ? { user: { id: userId } } : null) }
			};
		};
		return {
			row,
			slug,
			momentId,
			owner: await person('Owner', ownerId),
			marta: await person('Marta', null),
			zoe: await person('Zoe', null)
		};
	}

	type Album = Awaited<ReturnType<typeof album>>;

	async function uploading(a: Album, memberId: string, fields: Partial<typeof uploadSessions.$inferInsert> = {}) {
		const id = crypto.randomUUID();
		await db.insert(uploadSessions).values({
			id,
			albumId: a.row.id,
			momentId: a.momentId,
			memberId,
			deviceToken: crypto.randomUUID(),
			mime: 'video/mp4',
			declaredBytes: 1000,
			chunkSize: 100,
			totalChunks: 10,
			receivedBytes: 400,
			state: 'receiving',
			approved: true,
			quality: 'small',
			expiresAt: new Date(Date.now() + 60 * 60_000),
			...fields
		});
		return id;
	}

	async function photo(a: Album, memberId: string, approved = true) {
		const id = crypto.randomUUID();
		await db.insert(photos).values({
			id,
			albumId: a.row.id,
			momentId: a.momentId,
			memberId,
			storageKey: `${a.slug}/${id}/orig.jpg`,
			thumbKey: `${a.slug}/${id}/thumb.webp`,
			mime: 'image/jpeg',
			sizeBytes: 10,
			approved
		});
		return id;
	}

	it('shows everyone a video that is uploading, with how far along it is', async () => {
		const a = await album();
		const id = await uploading(a, a.marta.id);
		// Nothing heard from it yet (or it was abandoned hours ago): not "on its way".
		expect(await preparingVideos(a.row.id, a.zoe.viewer)).toEqual([]);

		heardFromUpload(id);
		expect(await preparingVideos(a.row.id, a.zoe.viewer)).toEqual([
			{ id, memberId: a.marta.id, momentId: a.momentId, by: 'Marta', phase: 'uploading', percent: 40 }
		]);
	});

	it('keeps showing it while the server puts it together and makes the copy', async () => {
		const a = await album();
		const id = await uploading(a, a.marta.id, { state: 'completing', receivedBytes: 1000 });
		expect(await preparingVideos(a.row.id, a.zoe.viewer)).toMatchObject([{ id, phase: 'preparing', percent: null }]);

		finalizeStages.set(id, { phase: 'compressing', percent: 26 });
		expect(await preparingVideos(a.row.id, a.zoe.viewer)).toMatchObject([{ id, phase: 'compressing', percent: 26 }]);
		finalizeStages.delete(id);

		// Finished, failed or expired uploads are no longer on their way.
		await db.update(uploadSessions).set({ state: 'failed' }).where(eq(uploadSessions.id, id));
		expect(await preparingVideos(a.row.id, a.zoe.viewer)).toEqual([]);
		const expired = await uploading(a, a.marta.id, { state: 'completing', expiresAt: new Date(Date.now() - 1000) });
		expect((await preparingVideos(a.row.id, a.zoe.viewer)).map((w) => w.id)).not.toContain(expired);
	});

	it('shows a video that will need approval only to its uploader and the owner', async () => {
		const a = await album(false);
		const id = await uploading(a, a.marta.id, { state: 'completing', approved: false });
		expect(await preparingVideos(a.row.id, a.zoe.viewer)).toEqual([]);
		expect(await preparingVideos(a.row.id, a.marta.viewer)).toMatchObject([{ id }]);
		expect(await preparingVideos(a.row.id, a.owner.viewer)).toMatchObject([{ id }]);
	});

	it('changes the stamp exactly when what the viewer can see changes', async () => {
		const a = await album(false);
		const stamps = async () => ({
			owner: await albumStamp(a.row, a.owner.viewer),
			marta: await albumStamp(a.row, a.marta.viewer),
			zoe: await albumStamp(a.row, a.zoe.viewer)
		});
		const before = await stamps();
		expect(await stamps()).toEqual(before); // nothing happened: nothing to reload

		// Marta adds a photo that waits for approval: she and the owner see it, Zoe does not.
		const id = await photo(a, a.marta.id, false);
		const added = await stamps();
		expect(added.owner).not.toBe(before.owner);
		expect(added.marta).not.toBe(before.marta);
		expect(added.zoe).toBe(before.zoe);

		// The owner approves it: now it appears for Zoe, and the owner's queue shrinks.
		await db.update(photos).set({ approved: true }).where(eq(photos.id, id));
		const approved = await stamps();
		expect(approved.zoe).not.toBe(added.zoe);
		expect(approved.owner).not.toBe(added.owner);
		expect(approved.marta).not.toBe(added.marta);

		// Deleting, renaming a moment and a new guest are all visible changes too.
		await db.delete(photos).where(eq(photos.id, id));
		const deleted = await stamps();
		expect(deleted.zoe).not.toBe(approved.zoe);
		await db.update(moments).set({ name: 'Saturday' }).where(eq(moments.id, a.momentId));
		const renamed = await stamps();
		expect(renamed.zoe).not.toBe(deleted.zoe);
		await db
			.insert(members)
			.values({ id: crypto.randomUUID(), albumId: a.row.id, deviceToken: crypto.randomUUID(), displayName: 'Iker' });
		expect((await stamps()).zoe).not.toBe(renamed.zoe);
	});

	it('answers a member in one small reply and refuses anyone else', async () => {
		const a = await album();
		const id = await uploading(a, a.marta.id, { state: 'completing' });
		const ask = (locals: Album['zoe']['locals']) =>
			pulse({ params: { slug: a.slug }, locals } as unknown as Parameters<typeof pulse>[0]);
		const reply = await (await ask(a.zoe.locals)).json();
		expect(reply.stamp).toBe(await albumStamp(a.row, a.zoe.viewer));
		expect(reply.preparing).toMatchObject([{ id, by: 'Marta' }]);
		const stranger = { deviceToken: crypto.randomUUID(), locale: 'en', auth: async () => null };
		await expect(ask(stranger)).rejects.toMatchObject({ status: 403 });
	});

	it('tells the uploader when a photo is in but waiting for approval', async () => {
		const send = async (a: Album, locals: Album['zoe']['locals']) => {
			const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } })
				.jpeg()
				.toBuffer();
			const form = new FormData();
			form.append('momentId', a.momentId);
			form.append('photos', new File([new Uint8Array(image)], 'IMG_0001.jpg', { type: 'image/jpeg' }));
			const encoded = new Response(form);
			const body = Buffer.from(await encoded.arrayBuffer());
			const request = new Request(`http://localhost/a/${a.slug}/upload`, {
				method: 'POST',
				headers: { 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.length) },
				body
			});
			const response = await upload({ params: { slug: a.slug }, request, locals } as unknown as Parameters<
				typeof upload
			>[0]);
			return response.json();
		};
		const moderated = await album(false);
		expect(await send(moderated, moderated.marta.locals)).toMatchObject({ added: 1, pending: 1 });
		expect(await send(moderated, moderated.owner.locals)).toMatchObject({ added: 1, pending: 0 });
		const open = await album(true);
		expect(await send(open, open.marta.locals)).toMatchObject({ added: 1, pending: 0 });
	});
});
