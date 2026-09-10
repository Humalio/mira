import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAlbumOptions } from './album-options';
import { db } from './db';
import { drainMediaDeletions } from './media-deletions';
import { placeOf } from './place';
import { albums, favorites, members, moments, photos, uploadSessions, users, mediaDeletions } from './schema';
import {
	cleanupUpload,
	createUpload,
	deleteMediaTree,
	ensureMediaItemDir,
	mediaWritePath,
	saveUploadName,
	writeChunk
} from './storage';
import { cleanupExpiredUploadSessions } from './uploads';
import { resumeInterruptedFinalizations, runFinalization } from './video-finalize';
import { translator } from '#lib/i18n/index.js';
import { GET as media } from '../../routes/media/[...key]/+server';
import { GET as download } from '../../routes/a/[slug]/download/+server';
import { POST as remove } from '../../routes/a/[slug]/delete/+server';

// "Keep both videos", end to end against a real database and a real ffmpeg: what is
// stored, what plays, what downloads, what it costs the owner, and what a crash leaves.
// Every clip is synthetic.
const has = (bin: string) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
const enabled = has('ffmpeg') && has('ffprobe');
if (!enabled && process.env.TEST_REQUIRE_FFMPEG === '1') throw new Error('ffmpeg and ffprobe are required');

