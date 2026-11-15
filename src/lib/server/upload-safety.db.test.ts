import { eq, inArray } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as admin from './admin';
import { db } from './db';
import { memberScopedId } from './ids';
import { LIMITS } from './input';
import { lockOwner } from './locks';
import { drainMediaDeletions, enqueueMediaDeletion } from './media-deletions';
import { OWNER_ISSUED_MS, returnLinkTarget, returnToken, takePlace } from './return-link';
import { albums, mediaDeletions, members, moments, photos, uploadSessions, users } from './schema';
import * as storage from './storage';
import { UPLOAD_QUIET_MS, UPLOAD_TTL_MS } from './uploads';
import { getSettings } from './users';
import { finalizeReady, finalizeRetries, startFinalization } from './video-finalize';
import { POST as upload } from '../../routes/a/[slug]/upload/+server';
import { POST as videoAbort } from '../../routes/a/[slug]/video/abort/+server';
import { POST as videoChunk } from '../../routes/a/[slug]/video/chunk/+server';
import { POST as videoComplete } from '../../routes/a/[slug]/video/complete/+server';
import { POST as videoInit } from '../../routes/a/[slug]/video/init/+server';

// Things that used to cost somebody a photo or a video they had already sent: another
// guest's retry key, a dead upload holding the quota, a passing failure while a video
// was being put together, a page that was closed while it waited its turn.

