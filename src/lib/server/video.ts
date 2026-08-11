/**
 * Server-side video helpers: ffmpeg compression, poster frame, extension/mime resolution.
 *
 * Compression is a first-class path, not an extra: it is why people upload videos here
 * (see docs/DEPLOYMENT.md, "Video compression"). The compressed file is a COPY for
 * playback; the upload itself is kept untouched beside it (see `originalKept`). ffmpeg
 * and ffprobe are in the production image but not in the slim dev image;
 * `makePlaybackCopy` detects a missing binary through the spawn `error` (ENOENT) and
 * then makes no copy.
 * Used by the finaliser in video-finalize.ts.
 */
import { execFile, spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { createConcurrencyGate } from './concurrency';
import { mediaWritePath, renderPoster, writePoster } from './storage';
import type { VideoQuality } from '#lib/video-quality.js';

// One encode at a time keeps a small server responsive. A second video WAITS for the
// slot: compression is the reason people upload videos here, so "busy" must never
// mean "silently keep the 1 GB original". The finaliser renews the upload session's
// lease while it waits and encodes (see video/complete), so waiting is safe.
const acquireTranscodeSlot = createConcurrencyGate(1, 'The video encoder is busy', {
	maxWaiting: 8,
	maxWaitMs: 2 * 60 * 60_000
});

/**
 * Upper bound for one encode. It exists to stop a hung ffmpeg holding the only slot
 * forever, not to cap video length, so it grows with the upload: ten minutes plus a
 * minute per 25 MB (about 50 minutes for 1 GB), at most two hours.
 */
export function transcodeTimeoutMs(inputBytes: number): number {
	const scaled = 10 * 60_000 + Math.ceil(Math.max(0, inputBytes) / (25 * 1024 * 1024)) * 60_000;
	return Math.min(scaled, 2 * 60 * 60_000);
}

/** Seconds from the first `HH:MM:SS(.fraction)` in ffmpeg output, or null if there is none. */
export function clockSeconds(text: string): number | null {
	const m = /(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
	return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * The input's length from ffmpeg's start-up text, once the whole `Duration: …,` field
 * has arrived (it may still be cut short; then this returns null and is asked again).
 */
export function inputDuration(startupText: string): number | null {
	const m = /Duration:\s*(\d+:\d\d:\d\d(?:\.\d+)?),/.exec(startupText);
	return m ? clockSeconds(m[1]) : null;
}

/** The most recent complete `out_time=` line in ffmpeg's `-progress` output, in seconds. */
export function lastPosition(progressText: string): number | null {
	const all = [...progressText.matchAll(/out_time=(\d+:\d\d:\d\d(?:\.\d+)?)\r?\n/g)];
	return all.length ? clockSeconds(all[all.length - 1][1]) : null;
}

/**
 * Spawn ffmpeg and wait for it, killing it if it outlives `timeoutMs`. With
 * `onProgress` it reports how far through the input it is (0..1), read from ffmpeg's
 * own progress output against the input duration it prints at start.
 */
function execFfmpeg(args: string[], timeoutMs: number, onProgress?: (fraction: number) => void): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const p = spawn('ffmpeg', ['-nostdin', ...(onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args], {
			stdio: ['ignore', onProgress ? 'pipe' : 'ignore', 'pipe']
		});
		let timedOut = false;
		let settled = false;
		let duration: number | null = null;
		let lastWords = '';
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			p.kill('SIGKILL');
		}, timeoutMs);
		// Always drain stderr (a full pipe would stall ffmpeg) and keep its last lines:
		// they are the only explanation when an encode fails.
		// ffmpeg writes a line in several pieces ("  Duration: " and then the time), and
		// a pipe delivers them as they come, so one `data` event may hold half a line.
		// Reading each event on its own worked on a fast machine and never found the
		// duration on the live server, which left the percentage at 0. Accumulate instead.
		let head = '';
		let position = '';
		p.stderr?.setEncoding('utf8').on('data', (text: string) => {
			if (duration === null && head.length < 64 * 1024) {
				head += text;
				duration = inputDuration(head);
			}
			lastWords = (lastWords + text).slice(-600);
		});
		p.stdout?.setEncoding('utf8').on('data', (text: string) => {
			position = (position + text).slice(-400);
			const done = lastPosition(position);
			if (onProgress && duration && done !== null) onProgress(Math.max(0, Math.min(1, done / duration)));
		});
		p.on('error', (cause) => finish(() => reject(cause)));
		p.on('close', (code) =>
			finish(() =>
				code === 0 && !timedOut
					? resolve()
					: reject(new Error(timedOut ? 'ffmpeg timed out' : `ffmpeg exited ${code}: ${lastWords.trim()}`))
			)
		);
	});
}