describe.skipIf(!enabled)('a video keeps its original beside the playback copy', () => {
	const t = translator('en');
	const CHUNK = 256 * 1024;
	const sha = (data: Buffer | Uint8Array) => createHash('sha256').update(data).digest('hex');
	let work: string;
	let clip: Buffer;
	const MB = 1024 * 1024;
	const owners: string[] = [];
	const slugs: string[] = [];
	const uploads: string[] = [];

	beforeAll(() => {
		work = mkdtempSync(join(tmpdir(), 'mira-originals-'));
		const path = join(work, 'clip.mp4');
		// Noisy, so the original is large for its length and the copy clearly smaller.
		execFileSync('ffmpeg', [
			...['-hide_banner', '-loglevel', 'error', '-y'],
			...['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30,noise=alls=20:allf=t'],
			...['-f', 'lavfi', '-i', 'sine=frequency=440'],
			...['-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '3M', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
			...['-metadata', 'creation_time=2026-08-01T10:00:00Z', '-metadata', 'location=+43.3183-001.9812/'],
			path
		]);
		clip = readFileSync(path);
	});

	afterAll(async () => {
		for (const id of owners) {
			await db.delete(albums).where(eq(albums.ownerUserId, id));
			await db.delete(mediaDeletions).where(eq(mediaDeletions.ownerId, id));
			await db.delete(users).where(eq(users.id, id));
		}
		for (const id of uploads) await cleanupUpload(id);
		for (const slug of slugs) await deleteMediaTree(slug);
		rmSync(work, { recursive: true, force: true });
	});

	/** A fresh owner, album, moment and two members: the owner and a guest. */
	async function album(opts: { quality?: 'original' | 'small'; quotaMb?: number | null; autoApprove?: boolean } = {}) {
		const ownerId = crypto.randomUUID();
		const albumId = crypto.randomUUID();
		const slug = `originals-${albumId}`;
		owners.push(ownerId);
		slugs.push(slug);
		await db.insert(users).values({
			id: ownerId,
			provider: 'test-originals',
			providerAccountId: ownerId,
			quotaMb: opts.quotaMb ?? 0 // 0 = unlimited, whatever the instance default is
		});
		const [row] = await db
			.insert(albums)
			.values({
				id: albumId,
				slug,
				name: 'Originals',
				ownerUserId: ownerId,
				videoQuality: opts.quality ?? 'small',
				autoApprove: opts.autoApprove ?? true
			})
			.returning();
		const momentId = crypto.randomUUID();
		await db.insert(moments).values({ id: momentId, albumId, name: 'Day 1' });
		const person = async (name: string, userId: string | null) => {
			const id = crypto.randomUUID();
			const deviceToken = crypto.randomUUID();
			await db.insert(members).values({ id, albumId, deviceToken, displayName: name, userId });
			return {
				id,
				locals: { deviceToken, locale: 'en', auth: async () => (userId ? { user: { id: userId } } : null) }
			};
		};
		return { row, slug, ownerId, momentId, owner: await person('Owner', ownerId), guest: await person('Marta', null) };
	}

	/** Put the clip on the server as a fully received upload, as the chunk endpoint would. */
	async function received(
		a: Awaited<ReturnType<typeof album>>,
		memberId: string,
		state = 'completing',
		approved = true
	) {
		const id = crypto.randomUUID();
		uploads.push(id);
		await createUpload(id);
		await saveUploadName(id, 'VID_2041.MP4'); // what the phone called it
		const totalChunks = Math.ceil(clip.length / CHUNK);
		for (let i = 0; i < totalChunks; i++) await writeChunk(id, i, clip.subarray(i * CHUNK, (i + 1) * CHUNK));
		const [session] = await db
			.insert(uploadSessions)
			.values({
				id,
				albumId: a.row.id,
				momentId: a.momentId,
				memberId,
				deviceToken: crypto.randomUUID(),
				mime: 'video/mp4',
				declaredBytes: clip.length,
				chunkSize: CHUNK,
				totalChunks,
				receivedBytes: clip.length,
				state,
				approved,
				quality: a.row.videoQuality,
				expiresAt: new Date(Date.now() + 30 * 60_000)
			})
			.returning();
		return session;
	}

	async function added(a: Awaited<ReturnType<typeof album>>, memberId: string, approved = true) {
		const session = await received(a, memberId, 'completing', approved);
		await runFinalization(session, a.row, t);
		const [video] = await db.select().from(photos).where(eq(photos.id, session.id));
		return video;
	}

	const usedBytes = async (ownerId: string) =>
		(await db.select({ b: users.usedBytes }).from(users).where(eq(users.id, ownerId)))[0].b;

	type Locals = Awaited<ReturnType<typeof album>>['owner']['locals'];
	const fetchMedia = async (id: string, variant: string, locals: Locals, query = '') => {
		const url = new URL(`http://localhost/media/${id}/${variant}${query}`);
		const headers: Record<string, string> = {};
		const response = await media({
			params: { key: `${id}/${variant}` },
			request: new Request(url),
			url,
			locals,
			setHeaders: (h: Record<string, string>) => Object.assign(headers, h)
		} as unknown as Parameters<typeof media>[0]);
		return { headers, body: Buffer.from(await response.arrayBuffer()) };
	};
	const fetchZip = async (slug: string, locals: Locals, query: string) => {
		const url = new URL(`http://localhost/a/${slug}/download?${query}`);
		const response = await download({ params: { slug }, url, locals } as unknown as Parameters<typeof download>[0]);
		return Buffer.from(await response.arrayBuffer());
	};
	/** How many files a ZIP holds, from the record that ends every archive. */
	const entries = (zip: Buffer) => {
		const end = zip.length - 22;
		expect(zip.readUInt32LE(end)).toBe(0x06054b50);
		return zip.readUInt16LE(end + 10);
	};

	it('stores the upload untouched plus a smaller copy, and charges the owner for both', async () => {
		const a = await album();
		const video = await added(a, a.guest.id);
		const original = mediaWritePath(`${a.slug}/${video.id}/orig.mp4`);
		const copy = mediaWritePath(`${a.slug}/${video.id}/opt.mp4`);

		expect(video).toMatchObject({ kind: 'video', optimized: true, mime: 'video/mp4' });
		expect(video.storageKey).toBe(`${a.slug}/${video.id}/orig.mp4`);
		expect(sha(readFileSync(original))).toBe(sha(clip));
		expect(statSync(copy).size).toBeGreaterThan(0);
		expect(statSync(copy).size).toBeLessThan(clip.length);
		// Storage accounting counts every file the video keeps.
		expect(video.sizeBytes).toBe(clip.length + statSync(copy).size);
		expect(await usedBytes(a.ownerId)).toBe(video.sizeBytes);
		// A real thumbnail was made, and nothing else is left in the folder.
		expect(existsSync(mediaWritePath(`${a.slug}/${video.id}/poster.webp`))).toBe(true);
		expect(existsSync(mediaWritePath(`${a.slug}/${video.id}/frame.png`))).toBe(false);
	}, 120_000);

	it('plays the copy, and downloads the original byte for byte with its metadata', async () => {
		const a = await album();
		const video = await added(a, a.guest.id);
		const copySize = statSync(mediaWritePath(`${a.slug}/${video.id}/opt.mp4`)).size;

		const played = await fetchMedia(video.id, 'play', a.owner.locals);
		expect(played.body.length).toBe(copySize);
		expect(played.headers['content-type']).toBe('video/mp4');

		const downloaded = await fetchMedia(video.id, 'original', a.owner.locals, '?download');
		expect(downloaded.body.length).toBe(clip.length);
		expect(sha(downloaded.body)).toBe(sha(clip));
		// ...under the name it had on the phone.
		expect(downloaded.headers['content-disposition']).toMatch(/^attachment; filename="VID_2041\.MP4"/);
		// The downloaded file still says when and where it was recorded.
		const saved = join(work, 'downloaded.mp4');
		writeFileSync(saved, downloaded.body);
		const tags = execFileSync(
			'ffprobe',
			['-v', 'error', '-show_entries', 'format_tags', '-of', 'default=nw=1', saved],
			{
				encoding: 'utf8'
			}
		);
		expect(tags).toContain('TAG:creation_time=2026-08-01T10:00:00.000000Z');
		expect(tags).toContain('TAG:location=+43.3183-001.9812/');
		// The same metadata is what the viewer's caption shows: when, and where.
		expect(video.takenAt?.toISOString()).toBe('2026-08-01T10:00:00.000Z');
		expect(await placeOf(video)).toEqual({ lat: 43.3183, lon: -1.9812 });
	}, 120_000);

	it('puts the original, and only the original, in every ZIP', async () => {
		const a = await album();
		const video = await added(a, a.guest.id);
		// Marta favourites her own video, so the favourites archive has something in it.
		await db.insert(favorites).values({ memberId: a.guest.id, photoId: video.id });
		for (const query of ['scope=album', `scope=member&id=${a.guest.id}`, 'scope=favs', `scope=ids&ids=${video.id}`]) {
			const zip = await fetchZip(a.slug, a.guest.locals, query);
			expect(entries(zip), query).toBe(1);
			const at = zip.indexOf(clip);
			expect(at, query).toBeGreaterThan(0);
			expect(sha(zip.subarray(at, at + clip.length)), query).toBe(sha(clip));
		}
	}, 120_000);

	it('lets the person downloading choose the small copies instead', async () => {
		const a = await album();
		const video = await added(a, a.guest.id);
		const copy = readFileSync(mediaWritePath(`${a.slug}/${video.id}/opt.mp4`));

		// One video from the viewer: the copy, saved as an mp4 under the phone's name.
		const single = await fetchMedia(video.id, 'play', a.guest.locals, '?download');
		expect(sha(single.body)).toBe(sha(copy));
		expect(single.headers['content-disposition']).toMatch(/^attachment; filename="VID_2041\.mp4"/i);

		// A ZIP of small copies holds the copy and not the original...
		const small = await fetchZip(a.slug, a.guest.locals, 'scope=album&videos=copy');
		expect(entries(small)).toBe(1);
		expect(small.indexOf(copy)).toBeGreaterThan(0);
		expect(small.indexOf(clip)).toBe(-1);
		expect(small.length).toBeLessThan(clip.length);
		// ...and asking for nothing in particular still gives the original.
		const full = await fetchZip(a.slug, a.guest.locals, 'scope=album');
		expect(full.indexOf(clip)).toBeGreaterThan(0);

		// A video with no copy is sent as it is, whatever was asked for.
		const plain = await album({ quality: 'original' });
		await added(plain, plain.guest.id);
		const zip = await fetchZip(plain.slug, plain.guest.locals, 'scope=album&videos=copy');
		expect(zip.indexOf(clip)).toBeGreaterThan(0);
	}, 120_000);

	it('hides the copy of an unapproved video exactly as it hides the original', async () => {
		const a = await album({ autoApprove: false });
		const other = crypto.randomUUID();
		const otherToken = crypto.randomUUID();
		await db.insert(members).values({ id: other, albumId: a.row.id, deviceToken: otherToken, displayName: 'Zoe' });
		const zoe = { deviceToken: otherToken, locale: 'en', auth: async () => null };
		const video = await added(a, a.guest.id, false);
		expect(video.approved).toBe(false);

		for (const variant of ['play', 'original', 'preview']) {
			await expect(fetchMedia(video.id, variant, zoe), variant).rejects.toMatchObject({ status: 404 });
			expect((await fetchMedia(video.id, variant, a.guest.locals)).body.length, variant).toBeGreaterThan(0);
			expect((await fetchMedia(video.id, variant, a.owner.locals)).body.length, variant).toBeGreaterThan(0);
		}
		// Nor does it leak through "by person": Zoe asking for Marta's uploads gets nothing.
		await expect(fetchZip(a.slug, zoe, `scope=member&id=${a.guest.id}`)).rejects.toMatchObject({ status: 404 });
		const own = await fetchZip(a.slug, a.guest.locals, `scope=member&id=${a.guest.id}`);
		expect(own.indexOf(clip)).toBeGreaterThan(0);
	}, 120_000);

	it('"save space" keeps only the copy, and the item says the original is gone', async () => {
		const a = await album();
		await saveAlbumOptions(a.slug, { keepOnlyCopy: true });
		const video = await added(a, a.guest.id);
		const copy = mediaWritePath(`${a.slug}/${video.id}/opt.mp4`);

		expect(video).toMatchObject({ optimized: true, mime: 'video/mp4', storageKey: `${a.slug}/${video.id}/opt.mp4` });
		expect(existsSync(mediaWritePath(`${a.slug}/${video.id}/orig.mp4`))).toBe(false);
		expect(video.sizeBytes).toBe(statSync(copy).size);
		expect(await usedBytes(a.ownerId)).toBe(video.sizeBytes);
		// Download and play are then the same reduced file; nothing pretends otherwise.
		const downloaded = await fetchMedia(video.id, 'original', a.owner.locals);
		expect(downloaded.body.length).toBe(video.sizeBytes);
		expect((await fetchMedia(video.id, 'play', a.owner.locals)).body.length).toBe(video.sizeBytes);
	}, 120_000);

	it('an album without a playback copy stores and plays the original alone', async () => {
		const a = await album({ quality: 'original' });
		const video = await added(a, a.guest.id);
		expect(video).toMatchObject({ optimized: false, sizeBytes: clip.length });
		expect(existsSync(mediaWritePath(`${a.slug}/${video.id}/opt.mp4`))).toBe(false);
		expect(sha((await fetchMedia(video.id, 'play', a.owner.locals)).body)).toBe(sha(clip));
	}, 120_000);

	it('gives up the copy, not the original, when both would exceed the storage limit', async () => {
		const quotaMb = Math.ceil(clip.length / MB) + 1;
		const a = await album({ quotaMb });
		// Fill the owner's allowance so the original fits with one byte to spare.
		const filler = crypto.randomUUID();
		await db.insert(photos).values({
			id: filler,
			albumId: a.row.id,
			momentId: a.momentId,
			memberId: a.owner.id,
			storageKey: `${a.slug}/${filler}/orig.jpg`,
			thumbKey: `${a.slug}/${filler}/thumb.webp`,
			mime: 'image/jpeg',
			sizeBytes: quotaMb * MB - clip.length - 1
		});
		const video = await added(a, a.guest.id);
		expect(video).toMatchObject({ optimized: false, sizeBytes: clip.length });
		expect(existsSync(mediaWritePath(`${a.slug}/${video.id}/opt.mp4`))).toBe(false);
		expect(sha(readFileSync(mediaWritePath(video.storageKey)))).toBe(sha(clip));
		expect(await usedBytes(a.ownerId)).toBe(quotaMb * MB - 1);

		// With no room even for the original, nothing is kept and the upload is refused.
		const session = await received(a, a.guest.id);
		await runFinalization(session, a.row, t);
		expect(await db.select().from(photos).where(eq(photos.id, session.id))).toHaveLength(0);
		expect(existsSync(mediaWritePath(`${a.slug}/${session.id}`))).toBe(false);
		expect(await usedBytes(a.ownerId)).toBe(quotaMb * MB - 1);
	}, 120_000);

	it('deleting a video removes both files and gives the owner all the space back', async () => {
		const a = await album();
		const video = await added(a, a.guest.id);
		const body = JSON.stringify({ mediaItemId: video.id });
		const response = await remove({
			params: { slug: a.slug },
			request: new Request(`http://localhost/a/${a.slug}/delete`, {
				method: 'POST',
				headers: { 'content-length': String(body.length) },
				body
			}),
			locals: a.guest.locals
		} as unknown as Parameters<typeof remove>[0]);
		expect(response.status).toBe(200);
		expect(await usedBytes(a.ownerId)).toBe(0);
		// The files go with the sweep of committed deletions, never before the row.
		expect(existsSync(mediaWritePath(`${a.slug}/${video.id}/orig.mp4`))).toBe(true);
		await drainMediaDeletions();
		expect(existsSync(mediaWritePath(`${a.slug}/${video.id}`))).toBe(false);
	}, 120_000);

	it('recovers a compression interrupted by a crash, with the original intact', async () => {
		// The previous process died while ffmpeg was writing the copy: the session is
		// still claimed, the original is assembled and the copy is half-written.
		const a = await album();
		const session = await received(a, a.guest.id, 'completing');
		await ensureMediaItemDir(a.slug, session.id);
		writeFileSync(mediaWritePath(`${a.slug}/${session.id}/orig.mp4`), clip);
		writeFileSync(mediaWritePath(`${a.slug}/${session.id}/opt.mp4`), clip.subarray(0, 4096));

		const recovery = await resumeInterruptedFinalizations();
		expect(recovery.resumed).toBeGreaterThanOrEqual(1);
		await recovery.done;

		const [video] = await db.select().from(photos).where(eq(photos.id, session.id));
		const copy = mediaWritePath(`${a.slug}/${session.id}/opt.mp4`);
		expect(video).toMatchObject({ optimized: true, storageKey: `${a.slug}/${session.id}/orig.mp4` });
		expect(sha(readFileSync(mediaWritePath(video.storageKey)))).toBe(sha(clip));
		// The copy is a whole, playable video again, not the 4 KB stump the crash left.
		expect(statSync(copy).size).toBeGreaterThan(4096);
		expect(
			execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', copy]).toString()
		).toContain('mp4');
		expect(video.sizeBytes).toBe(clip.length + statSync(copy).size);
		expect(await usedBytes(a.ownerId)).toBe(video.sizeBytes);
		expect((await db.select().from(uploadSessions).where(eq(uploadSessions.id, session.id)))[0].state).toBe('complete');
	}, 120_000);

	it('sweeps away both half-made files of an upload that was abandoned mid-way', async () => {
		const a = await album();
		const session = await received(a, a.guest.id, 'completing');
		await ensureMediaItemDir(a.slug, session.id);
		writeFileSync(mediaWritePath(`${a.slug}/${session.id}/orig.mp4`), clip);
		writeFileSync(mediaWritePath(`${a.slug}/${session.id}/opt.mp4`), clip.subarray(0, 4096));
		await db
			.update(uploadSessions)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(uploadSessions.id, session.id));

		await cleanupExpiredUploadSessions();
		expect(existsSync(mediaWritePath(`${a.slug}/${session.id}`))).toBe(false);
		expect(await db.select().from(uploadSessions).where(eq(uploadSessions.id, session.id))).toHaveLength(0);
		expect(await usedBytes(a.ownerId)).toBe(0);
	}, 120_000);
});
