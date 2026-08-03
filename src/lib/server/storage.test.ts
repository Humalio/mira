import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('video disk space', () => {
	let work: string;
	let storage: typeof import('./storage');

	beforeAll(async () => {
		work = mkdtempSync(join(tmpdir(), 'mira-storage-'));
		process.env.MEDIA_DIR = join(work, 'media');
		storage = await import('./storage');
	});
	afterAll(() => rmSync(work, { recursive: true, force: true }));

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
});
