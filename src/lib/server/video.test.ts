import { describe, it, expect } from 'vitest';
import {
	clockSeconds,
	compressionArgs,
	extForVideo,
	inputDuration,
	lastPosition,
	originalKept,
	playbackKey,
	transcodeTimeoutMs
} from './video';

describe('which files a video has', () => {
	const video = (optimized: boolean, storageKey: string) => ({ kind: 'video', optimized, storageKey });
	it('an uncompressed video is its original and plays from it', () => {
		const item = video(false, 'trip/abc/orig.mov');
		expect(originalKept(item)).toBe(true);
		expect(playbackKey(item)).toBeNull();
	});
	it('a video with a playback copy keeps the original beside it', () => {
		const item = video(true, 'trip/abc/orig.mov');
		expect(originalKept(item)).toBe(true);
		expect(playbackKey(item)).toBe('trip/abc/opt.mp4');
	});
	it('a video stored as its copy has no original, and says so', () => {
		// Videos compressed before originals were kept, and albums that save space.
		const item = video(true, 'trip/abc/opt.mp4');
		expect(originalKept(item)).toBe(false);
		expect(playbackKey(item)).toBeNull();
	});
	it('photos are never anything but originals', () => {
		const photo = { kind: 'image', optimized: false, storageKey: 'trip/abc/orig.jpg' };
		expect(originalKept(photo)).toBe(true);
		expect(playbackKey(photo)).toBeNull();
	});
});

describe('extForVideo', () => {
	it('maps known video mime types', () => {
		expect(extForVideo('video/mp4')).toBe('mp4');
		expect(extForVideo('video/quicktime')).toBe('mov');
		expect(extForVideo('video/webm')).toBe('webm');
		expect(extForVideo('video/x-matroska')).toBe('mkv');
	});

	it('gives long videos time to compress, within a hard ceiling', () => {
		const minute = 60_000;
		expect(transcodeTimeoutMs(0)).toBe(10 * minute);
		expect(transcodeTimeoutMs(1024 * 1024 * 1024)).toBe(51 * minute);
		expect(transcodeTimeoutMs(5 * 1024 * 1024 * 1024)).toBe(120 * minute);
	});

	it('reads positions and durations from ffmpeg output', () => {
		expect(clockSeconds('  Duration: 00:08:00.02, start: 0.000000, bitrate: 17158 kb/s')).toBeCloseTo(480.02);
		expect(clockSeconds('out_time=01:02:03.500000 dup_frames=0')).toBeCloseTo(3723.5);
		expect(clockSeconds('out_time=N/A')).toBeNull();
	});

	it('finds the duration and position even when ffmpeg output arrives in pieces', () => {
		// What the live server delivered: the label in one read, the time in the next.
		const pieces = ['Input #0, mov, from in.mp4:\n  Duration: ', '00:08:', '00.02, start: 0.000000, bitrate'];
		let seen = '';
		const found = pieces.map((piece) => inputDuration((seen += piece)));
		expect(found.slice(0, 2)).toEqual([null, null]);
		expect(found[2]).toBeCloseTo(480.02);
		expect(inputDuration('  Duration: N/A, start: 0.000000')).toBeNull();

		expect(lastPosition('out_time_us=1333333\nout_time=00:00:01.333333\ndup_frames=0\n')).toBeCloseTo(1.333333);
		// A half-written newest line is ignored in favour of the last complete one.
		expect(lastPosition('out_time=00:00:01.333333\nspeed=2x\nout_time=00:00:0')).toBeCloseTo(1.333333);
		expect(lastPosition('frame=1\nfps=0.00\n')).toBeNull();
		expect(lastPosition('out_time=N/A\n')).toBeNull();
	});

	it('only "small" resizes the picture, and each quality keeps more detail than the next', () => {
		const crf = (quality: 'lossless' | 'balanced' | 'small') => {
			const args = compressionArgs('/in.mov', '/out.mp4', quality);
			return { crf: Number(args[args.indexOf('-crf') + 1]), resized: args.includes('-vf'), args };
		};
		expect(crf('lossless').resized).toBe(false);
		expect(crf('balanced').resized).toBe(false);
		expect(crf('small').resized).toBe(true);
		expect(crf('lossless').crf).toBeLessThan(crf('balanced').crf);
		expect(crf('balanced').crf).toBeLessThan(crf('small').crf);
		// Every quality must still produce video that plays everywhere.
		for (const quality of ['lossless', 'balanced', 'small'] as const) {
			const { args } = crf(quality);
			expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
			expect(args.at(-1)).toBe('/out.mp4');
		}
		expect(compressionArgs('/in.mov', '/out.mp4', 'balanced', '2026-08-01T10:00:00.000Z')).toContain(
			'creation_time=2026-08-01T10:00:00.000Z'
		);
	});

	it('rejects unknown MIME types', () => {
		expect(() => extForVideo('application/octet-stream')).toThrow('unsupported video MIME type');
	});
});