describe('uploads are not lost to other people, limits or passing failures', () => {
	const owners: string[] = [];
	const slugs: string[] = [];
	const uploads: string[] = [];
	const secretBefore = process.env.AUTH_SECRET;

	beforeAll(() => {
		process.env.AUTH_SECRET = 'test-only-secret-for-return-links-0123456789';
	});
	afterAll(async () => {
		process.env.AUTH_SECRET = secretBefore;
		for (const id of owners) {
			await db.delete(albums).where(eq(albums.ownerUserId, id));
			await db.delete(mediaDeletions).where(eq(mediaDeletions.ownerId, id));
			await db.delete(users).where(eq(users.id, id));
		}
		for (const id of uploads) await storage.cleanupUpload(id);
		for (const slug of slugs) await storage.deleteMediaTree(slug);
	});

	async function album(quotaMb = 0) {
		const ownerId = crypto.randomUUID();
		const albumId = crypto.randomUUID();
		const slug = `safety-${albumId}`;
		owners.push(ownerId);
		slugs.push(slug);
		await db.insert(users).values({ id: ownerId, provider: 'test-safety', providerAccountId: ownerId, quotaMb });
		await db.insert(albums).values({ id: albumId, slug, name: 'Safety', ownerUserId: ownerId });
		const momentId = crypto.randomUUID();
		await db.insert(moments).values({ id: momentId, albumId, name: 'Day 1' });
		const guest = async (name: string) => {
			const id = crypto.randomUUID();
			const deviceToken = crypto.randomUUID();
			await db.insert(members).values({ id, albumId, deviceToken, displayName: name });
			return { id, deviceToken };
		};
		return { albumId, slug, ownerId, momentId, guest };
	}
	type Album = Awaited<ReturnType<typeof album>>;
	type Guest = Awaited<ReturnType<Album['guest']>>;
	const locals = (deviceToken: string) => ({ deviceToken, locale: 'en', auth: async () => null });
	const member = async (id: string) => (await db.select().from(members).where(eq(members.id, id)))[0];
	const sessionOf = async (id: string) => (await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)))[0];
	const picture = (width = 8, height = 8) =>
		sharp({ create: { width, height, channels: 3, background: '#c33' }, limitInputPixels: false })
			.jpeg()
			.toBuffer();

	async function sendPhoto(a: Album, who: Guest, file: Buffer, clientId?: string) {
		const form = new FormData();
		form.append('momentId', a.momentId);
		if (clientId) form.append('clientId', clientId);
		form.append('photos', new File([new Uint8Array(file)], 'IMG_1.jpg', { type: 'image/jpeg' }));
		const encoded = new Response(form);
		const body = Buffer.from(await encoded.arrayBuffer());
		const response = await upload({
			params: { slug: a.slug },
			request: new Request(`http://localhost/a/${a.slug}/upload`, {
				method: 'POST',
				headers: { 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.length) },
				body
			}),
			locals: locals(who.deviceToken)
		} as unknown as Parameters<typeof upload>[0]);
		return response.json();
	}

	function startVideo(
		a: Album,
		who: Guest,
		totalBytes: number,
		browser: object = locals(who.deviceToken),
		clientId?: string
	) {
		const body = JSON.stringify({ momentId: a.momentId, mime: 'video/mp4', totalBytes, clientId });
		return videoInit({
			params: { slug: a.slug },
			request: new Request(`http://localhost/a/${a.slug}/video/init`, {
				method: 'POST',
				headers: { 'content-length': String(body.length) },
				body
			}),
			locals: browser
		} as unknown as Parameters<typeof videoInit>[0]);
	}

	/** Send chunk 0 of `bytes` bytes, from `browser` (see `locals`). */
	function sendChunk(a: Album, browser: object, uploadId: string, bytes: number) {
		const url = new URL(`http://localhost/a/${a.slug}/video/chunk?uploadId=${uploadId}&index=0`);
		return videoChunk({
			params: { slug: a.slug },
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-length': String(bytes) },
				body: new Uint8Array(bytes)
			}),
			url,
			locals: browser
		} as unknown as Parameters<typeof videoChunk>[0]);
	}

	function cancelVideo(a: Album, browser: object, uploadId: string) {
		const url = new URL(`http://localhost/a/${a.slug}/video/abort?uploadId=${uploadId}`);
		return videoAbort({
			params: { slug: a.slug },
			url,
			locals: browser
		} as unknown as Parameters<typeof videoAbort>[0]);
	}

	function finishVideo(a: Album, browser: object, uploadId: string) {
		const body = JSON.stringify({ uploadId });
		return videoComplete({
			params: { slug: a.slug },
			request: new Request('http://localhost/complete', {
				method: 'POST',
				headers: { 'content-length': String(body.length) },
				body
			}),
			locals: browser
		} as unknown as Parameters<typeof videoComplete>[0]);
	}

	/** A three-byte "video" whose every chunk has arrived and which nobody has asked to finish yet. */
	async function received(a: Album, who: Guest) {
		const id = crypto.randomUUID();
		uploads.push(id);
		await storage.createUpload(id);
		await storage.writeChunk(id, 0, Buffer.from('abc'));
		await db.insert(uploadSessions).values({
			id,
			albumId: a.albumId,
			momentId: a.momentId,
			memberId: who.id,
			deviceToken: who.deviceToken,
			mime: 'video/mp4',
			declaredBytes: 3,
			chunkSize: 3,
			totalChunks: 1,
			receivedBytes: 3,
			approved: true,
			quality: 'original',
			expiresAt: new Date(Date.now() + UPLOAD_TTL_MS)
		});
		return id;
	}
	const complete = async (id: string) => expect((await sessionOf(id)).state, `upload ${id}`).toBe('complete');

	it("a retry key reaches the sender's own photo and nobody else's media", async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		const iker = await a.guest('Iker');
		const key = crypto.randomUUID();
		const image = await picture();

		// The answer got lost, the browser sends the same photo again: still one photo.
		expect(await sendPhoto(a, marta, image, key)).toMatchObject({ added: 1 });
		expect(await sendPhoto(a, marta, image, key)).toMatchObject({ added: 1, duplicate: true });
		const hers = await db.select().from(photos).where(eq(photos.albumId, a.albumId));
		expect(hers).toHaveLength(1);
		expect(hers[0]).toMatchObject({ id: memberScopedId(marta.id, key), memberId: marta.id });
		expect(hers[0].id).not.toBe(key);

		// The same key from someone else is simply their own photo, not a clash with hers.
		expect(await sendPhoto(a, iker, image, key)).toMatchObject({ added: 1 });
		expect(await db.select().from(photos).where(eq(photos.albumId, a.albumId))).toHaveLength(2);

		// A video of Marta's is being prepared; every member can see its id. Iker sends
		// that id as his "retry key", with a file that fails and with one that works.
		const video = crypto.randomUUID();
		await storage.ensureMediaItemDir(a.slug, video);
		const original = storage.mediaWritePath(`${a.slug}/${video}/orig.mp4`);
		await writeFile(original, 'precious');
		const refused = await sendPhoto(a, iker, Buffer.from('not an image'), video);
		expect(refused).toMatchObject({ added: 0, skipped: [{ reason: 'unsupported' }] });
		expect(await readFile(original, 'utf8')).toBe('precious');
		expect(await sendPhoto(a, iker, image, video)).toMatchObject({ added: 1 });
		expect(await readdir(storage.mediaWritePath(`${a.slug}/${video}`))).toEqual(['orig.mp4']);
		expect(await db.select().from(photos).where(eq(photos.id, video))).toHaveLength(0);
	});

	it('says so when a photo has too many pixels', async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		const side = Math.ceil(Math.sqrt(LIMITS.imagePixels)) + 8;
		const answer = await sendPhoto(a, marta, await picture(side, side));
		expect(answer).toMatchObject({
			added: 0,
			skipped: [{ reason: 'too_many_pixels' }],
			maxMegapixels: LIMITS.imagePixels / 1_000_000
		});
		expect(await db.select().from(photos).where(eq(photos.albumId, a.albumId))).toHaveLength(0);
	}, 60_000);

	it("abandoned video uploads do not hold the owner's storage, live ones do", async () => {
		const a = await album(1); // 1 MB for everything
		const marta = await a.guest('Marta');
		const iker = await a.guest('Iker');
		// Three of Marta's uploads died an hour ago with nothing sent: 900 KB "declared".
		const dead = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
		for (const id of dead) {
			await db.insert(uploadSessions).values({
				id,
				albumId: a.albumId,
				momentId: a.momentId,
				memberId: marta.id,
				deviceToken: marta.deviceToken,
				mime: 'video/mp4',
				declaredBytes: 300_000,
				chunkSize: 300_000,
				totalChunks: 1,
				approved: true,
				quality: 'original',
				expiresAt: new Date(Date.now() + UPLOAD_TTL_MS - UPLOAD_QUIET_MS - 60_000)
			});
		}
		// They neither fill the album nor count as "three uploads already running".
		const started = await startVideo(a, marta, 500_000);
		expect(started.status).toBe(200);
		uploads.push((await started.json()).uploadId);
		// That one is under way and holds what it declared: 500 KB + 600 KB is over 1 MB.
		await expect(startVideo(a, iker, 600_000)).rejects.toMatchObject({ status: 413 });
		const fits = await startVideo(a, iker, 400_000);
		expect(fits.status).toBe(200);
		uploads.push((await fits.json()).uploadId);

		// A dead upload that comes back to life holds its space again.
		await db
			.update(uploadSessions)
			.set({ expiresAt: new Date(Date.now() + UPLOAD_TTL_MS) })
			.where(eq(uploadSessions.id, dead[0]));
		await expect(startVideo(a, iker, 100_000)).rejects.toMatchObject({ status: 413 });
	});

	it('a photo whose retry recorded it first is kept, even when the second copy is over the limit', async () => {
		const a = await album(1);
		const marta = await a.guest('Marta');
		const image = await picture();
		// The account is all but full: room for this photo once, not twice.
		await db
			.update(users)
			.set({ usedBytes: 1024 * 1024 - image.length - 10 })
			.where(eq(users.id, a.ownerId));
		// A proxy timed out and the browser sent the same photo again while the first was
		// still being processed: both are on their way at once, with the same retry key.
		// The one that loses the race is over the limit, and used to delete the folder the
		// winner's row points at.
		const key = crypto.randomUUID();
		const answers = await Promise.all([sendPhoto(a, marta, image, key), sendPhoto(a, marta, image, key)]);
		for (const answer of answers) expect(answer).toMatchObject({ added: 1, skipped: [] });
		const kept = await db.select().from(photos).where(eq(photos.albumId, a.albumId));
		expect(kept).toHaveLength(1);
		expect(kept[0].id).toBe(memberScopedId(marta.id, key));
		expect(await storage.mediaFilesExist(kept[0].storageKey, kept[0].thumbKey)).toBe(true);
	});

	it('a video upload that went quiet must fit again when it comes back', async () => {
		const a = await album(1); // 1 MB for everything
		const marta = await a.guest('Marta');
		const iker = await a.guest('Iker');
		const started = await startVideo(a, marta, 600_000);
		const { uploadId } = await started.json();
		uploads.push(uploadId);
		// Her phone slept for an hour with nothing sent: her upload holds only what arrived,
		// and Iker's video is let into the rest.
		await db
			.update(uploadSessions)
			.set({ expiresAt: new Date(Date.now() + UPLOAD_TTL_MS - UPLOAD_QUIET_MS - 60_000) })
			.where(eq(uploadSessions.id, uploadId));
		const his = await startVideo(a, iker, 500_000);
		const hisId = (await his.json()).uploadId;
		uploads.push(hisId);
		// When her phone wakes, her upload may not simply take that space back: both could
		// not finish, and one of them would fail at the very end. She is told now.
		await expect(sendChunk(a, locals(marta.deviceToken), uploadId, 600_000)).rejects.toMatchObject({ status: 413 });
		expect((await sessionOf(uploadId)).receivedBytes).toBe(0);
		// Once his upload is cancelled the space is free again, and hers carries on.
		await cancelVideo(a, locals(iker.deviceToken), hisId);
		expect((await sessionOf(hisId)).state).toBe('failed');
		expect((await sendChunk(a, locals(marta.deviceToken), uploadId, 600_000)).status).toBe(200);
		expect((await sessionOf(uploadId)).receivedBytes).toBe(600_000);
		await cancelVideo(a, locals(marta.deviceToken), uploadId); // nothing more to test on it
	});

	it('a video init sent again after its answer was lost gets the same upload back', async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		const phone = locals(marta.deviceToken);
		const key = crypto.randomUUID();
		const first = await (await startVideo(a, marta, 3_000, phone, key)).json();
		uploads.push(first.uploadId);
		// Not a second empty upload holding the quota and one of her three places.
		expect(await (await startVideo(a, marta, 3_000, phone, key)).json()).toEqual({ ...first, duplicate: true });
		expect(await db.select().from(uploadSessions).where(eq(uploadSessions.memberId, marta.id))).toHaveLength(1);
		// The same key names a photo elsewhere, never this upload (whose id becomes the video's).
		expect(first.uploadId).not.toBe(memberScopedId(marta.id, key));
		// The key is not reused for a different file.
		await expect(startVideo(a, marta, 4_000, phone, key)).rejects.toMatchObject({ status: 409 });
		await cancelVideo(a, phone, first.uploadId);
	});

	it('says at once that uploads are paused, with a status the page does not retry', async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		const before = await getSettings();
		await admin.saveMaintenance({ uploadsPaused: true, albumCreationPaused: before.albumCreationPaused });
		try {
			await expect(sendPhoto(a, marta, await picture())).rejects.toMatchObject({ status: 423 });
			await expect(startVideo(a, marta, 3_000)).rejects.toMatchObject({ status: 423 });
		} finally {
			await admin.saveMaintenance({
				uploadsPaused: before.uploadsPaused,
				albumCreationPaused: before.albumCreationPaused
			});
		}
	});

	it("a browser whose account signed out cannot touch that account's video uploads", async () => {
		const a = await album();
		// The owner uploads from a shared laptop while signed in.
		const laptop = { id: crypto.randomUUID(), deviceToken: crypto.randomUUID() };
		await db.insert(members).values({ ...laptop, albumId: a.albumId, userId: a.ownerId, displayName: 'Owner' });
		const owner = { deviceToken: laptop.deviceToken, locale: 'en', auth: async () => ({ user: { id: a.ownerId } }) };
		const { uploadId } = await (await startVideo(a, laptop, 3, owner)).json();
		uploads.push(uploadId);
		// They sign out. The next person at that laptop has the same device token.
		const next = locals(laptop.deviceToken);
		await expect(sendChunk(a, next, uploadId, 3)).rejects.toMatchObject({ status: 403 });
		await expect(finishVideo(a, next, uploadId)).rejects.toMatchObject({ status: 403 });
		await cancelVideo(a, next, uploadId);
		expect((await sessionOf(uploadId)).state).toBe('receiving');
		// The account itself still can.
		expect((await sendChunk(a, owner, uploadId, 3)).status).toBe(200);
		await cancelVideo(a, owner, uploadId);
		expect((await sessionOf(uploadId)).state).toBe('failed');
	});

	it('keeps a video when the database is away just as it is recorded, and finishes it later', async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		const id = await received(a, marta);
		const lost = () => Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
		// The answer to the insert is lost, and a moment later the database still cannot say
		// whether it went through. The upload used to be left claimed with nobody renewing
		// its lease, and the expiry sweep deleted every chunk half an hour later.
		const away = vi.spyOn(PgDatabase.prototype, 'select');
		const admit = vi.spyOn(admin, 'admitWithinQuota').mockImplementationOnce(async () => {
			away.mockImplementationOnce(() => {
				throw lost();
			});
			throw lost();
		});
		try {
			expect(await startFinalization(id)).toBe('started');
			await vi.waitFor(
				async () => {
					expect(finalizeRetries.get(id)?.attempt).toBe(1);
					expect((await sessionOf(id)).state).toBe('receiving');
				},
				{ timeout: 15_000 }
			);
			expect(away).toHaveBeenCalled();
		} finally {
			admit.mockRestore();
			away.mockRestore();
		}
		expect((await storage.readChunk(id, 0)).toString()).toBe('abc');
		finalizeRetries.set(id, { attempt: 1, notBefore: 0 });
		await finalizeReady();
		await vi.waitFor(() => complete(id), { timeout: 15_000 });
	}, 40_000);

	it('uploads waiting out a pause after a failure do not hold up newer ones', async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		// More than a query's worth of older uploads failed for a passing reason a moment
		// ago and are waiting to be tried again. They used to fill the whole batch.
		const paused = Array.from({ length: 21 }, () => crypto.randomUUID());
		for (const id of paused) {
			await db.insert(uploadSessions).values({
				id,
				albumId: a.albumId,
				momentId: a.momentId,
				memberId: marta.id,
				deviceToken: marta.deviceToken,
				mime: 'video/mp4',
				declaredBytes: 3,
				chunkSize: 3,
				totalChunks: 1,
				receivedBytes: 3,
				approved: true,
				quality: 'original',
				expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
				createdAt: new Date(Date.now() - 60 * 60_000)
			});
			finalizeRetries.set(id, { attempt: 1, notBefore: Date.now() + 60 * 60_000 });
		}
		try {
			const fresh = await received(a, marta);
			expect(await finalizeReady()).toBeGreaterThanOrEqual(1);
			await vi.waitFor(() => complete(fresh), { timeout: 15_000 });
			for (const id of paused) expect((await sessionOf(id)).state).toBe('receiving');
		} finally {
			for (const id of paused) finalizeRetries.delete(id);
			await db.update(uploadSessions).set({ state: 'failed' }).where(inArray(uploadSessions.id, paused));
		}
	}, 40_000);

	it('keeps a fully uploaded video through a passing failure and finishes it later', async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		const id = await received(a, marta);
		// The disk is too full at this moment (another video is being assembled).
		const full = vi
			.spyOn(storage, 'reserveVideoSpace')
			.mockRejectedValueOnce(new Error('Insufficient temporary media storage'));
		try {
			expect(await startFinalization(id)).toBe('started');
			await vi.waitFor(
				async () => {
					expect(finalizeRetries.get(id)?.attempt).toBe(1);
					expect((await sessionOf(id)).state).toBe('receiving');
				},
				{ timeout: 15_000 }
			);
		} finally {
			full.mockRestore();
		}
		// Nothing was thrown away: every chunk is there, the session is kept well beyond
		// the pause, and the uploader's page is told to keep waiting, not that it failed.
		expect((await storage.readChunk(id, 0)).toString()).toBe('abc');
		expect((await sessionOf(id)).expiresAt.getTime()).toBeGreaterThan(Date.now() + UPLOAD_TTL_MS);
		expect(await db.select().from(photos).where(eq(photos.id, id))).toHaveLength(0);
		const body = JSON.stringify({ uploadId: id });
		const polled = await videoComplete({
			params: { slug: a.slug },
			request: new Request('http://localhost/complete', {
				method: 'POST',
				headers: { 'content-length': String(body.length) },
				body
			}),
			locals: locals(marta.deviceToken)
		} as unknown as Parameters<typeof videoComplete>[0]);
		expect(polled.status).toBe(202);
		expect(await polled.json()).toEqual({ status: 'waiting' });

		// The pause is over. The server tries again by itself; nobody has to ask.
		finalizeRetries.set(id, { attempt: 1, notBefore: 0 });
		expect(await finalizeReady()).toBeGreaterThanOrEqual(1);
		await vi.waitFor(() => complete(id), { timeout: 15_000 });
		const [video] = await db.select().from(photos).where(eq(photos.id, id));
		expect(video).toMatchObject({ kind: 'video', memberId: marta.id, sizeBytes: 3 });
		expect(await readFile(storage.mediaWritePath(video.storageKey), 'utf8')).toBe('abc');
		expect(finalizeRetries.has(id)).toBe(false);
	}, 40_000);

	it('records a video under the returning guest when their duplicate is folded in meanwhile', async () => {
		const a = await album();
		const zoe = await a.guest('Zoe');
		const again = await a.guest('Zoe'); // her new phone joined afresh and uploaded a video
		const id = await received(a, again);
		let unblock!: () => void;
		const barrier = new Promise<void>((resolve) => (unblock = resolve));
		const assemble = storage.assembleUpload;
		const slow = vi.spyOn(storage, 'assembleUpload').mockImplementation(async (...args) => {
			await barrier;
			return assemble(...args);
		});
		try {
			expect(await startFinalization(id)).toBe('started');
			// While it is being put together she opens her return link on the new phone.
			const token = returnToken((await returnLinkTarget(zoe.id))!, OWNER_ISSUED_MS);
			expect(await takePlace(token, zoe.id, again.deviceToken)).toBe(true);
			expect(await member(again.id)).toBeUndefined();
		} finally {
			unblock();
		}
		try {
			await vi.waitFor(() => complete(id), { timeout: 15_000 });
		} finally {
			slow.mockRestore();
		}
		const [video] = await db.select().from(photos).where(eq(photos.id, id));
		expect(video).toMatchObject({ kind: 'video', memberId: zoe.id });
	}, 40_000);

	it("removes a deleted album's files without holding up its owner's other uploads", async () => {
		const a = await album();
		const marta = await a.guest('Marta');
		// An album of this owner was deleted; its folder is still on disk.
		const gone = `safety-gone-${crypto.randomUUID()}`;
		slugs.push(gone);
		await storage.ensureMediaItemDir(gone, 'item');
		await writeFile(storage.mediaWritePath(`${gone}/item/orig.jpg`), 'old');
		await sendPhoto(a, marta, await picture(), crypto.randomUUID());
		const [kept] = await db.select().from(photos).where(eq(photos.albumId, a.albumId));
		await db.transaction(async (tx) => {
			await enqueueMediaDeletion(tx, a.ownerId, gone);
			await enqueueMediaDeletion(tx, a.ownerId, a.slug); // a stale row naming a living album
		});

		// Someone is uploading to another album of the same owner right now: that holds
		// the owner's lock. The sweep used to wait for it (and uploads for the sweep).
		const began = Date.now();
		await db.transaction(async (tx) => {
			await lockOwner(tx, a.ownerId);
			await drainMediaDeletions();
			expect(existsSync(storage.mediaWritePath(gone))).toBe(false);
		});
		expect(Date.now() - began).toBeLessThan(4_000);
		expect(await db.select().from(mediaDeletions).where(eq(mediaDeletions.ownerId, a.ownerId))).toHaveLength(0);
		// The stale row did not cost the living album its folder.
		expect(existsSync(storage.mediaWritePath(kept.storageKey))).toBe(true);

		// A photo that was deleted and, through a retry, exists again at the same address:
		// the queued removal of its folder is dropped, not carried out.
		await db.transaction((tx) => enqueueMediaDeletion(tx, a.ownerId, `${a.slug}/${kept.id}`));
		await drainMediaDeletions();
		expect(await db.select().from(mediaDeletions).where(eq(mediaDeletions.ownerId, a.ownerId))).toHaveLength(0);
		expect(existsSync(storage.mediaWritePath(kept.storageKey))).toBe(true);
	}, 30_000);
});