/** Where a video is in the encoder: waiting its turn, or how far through. */
export type EncodeStage = { phase: 'queued' } | { phase: 'compressing'; percent: number };

/** Run ffmpeg with bounded concurrency and execution time, reporting each stage. */
export async function runFfmpeg(
	args: string[],
	timeoutMs: number,
	onStage?: (stage: EncodeStage) => void
): Promise<void> {
	onStage?.({ phase: 'queued' });
	const release = await acquireTranscodeSlot();
	try {
		onStage?.({ phase: 'compressing', percent: 0 });
		await execFfmpeg(
			args,
			timeoutMs,
			onStage && ((fraction) => onStage({ phase: 'compressing', percent: Math.round(fraction * 100) }))
		);
	} finally {
		release();
	}
}

/**
 * Give a finished video a real thumbnail, made on the server from one of its frames.
 * The browser also sends a poster after a successful upload, but only if the tab is
 * still open by then and the browser can decode the format (desktop Chrome cannot
 * decode an iPhone's HEVC .mov), and otherwise the album showed a blank grey tile.
 * Reading one frame takes a second or two, so this does not queue for the encoder.
 * Returns the frame's size, or null when ffmpeg is missing or the frame is unusable;
 * the caller's placeholder poster then stays in place.
 */
export async function makeServerPoster(
	albumSlug: string,
	mediaItemId: string,
	videoAbs: string
): Promise<{ width: number | null; height: number | null } | null> {
	const frameAbs = mediaWritePath(`${albumSlug}/${mediaItemId}/frame.png`);
	try {
		// One second in skips the black or blurred first frame; very short clips fall
		// back to the first frame.
		for (const at of ['1', '0']) {
			await execFfmpeg(
				[
					'-y',
					...['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm'],
					...['-ss', at, '-i', videoAbs, '-frames:v', '1'],
					...['-vf', "scale='min(1280,iw)':-2", '-pix_fmt', 'rgb24', '-f', 'image2', '-c:v', 'png'],
					frameAbs
				],
				30_000
			).catch((cause) => {
				if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') throw cause; // no ffmpeg: stop trying
			});
			const frame = await readFile(frameAbs).catch(() => null);
			if (!frame?.byteLength) continue;
			const rendered = await renderPoster(frame);
			await writePoster(albumSlug, mediaItemId, rendered.thumb);
			return { width: rendered.width, height: rendered.height };
		}
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT')
			console.warn('[video] server poster skipped', { mediaItemId, cause: String(cause) });
	} finally {
		await rm(frameAbs, { force: true }).catch(() => {});
	}
	return null;
}

const EXT_FOR_MIME: Record<string, string> = {
	'video/mp4': 'mp4',
	'video/quicktime': 'mov',
	'video/webm': 'webm',
	'video/x-matroska': 'mkv',
	'video/3gpp': '3gp',
	'video/x-m4v': 'm4v'
};

export function isSupportedVideoMime(mime: string): boolean {
	return Object.hasOwn(EXT_FOR_MIME, mime);
}

/** Pick the server-controlled extension for a validated video MIME type. */
export function extForVideo(mime: string): string {
	const ext = EXT_FOR_MIME[mime];
	if (!ext) throw new Error('unsupported video MIME type');
	return ext;
}

/**
 * When the video was recorded, as the container states it. ffmpeg copies most tags to
 * its output but deliberately clears this one, so a compressed holiday clip would be
 * dated the day it was uploaded once someone downloads it. Read it up front (ffprobe
 * ships with ffmpeg) and hand it back to the encoder. Null when unknown or unreadable.
 */
export async function recordingDate(inputAbs: string): Promise<string | null> {
	const stdout = await new Promise<string>((resolve) => {
		execFile(
			'ffprobe',
			[
				...['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm'],
				...['-show_entries', 'format_tags=creation_time', '-of', 'default=nw=1:nk=1', inputAbs]
			],
			{ timeout: 20_000, maxBuffer: 64 * 1024 },
			(failure, out) => resolve(failure ? '' : String(out))
		);
	});
	const when = new Date(stdout.trim().split(/\s+/)[0] ?? '');
	// A zeroed header reads as 1904 or 1970; that is "not set", not a date worth keeping.
	return Number.isNaN(when.getTime()) || when.getUTCFullYear() < 1990 ? null : when.toISOString();
}

/**
 * How each quality an album can choose is encoded. `crf` is x264's quality dial: lower
 * keeps more detail and makes a bigger file (18 is commonly treated as visually
 * lossless, 23 is x264's own default, 28 is clearly lighter). `scale` is null when the
 * picture keeps its size.
 *
 * "small" limits the SHORT side to 720, so an upright clip and a sideways one are
 * treated alike (720x1280 and 1280x720). It used to limit only the width, which left
 * upright clips at full HD and twice the size of sideways ones.
 */
