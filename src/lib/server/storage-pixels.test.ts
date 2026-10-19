import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from './input';

describe('how large a photo may be', () => {
	let work: string;
	let storage: typeof import('./storage');
	const flat = (width: number, height: number) =>
		sharp({ create: { width, height, channels: 3, background: '#789' }, limitInputPixels: false })
			.jpeg()
			.toBuffer();

	beforeAll(async () => {
		work = mkdtempSync(join(tmpdir(), 'mira-pixels-'));
		process.env.MEDIA_DIR = join(work, 'media');
		storage = await import('./storage');
	});
	afterAll(() => rmSync(work, { recursive: true, force: true }));

	it('takes the 48 and 50 megapixel photos phones make', async () => {
		// 8160 × 6120 is the "50 MP" mode of current phones; the old limit of 40 refused it.
		expect(8160 * 6120).toBeLessThan(LIMITS.imagePixels);
		const stored = await storage.storeImage('pixels', crypto.randomUUID(), await flat(8160, 6120));
		expect(stored).toMatchObject({ width: 8160, height: 6120, mime: 'image/jpeg' });
		expect(existsSync(storage.mediaWritePath(stored.thumbKey))).toBe(true);
	}, 60_000);

	it('refuses one beyond the limit with a reason of its own, and stores nothing', async () => {
		const id = crypto.randomUUID();
		const side = Math.ceil(Math.sqrt(LIMITS.imagePixels)) + 8;
		await expect(storage.storeImage('pixels', id, await flat(side, side))).rejects.toBeInstanceOf(
			storage.TooManyPixelsError
		);
		expect(existsSync(storage.mediaWritePath(`pixels/${id}`))).toBe(false);
	}, 60_000);
});
