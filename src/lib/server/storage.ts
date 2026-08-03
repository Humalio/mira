import { MEDIA_DIR as CONFIGURED_MEDIA_DIR } from '$app/env/private';
import exifr from 'exifr';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, readFile, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { cleanFileName } from './archive-names';
import { LIMITS } from './input';

const MEDIA_DIR = CONFIGURED_MEDIA_DIR || './data/media';
const ROOT = resolve(MEDIA_DIR);
// Chunked-upload staging, kept OUT of the media tree so it is never served as a photo.
const UPLOAD_TMP = resolve(ROOT, '..', '.uploads');

const FORMAT_EXT: Record<string, string> = {
	jpeg: 'jpg',
	png: 'png',
	webp: 'webp',
	gif: 'gif',
	avif: 'avif',
	heif: 'heic',
	tiff: 'tif'
};
const FORMAT_MIME: Record<string, string> = {
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	avif: 'image/avif',
	heif: 'image/heic',
	tiff: 'image/tiff'
};

export type StoredImage = {
	storageKey: string;
	thumbKey: string;
	width: number | null;
	height: number | null;
	mime: string;
	sizeBytes: number;
	takenAt: Date | null;
};

/** The picture has more pixels than `LIMITS.imagePixels`; it was not decoded. */
export class TooManyPixelsError extends Error {
	constructor() {
		super('image has too many pixels');
		this.name = 'TooManyPixelsError';
	}
}

/**
 * Persist an uploaded image: keep the original, generate a light WebP thumbnail,
 * and pull the capture time from EXIF (used only to sub-order within a moment).
 * Throws if the buffer isn't a supported image.
 */
export async function storeImage(albumSlug: string, mediaItemId: string, input: Buffer): Promise<StoredImage> {
	// Reading the header decodes nothing, so the size can be judged here, by us, and the
	// uploader told the real reason instead of "couldn't process that file".
	const meta = await sharp(input, { failOn: 'error', limitInputPixels: false }).metadata();
	const format = meta.format ?? '';
	const ext = FORMAT_EXT[format];
	if (!ext) throw new Error(`unsupported image format: ${format || 'unknown'}`);
	if ((meta.width ?? 0) * (meta.height ?? 0) > LIMITS.imagePixels) throw new TooManyPixelsError();

	let width = meta.width ?? null;
	let height = meta.height ?? null;
	// EXIF orientation 5-8 means the image is rotated 90°; swap display dims.
	if (meta.orientation && meta.orientation >= 5 && width && height) {
		[width, height] = [height, width];
	}

	const thumb = await sharp(input, { failOn: 'error', limitInputPixels: LIMITS.imagePixels })
		.rotate() // auto-orient from EXIF
		.resize(640, 640, { fit: 'inside', withoutEnlargement: true })
		.webp({ quality: 72 })
		.toBuffer();

	// EXIF capture time is timezone-naive (no offset in the tag), so exifr reads it in
	// the host's local zone. That's fine here: takenAt only sub-orders photos WITHIN a
	// moment, and every photo in a moment is ingested on the same host, so their
	// relative order is preserved regardless of the absolute zone.
	let takenAt: Date | null = null;
	try {
		const exif = await exifr.parse(input, ['DateTimeOriginal', 'CreateDate']);
		const capturedAt = exif?.DateTimeOriginal ?? exif?.CreateDate;
		if (capturedAt instanceof Date && !Number.isNaN(capturedAt.getTime())) takenAt = capturedAt;
	} catch {
		/* missing or invalid EXIF is acceptable */
	}

	const storageKey = `${albumSlug}/${mediaItemId}/orig.${ext}`;
	const thumbKey = `${albumSlug}/${mediaItemId}/thumb.webp`;
	await ensureMediaItemDir(albumSlug, mediaItemId);
	try {
		// PRODUCT DECISION (owner, 2026-10-10): originals are stored and served byte-exact,
		// with ALL embedded metadata, including EXIF capture time and GPS location. Sharing
		// untouched originals is the point of Mira, so do not strip, re-encode or otherwise
		// alter this buffer, and do not re-raise it as a privacy finding: the join page
		// tells guests, and docs/DEPLOYMENT.md records it. Only the thumbnail above is
		// re-encoded (and therefore carries no EXIF/GPS).
		await writeFile(mediaWritePath(storageKey), input);
		await writeFile(mediaWritePath(thumbKey), thumb);
	} catch (e) {
		// A half-written photo dir (orig without thumb, or neither) would be an orphan
		// with no DB row — clean it up so a failed write leaves nothing behind.
		await deleteMediaItemDir(albumSlug, mediaItemId).catch(() => {});
		throw e;
	}

	return {
		storageKey,
		thumbKey,
		width,
		height,
		mime: FORMAT_MIME[format],
		sizeBytes: input.byteLength,
		takenAt
	};
}

