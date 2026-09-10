import { afterAll, describe, expect, it, vi } from 'vitest';
import * as storage from './storage';
import { POST as complete } from '../../routes/a/[slug]/video/complete/+server';
import { eq } from 'drizzle-orm';
import { access, readFile, writeFile } from 'node:fs/promises';
import { db } from './db';
import { albums, members, moments, photos, uploadSessions, uploadChunks, users, mediaDeletions } from './schema';
import { resumeInterruptedFinalizations } from './video-finalize';
import {
	createUpload,
	writeChunk,
	cleanupUpload,
	ensureMediaItemDir,
	mediaWritePath,
	assembleUpload,
	deleteMediaItemDir
} from './storage';
import { enqueueMediaDeletion, drainMediaDeletions } from './media-deletions';
import { POST } from '../../routes/a/[slug]/video/chunk/+server';

describe('durable upload and deletion recovery', () => {
	const ownerId = crypto.randomUUID(),
		albumId = crypto.randomUUID(),
		memberId = crypto.randomUUID(),
		momentId = crypto.randomUUID();
	const slug = `recovery-${albumId}`;
	const uploads: string[] = [];
	async function setup() {
		await db
			.insert(users)
			.values({ id: ownerId, provider: 'test-recovery', providerAccountId: ownerId })
			.onConflictDoNothing();
		await db.insert(albums).values({ id: albumId, slug, name: 'Recovery', ownerUserId: ownerId }).onConflictDoNothing();
		await db
			.insert(members)
			.values({ id: memberId, albumId, deviceToken: ownerId, displayName: 'Test' })
			.onConflictDoNothing();
		await db.insert(moments).values({ id: momentId, albumId, name: 'Test' }).onConflictDoNothing();
	}
	async function session() {
		await setup();
		const id = crypto.randomUUID();
		uploads.push(id);
		await createUpload(id);
		await db.insert(uploadSessions).values({
			id,
			albumId,
			momentId,
			memberId,
			deviceToken: ownerId,
			mime: 'video/mp4',
			declaredBytes: 3,
			chunkSize: 3,
			totalChunks: 1,
			approved: true,
			quality: 'original',
			expiresAt: new Date(Date.now() + 60_000)
		});
		return id;
	}
	async function send(id: string, content = 'abc') {
		const url = new URL(`http://localhost/a/${slug}/video/chunk?uploadId=${id}&index=0`);
		return POST({
			params: { slug },
			request: new Request(url, { method: 'POST', headers: { 'content-length': '3' }, body: content }),
			url,
			locals: { deviceToken: ownerId }
		} as Parameters<typeof POST>[0]);
	}
	afterAll(async () => {
		await db.delete(albums).where(eq(albums.id, albumId));
		await db.delete(users).where(eq(users.id, ownerId));
		await db.delete(mediaDeletions).where(eq(mediaDeletions.ownerId, ownerId));
		for (const id of uploads) await cleanupUpload(id);
	});
	it('repairs the crash window after file publication but before receipt commit', async () => {
		const id = await session();
		await writeChunk(id, 0, Buffer.from('abc'));
		expect((await send(id)).status).toBe(200);
		expect((await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)))[0].receivedBytes).toBe(3);
	});
	it('acknowledges concurrent/lost-response retries exactly once and rejects changed content', async () => {
		const id = await session();
		await Promise.all([send(id), send(id), send(id)]);
		expect((await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)))[0].receivedBytes).toBe(3);
		expect(await db.select().from(uploadChunks).where(eq(uploadChunks.uploadId, id))).toHaveLength(1);
		await expect(send(id, 'xyz')).rejects.toMatchObject({ status: 409 });
	});
	it('rolls back deletion intent without touching files; committed intent survives until drained', async () => {
		await setup();
		const id = crypto.randomUUID();
		await ensureMediaItemDir(slug, id);
		const file = mediaWritePath(`${slug}/${id}/orig.jpg`);
		await writeFile(file, 'preserve-me');
		await expect(
			db.transaction(async (tx) => {
				await enqueueMediaDeletion(tx, ownerId, `${slug}/${id}`);
				throw new Error('crash before commit');
			})
		).rejects.toThrow('crash before commit');
		expect(await readFile(file, 'utf8')).toBe('preserve-me');
		expect(await db.select().from(mediaDeletions).where(eq(mediaDeletions.ownerId, ownerId))).toHaveLength(0);
		await db.transaction((tx) => enqueueMediaDeletion(tx, ownerId, `${slug}/${id}`));
		expect(await readFile(file, 'utf8')).toBe('preserve-me');
		await drainMediaDeletions();
		await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
		await drainMediaDeletions();
	});
	it('bounds background finalization, and finishes a waiting upload without anyone polling', async () => {
		const ids = [await session(), await session(), await session()];
		for (const id of ids) await send(id);
		let unblock!: () => void;
		const barrier = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const original = storage.assembleUpload;
		const spy = vi.spyOn(storage, 'assembleUpload').mockImplementation(async (...args) => {
			await barrier;
			return original(...args);
		});
		const finish = (id: string) => {
			const body = JSON.stringify({ uploadId: id });
			return complete({
				params: { slug },
				request: new Request('http://localhost/complete', {
					method: 'POST',
					headers: { 'content-length': String(body.length) },
					body
				}),
				locals: { deviceToken: ownerId, locale: 'en', auth: async () => null }
			} as Parameters<typeof complete>[0]);
		};
		try {
			expect((await finish(ids[0])).status).toBe(202);
			expect((await finish(ids[1])).status).toBe(202);
			const waiting = await finish(ids[2]);
			expect(await waiting.json()).toEqual({ status: 'waiting' });
			expect((await db.select().from(uploadSessions).where(eq(uploadSessions.id, ids[2])))[0].state).toBe('receiving');
		} finally {
			unblock();
		}
		try {
			await vi.waitFor(
				async () => {
					// The third was told "waiting" once and its page never asked again (a
					// closed tab, a sleeping phone). It is started when a finaliser is free.
					for (const id of ids)
						expect((await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)))[0].state).toBe('complete');
				},
				{ timeout: 15_000 }
			);
		} finally {
			spy.mockRestore();
		}
		for (const id of ids) await deleteMediaItemDir(slug, id);
	}, 30_000); // real background work; the default 5 s is too tight on a busy machine
	it('restarts an interrupted finalisation from the uploaded chunks, with nobody polling', async () => {
		const stateOf = async (id: string) =>
			(await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)))[0].state;
		// The previous process died mid-compression: session claimed, half-written output.
		const id = await session();
		await send(id);
		await db.update(uploadSessions).set({ state: 'completing' }).where(eq(uploadSessions.id, id));
		await ensureMediaItemDir(slug, id);
		const partial = mediaWritePath(`${slug}/${id}/opt.mp4`);
		await writeFile(partial, 'half-written');
		// Claimed with a chunk missing: nothing to resume from, so it must be failed.
		const incomplete = await session();
		await db.update(uploadSessions).set({ state: 'completing' }).where(eq(uploadSessions.id, incomplete));

		const recovery = await resumeInterruptedFinalizations();
		expect(recovery.resumed).toBeGreaterThanOrEqual(1);
		expect(recovery.failed).toBeGreaterThanOrEqual(1);
		await recovery.done;

		expect(await stateOf(id)).toBe('complete');
		const [video] = await db.select().from(photos).where(eq(photos.id, id));
		expect(video).toMatchObject({ kind: 'video', memberId, sizeBytes: 3, optimized: false });
		expect(await readFile(mediaWritePath(video.storageKey), 'utf8')).toBe('abc');
		await expect(access(partial)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await stateOf(incomplete)).toBe('failed');
		await deleteMediaItemDir(slug, id);
	}, 30_000);
	it('propagates output-open and missing-chunk errors without crashing the process', async () => {
		const id = await session();
		await writeChunk(id, 0, Buffer.from('abc'));
		await expect(
			assembleUpload(id, 1, mediaWritePath(`${slug}/${crypto.randomUUID()}/missing/out`))
		).rejects.toMatchObject({ code: 'ENOENT' });
		await ensureMediaItemDir(slug, id);
		const output = mediaWritePath(`${slug}/${id}/out`);
		expect(await assembleUpload(id, 1, output)).toBe(3);
		await expect(assembleUpload(id, 2, output)).rejects.toMatchObject({ code: 'ENOENT' });
		await deleteMediaItemDir(slug, id);
	});
});