const ENCODINGS: Record<Exclude<VideoQuality, 'original'>, { crf: string; scale: string | null }> = {
	lossless: { crf: '18', scale: null },
	balanced: { crf: '23', scale: null },
	small: { crf: '28', scale: "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'" }
};

/** The ffmpeg arguments that turn an upload into the H.264/AAC mp4 that plays in the album. */
export function compressionArgs(
	inputAbs: string,
	outputAbs: string,
	quality: Exclude<VideoQuality, 'original'>,
	recordedAt?: string | null
): string[] {
	const { crf, scale } = ENCODINGS[quality];
	return [
		'-y',
		'-protocol_whitelist',
		'file',
		'-format_whitelist',
		'mov,matroska,webm',
		'-threads',
		'2',
		'-filter_threads',
		'1',
		'-i',
		inputAbs,
		...(scale ? ['-vf', scale] : []),
		'-c:v',
		'libx264',
		'-threads',
		'2',
		'-preset',
		'veryfast',
		'-crf',
		crf,
		// Phones record HDR as 10-bit; x264 would keep that and write "High 10" H.264,
		// which Safari, iOS and most hardware decoders cannot play at all. 8-bit 4:2:0
		// is the one pixel format every browser and phone plays.
		'-pix_fmt',
		'yuv420p',
		'-c:a',
		'aac',
		'-b:a',
		quality === 'small' ? '128k' : '192k',
		'-movflags',
		'+faststart',
		...(recordedAt ? ['-metadata', `creation_time=${recordedAt}`] : []),
		outputAbs
	];
}

/** The file name of a video's playback copy, inside its media item folder. */
const PLAYBACK_FILE = 'opt.mp4';

type VideoRow = { kind: string; optimized: boolean; storageKey: string };

/**
 * How a video's files are told apart WITHOUT a database column (the day-zero schema
 * cannot change under existing installations). A video folder holds:
 *
 * - `orig.<ext>`  the upload, byte for byte. `storage_key` points here whenever it exists.
 * - `opt.mp4`     the playback copy, when the album makes one.
 *
 * `optimized` says a playback copy was made. So:
 *
 * | optimized | storage_key  | meaning                                             |
 * | --------- | ------------ | --------------------------------------------------- |
 * | false     | orig.<ext>   | original only; it is also what plays                |
 * | true      | orig.<ext>   | original kept, plays from the sibling `opt.mp4`     |
 * | true      | opt.mp4      | only the copy exists: the album saves space, or the |
 * |           |              | video predates originals being kept                 |
 *
 * `size_bytes` is everything the item occupies (original plus copy), so quotas and the
 * storage counters stay true with two files.
 */
export function originalKept(item: VideoRow): boolean {
	return !(item.kind === 'video' && item.optimized && item.storageKey.endsWith(`/${PLAYBACK_FILE}`));
}

/** The media key of the playback copy that sits beside a kept original, or null. */
export function playbackKey(item: VideoRow): string | null {
	if (item.kind !== 'video' || !item.optimized || !originalKept(item)) return null;
	return `${item.storageKey.slice(0, item.storageKey.lastIndexOf('/'))}/${PLAYBACK_FILE}`;
}

export type PlaybackCopy = { key: string; size: number };

/**
 * Make the playback copy of an uploaded video: an H.264/AAC mp4 at the album's chosen
 * quality, written beside the original, which is never touched here. Returns null,
 * leaving no copy behind, when ffmpeg is missing or fails, or when the copy would not
 * be smaller (common for "lossless", since a phone's own file is already well
 * compressed); the original then simply plays as it is.
 */
export async function makePlaybackCopy(
	albumSlug: string,
	mediaItemId: string,
	absPath: string,
	size: number,
	quality: Exclude<VideoQuality, 'original'>,
	onStage?: (stage: EncodeStage) => void
): Promise<PlaybackCopy | null> {
	const key = `${albumSlug}/${mediaItemId}/${PLAYBACK_FILE}`;
	const optAbs = mediaWritePath(key);
	try {
		const recordedAt = await recordingDate(absPath);
		await runFfmpeg(compressionArgs(absPath, optAbs, quality, recordedAt), transcodeTimeoutMs(size), onStage);
		const optSize = (await stat(optAbs)).size;
		if (optSize > 0 && optSize < size) return { key, size: optSize };
		await rm(optAbs, { force: true });
	} catch (cause) {
		// ffmpeg missing, queue full, timed out or failed: the original is all there is,
		// but leave a trace: "copies silently stopped being made" is otherwise invisible.
		const code = (cause as NodeJS.ErrnoException)?.code;
		if (code !== 'ENOENT') console.warn('[video] playback copy skipped', { mediaItemId, cause: String(cause) });
		await rm(optAbs, { force: true }).catch(() => {});
	}
	return null;
}