/** Resolve a media key to an absolute path, refusing path traversal. */
export function mediaAbsPath(key: string): string | null {
	const resolved = resolve(ROOT, key);
	return resolved === ROOT || resolved.startsWith(ROOT + sep) ? resolved : null;
}

/** Absolute path for writing a media key (traversal-guarded). */
export function mediaWritePath(key: string): string {
	const resolved = resolve(ROOT, key);
	if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) throw new Error('bad media key');
	return resolved;
}

/** Ensure a per-media-item directory exists. */
export async function ensureMediaItemDir(albumSlug: string, mediaItemId: string): Promise<void> {
	await mkdir(mediaWritePath(join(albumSlug, mediaItemId)), { recursive: true });
}

/** Remove all files for a media item (original + thumbnail/poster). */
export async function deleteMediaItemDir(albumSlug: string, mediaItemId: string): Promise<void> {
	await rm(mediaWritePath(join(albumSlug, mediaItemId)), { recursive: true, force: true });
}

/** Delete a committed outbox target; never permit removal of the entire media root. */
export async function deleteMediaTree(key: string): Promise<void> {
	const target = mediaWritePath(key);
	if (target === ROOT) throw new Error('Cannot delete media root');
	await rm(target, { recursive: true, force: true });
}

// What the file was called on the uploader's device, kept in a tiny file beside it
// (`<item>/name`): the day-zero schema has no column for it and cannot gain one. It is
// used only to name downloads; an item without one gets a made-up name.

/** Remember an item's original file name. Best effort: a download name is not worth failing an upload for. */
export async function saveOriginalName(albumSlug: string, mediaItemId: string, name: unknown): Promise<void> {
	const clean = cleanFileName(name);
	if (!clean) return;
	await writeFile(mediaWritePath(join(albumSlug, mediaItemId, 'name')), clean).catch(() => {});
}

/** The original file name of the item whose file is at `storageKey`, or null. */
export async function readOriginalName(storageKey: string): Promise<string | null> {
	const abs = mediaAbsPath(join(storageKey, '..', 'name'));
	if (!abs) return null;
	const name = await readFile(abs, 'utf8').catch(() => '');
	return cleanFileName(name) || null;
}

/** Keep a video's file name with its upload until the video itself exists. */
export async function saveUploadName(uploadId: string, name: unknown): Promise<void> {
	const clean = cleanFileName(name);
	if (clean) await writeFile(join(uploadDir(uploadId), 'name'), clean).catch(() => {});
}

export async function readUploadName(uploadId: string): Promise<string | null> {
	return cleanFileName(await readFile(join(uploadDir(uploadId), 'name'), 'utf8').catch(() => '')) || null;
}

/** Validate an existing immutable chunk when retrying after an uncertain commit. */
export async function readChunk(uploadId: string, index: number): Promise<Buffer> {
	return readFile(join(uploadDir(uploadId), `c${index}`));
}

/** Write via a temp file + rename so readers never observe a half-written file. */
export async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
	const tmp = `${path}.tmp-${randomUUID()}`;
	try {
		await writeFile(tmp, data, { flag: 'wx' });
		await rename(tmp, path);
	} catch (cause) {
		await rm(tmp, { force: true }).catch(() => {});
		throw cause;
	}
}

// Chunked uploads: big videos can't be sent in one request (a Cloudflare-proxied
// origin caps the body at ~100 MB), so the client streams the original in <100 MB
// parts. Each upload gets a staging dir under `.uploads/<id>/` holding a `meta.json`
// plus one file per chunk (`c0`, `c1`, …); `assembleUpload` concatenates them in order.

/** Resolve (and traversal-guard) the staging dir for an upload id. */
function uploadDir(uploadId: string): string {
	const dir = resolve(UPLOAD_TMP, uploadId);
	if (dir !== UPLOAD_TMP && !dir.startsWith(UPLOAD_TMP + sep)) throw new Error('bad upload id');
	return dir;
}

/** Create the private staging directory for an upload session. */
export async function createUpload(uploadId: string): Promise<void> {
	const dir = uploadDir(uploadId);
	await mkdir(dir, { recursive: true });
}

