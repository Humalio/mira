import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let work: string;
let storage: typeof import('./storage');

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'mira-storage-'));
	process.env.MEDIA_DIR = join(work, 'media');
	storage = await import('./storage');
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('video disk space', () => {
	it('accepts a video the disk can hold and refuses one it cannot', async () => {
		expect(await storage.hasVideoSpace(1)).toBe(true);
		expect(await storage.hasVideoSpace(Number.MAX_SAFE_INTEGER / 8)).toBe(false);
	});

	it('counts space already promised to videos being processed', async () => {
		const release = await storage.reserveVideoSpace(1024);
		try {
			expect(await storage.hasVideoSpace(1)).toBe(true);
			await expect(storage.reserveVideoSpace(Number.MAX_SAFE_INTEGER / 8)).rejects.toThrow('Insufficient');
		} finally {
			release();
		}
	});

	it('gives a big video more time to be put together than a small one', () => {
		const minute = 60_000;
		const MB = 1024 * 1024;
		expect(storage.assemblyTimeoutMs(0)).toBe(5 * minute);
		expect(storage.assemblyTimeoutMs(12 * MB)).toBe(6 * minute);
		expect(storage.assemblyTimeoutMs(1024 * MB)).toBe(16 * minute);
		expect(storage.assemblyTimeoutMs(5 * 1024 * MB)).toBe(57 * minute);
	});
});

describe('photo formats', () => {
	const blank = () => sharp({ create: { width: 32, height: 24, channels: 3, background: '#789' } });

	it('keeps an AVIF photo as AVIF, although sharp names its container "heif"', async () => {
		const avif = await blank().avif().toBuffer();
		const stored = await storage.storeImage('formats', crypto.randomUUID(), avif);
		expect(stored.storageKey).toMatch(/\/orig\.avif$/);
		expect(stored.mime).toBe('image/avif');
		expect(await storage.mediaFilesExist(stored.storageKey, stored.thumbKey)).toBe(true);
	});

	it('writes over a photo it already holds without leaving temporary files behind', async () => {
		const id = crypto.randomUUID();
		const jpeg = await blank().jpeg().toBuffer();
		const first = await storage.storeImage('formats', id, jpeg);
		const again = await storage.storeImage('formats', id, jpeg);
		expect(again.storageKey).toBe(first.storageKey);
		expect((await readdir(storage.mediaWritePath(`formats/${id}`))).sort()).toEqual(['orig.jpg', 'thumb.webp']);
		expect(await storage.mediaFilesExist(first.storageKey, `formats/${id}/missing.jpg`)).toBe(false);
	});
});
