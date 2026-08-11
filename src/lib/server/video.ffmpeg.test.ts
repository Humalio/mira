import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real-ffmpeg checks for the compression path. They run wherever ffmpeg and ffprobe
// are on PATH (the production image, a developer machine) and are skipped elsewhere,
// so the ordinary test run needs no extra tooling. Every clip is synthetic.
const has = (bin: string) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
const enabled = has('ffmpeg') && has('ffprobe');
if (!enabled && process.env.TEST_REQUIRE_FFMPEG === '1') throw new Error('ffmpeg and ffprobe are required');

describe.skipIf(!enabled)('video compression with real ffmpeg', () => {
	const slug = `ffmpeg-test-${crypto.randomUUID()}`;
	let work: string;
	let video: typeof import('./video');
	let storage: typeof import('./storage');

	const generate = (name: string, args: string[]) => {
		const path = join(work, name);
		execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path]);
		return path;
	};
	const probe = (path: string, entries: string) =>
		execFileSync(
			'ffprobe',
			['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', path],
			{
				encoding: 'utf8'
			}
		).trim();

	const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

	/** Stage a clip as an uploaded original and run the same call the finaliser makes. */
	async function compress(source: string, quality: 'lossless' | 'balanced' | 'small' = 'small') {
		const id = crypto.randomUUID();
		await storage.ensureMediaItemDir(slug, id);
		const original = storage.mediaWritePath(`${slug}/${id}/orig.mov`);
		execFileSync('cp', [source, original]);
		const size = statSync(original).size;
		const stages: import('./video').EncodeStage[] = [];
		const copy = await video.makePlaybackCopy(slug, id, original, size, quality, (s) => stages.push(s));
		// Whatever happened, the upload itself must still be there, byte for byte.
		expect(digest(original)).toBe(digest(source));
		const out = storage.mediaWritePath(`${slug}/${id}/opt.mp4`);
		return { copy, size, stages, original, out };
	}

	beforeAll(async () => {
		work = mkdtempSync(join(tmpdir(), 'mira-ffmpeg-'));
		process.env.MEDIA_DIR = join(work, 'media');
		video = await import('./video');
		storage = await import('./storage');
	});
	afterAll(() => rmSync(work, { recursive: true, force: true }));

	it('"small" shrinks a clip to a faststart 720p H.264 mp4', async () => {
		const source = generate('plain.mp4', [
			...['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30,noise=alls=12:allf=t'],
			...['-f', 'lavfi', '-i', 'sine=frequency=440'],
			...['-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '12M', '-pix_fmt', 'yuv420p', '-c:a', 'aac']
		]);
		const { copy, size, stages, out } = await compress(source);
		expect(copy?.key.endsWith('/opt.mp4')).toBe(true);
		// Queued, then real, increasing progress read from ffmpeg (not a frozen 0%).
		expect(stages[0]).toEqual({ phase: 'queued' });
		const percents = stages.flatMap((s) => (s.phase === 'compressing' ? [s.percent] : []));
		expect(percents[0]).toBe(0);
		expect(Math.max(...percents)).toBeGreaterThan(50);
		expect([...percents].sort((a, b) => a - b)).toEqual(percents);
		expect(copy?.size).toBe(statSync(out).size);
		expect(copy?.size).toBeLessThan(size / 2);
		expect(probe(out, 'stream=codec_name,width,height,pix_fmt')).toBe('h264,1280,720,yuv420p');
	}, 120_000);

	it('"small" treats upright and sideways clips alike', async () => {
		const upright = generate('upright.mp4', [
			...['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30,noise=alls=12:allf=t'],
			...['-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '12M', '-pix_fmt', 'yuv420p']
		]);
		const { copy, out } = await compress(upright, 'small');
		expect(copy).not.toBeNull();
		expect(probe(out, 'stream=width,height')).toBe('720,1280');
	}, 120_000);

	it('"balanced" and "lossless" keep the picture size and differ only in how much they keep', async () => {
		const source = generate('rich.mp4', [
			...['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30,noise=alls=12:allf=t'],
			...['-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '90M', '-pix_fmt', 'yuv420p']
		]);
		const sizes: Record<string, number> = {};
		for (const quality of ['lossless', 'balanced', 'small'] as const) {
			const { copy, out } = await compress(source, quality);
			expect(copy, quality).not.toBeNull();
			expect(probe(out, 'stream=width,height'), quality).toBe(quality === 'small' ? '1280,720' : '1920,1080');
			sizes[quality] = copy?.size ?? 0;
		}
		expect(sizes.lossless).toBeGreaterThan(sizes.balanced);
		expect(sizes.balanced).toBeGreaterThan(sizes.small);
	}, 180_000);

	it('turns 10-bit (HDR phone) footage into 8-bit video every browser can play', async () => {
		const source = generate('tenbit.mov', [
			...['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30,noise=alls=12:allf=t'],
			...['-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '12M', '-pix_fmt', 'yuv420p10le']
		]);
		expect(probe(source, 'stream=pix_fmt')).toBe('yuv420p10le');
		const { copy, out } = await compress(source);
		expect(copy).not.toBeNull();
		expect(probe(out, 'stream=profile,pix_fmt')).toBe('High,yuv420p');
	}, 120_000);

	it('makes a real thumbnail on the server, even for a clip shorter than a second', async () => {
		for (const seconds of ['3', '0.4']) {
			const source = generate(`poster-${seconds}.mp4`, [
				...['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30'],
				...['-t', seconds, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
			]);
			const id = crypto.randomUUID();
			await storage.storeVideoPlaceholder(slug, id);
			const placeholder = statSync(storage.mediaWritePath(`${slug}/${id}/poster.webp`)).size;
			expect(await video.makeServerPoster(slug, id, source)).toEqual({ width: 1280, height: 720 });
			expect(statSync(storage.mediaWritePath(`${slug}/${id}/poster.webp`)).size).toBeGreaterThan(placeholder);
			expect(() => statSync(storage.mediaWritePath(`${slug}/${id}/frame.png`))).toThrow();
		}
		expect(await video.makeServerPoster(slug, crypto.randomUUID(), join(work, 'missing.mp4'))).toBeNull();
	}, 120_000);

	it('keeps the recording date and location on the playback copy', async () => {
		const plain = generate('undated.mp4', [
			...['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30,noise=alls=12:allf=t'],
			...['-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '12M', '-pix_fmt', 'yuv420p']
		]);
		expect(await video.recordingDate(plain)).toBeNull();
		const dated = generate('dated.mov', [
			...['-i', plain, '-c', 'copy'],
			...['-metadata', 'creation_time=2026-08-01T10:00:00Z', '-metadata', 'location=+43.3183-001.9812/']
		]);
		expect(await video.recordingDate(dated)).toBe('2026-08-01T10:00:00.000Z');
		const { copy, out } = await compress(dated);
		expect(copy).not.toBeNull();
		const tags = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'default=nw=1', out], {
			encoding: 'utf8'
		});
		expect(tags).toContain('TAG:creation_time=2026-08-01T10:00:00.000000Z');
		expect(tags).toContain('TAG:location=+43.3183-001.9812/');
	}, 120_000);

	it('makes no copy when compressing would not make the video smaller', async () => {
		const source = generate('tiny.mp4', [
			...['-f', 'lavfi', '-i', 'color=c=gray:size=320x240:rate=5'],
			...['-t', '1', '-c:v', 'libx264', '-crf', '51', '-pix_fmt', 'yuv420p']
		]);
		const { copy, size, original, out } = await compress(source);
		expect(copy).toBeNull();
		expect(statSync(original).size).toBe(size);
		expect(existsSync(out)).toBe(false);
	}, 120_000);
});