/**
 * Persist one chunk of an in-progress upload. The chunk is fully written to a temp
 * file and then hard-linked into place, so a crash mid-write can never leave a
 * truncated `cN` that blocks every retry with EEXIST. Returns false if the chunk
 * already exists (an idempotent retry).
 */
export async function writeChunk(uploadId: string, index: number, data: Buffer): Promise<boolean> {
	if (!Number.isInteger(index) || index < 0 || index > 100_000) throw new Error('bad chunk index');
	const final = join(uploadDir(uploadId), `c${index}`);
	const tmp = `${final}.tmp-${randomUUID()}`;
	try {
		await writeFile(tmp, data, { flag: 'wx' });
		await link(tmp, final); // atomic create-if-absent
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw cause;
	} finally {
		await unlink(tmp).catch(() => {});
	}
}

/** Concatenate chunks `0..total-1` into `destAbsPath`; returns the assembled byte length. */
export async function assembleUpload(uploadId: string, total: number, destAbsPath: string): Promise<number> {
	const dir = uploadDir(uploadId);
	let size = 0;
	async function* chunks() {
		for (let i = 0; i < total; i++) {
			const buf = await readFile(join(dir, `c${i}`));
			size += buf.byteLength;
			yield buf;
		}
	}
	// Install stream error handling before the first asynchronous file read.
	await pipeline(chunks(), createWriteStream(destAbsPath), { signal: AbortSignal.timeout(5 * 60_000) });
	return size;
}

let reservedTemporaryBytes = 0;

/** Reserve assembly/transcode headroom across the single process's active jobs. */
export async function reserveVideoSpace(bytes: number): Promise<() => void> {
	await mkdir(ROOT, { recursive: true });
	const disk = await statfs(ROOT);
	const required = bytes * 2;
	if (disk.bavail * disk.bsize - reservedTemporaryBytes < required + 512 * 1024 * 1024) {
		throw new Error('Insufficient temporary media storage');
	}
	reservedTemporaryBytes += required;
	let released = false;
	return () => {
		if (!released) {
			released = true;
			reservedTemporaryBytes -= required;
		}
	};
}

/**
 * Is there room to take a video of this size from first chunk to finished file? It
 * needs its chunks, the assembled file and the compressed copy at once, hence three
 * times its size plus the same margin `reserveVideoSpace` keeps. Asked before the
 * upload starts, so nobody sends a gigabyte to a disk that cannot finish the job.
 */
export async function hasVideoSpace(bytes: number): Promise<boolean> {
	await mkdir(ROOT, { recursive: true });
	const disk = await statfs(ROOT);
	return disk.bavail * disk.bsize - reservedTemporaryBytes >= bytes * 3 + 512 * 1024 * 1024;
}

/** Remove an upload's staging dir (on completion, cancel, or error). */
export async function cleanupUpload(uploadId: string): Promise<void> {
	await rm(uploadDir(uploadId), { recursive: true, force: true });
}

/** Decode + re-encode a client-captured video frame (CPU only, no I/O). */
export async function renderPoster(
	input: Buffer
): Promise<{ thumb: Buffer; width: number | null; height: number | null }> {
	const meta = await sharp(input, { failOn: 'error', limitInputPixels: LIMITS.posterPixels }).metadata();
	const thumb = await sharp(input, { failOn: 'error', limitInputPixels: LIMITS.posterPixels })
		.resize(640, 640, { fit: 'inside', withoutEnlargement: true })
		.webp({ quality: 72 })
		.toBuffer();
	return { thumb, width: meta.width ?? null, height: meta.height ?? null };
}

/** Atomically replace a video's poster file; returns its media key. */
export async function writePoster(albumSlug: string, mediaItemId: string, thumb: Buffer): Promise<string> {
	const thumbKey = `${albumSlug}/${mediaItemId}/poster.webp`;
	await ensureMediaItemDir(albumSlug, mediaItemId);
	await writeFileAtomic(mediaWritePath(thumbKey), thumb);
	return thumbKey;
}

/** Write a small neutral thumbnail so a completed video never references a missing poster. */
export async function storeVideoPlaceholder(albumSlug: string, mediaItemId: string): Promise<string> {
	const thumbKey = `${albumSlug}/${mediaItemId}/poster.webp`;
	await ensureMediaItemDir(albumSlug, mediaItemId);
	await sharp({
		create: { width: 640, height: 360, channels: 3, background: { r: 31, g: 36, b: 48 } }
	})
		.webp({ quality: 70 })
		.toFile(mediaWritePath(thumbKey));
	return thumbKey;
}
