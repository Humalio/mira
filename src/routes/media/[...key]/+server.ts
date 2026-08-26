import { db } from '#lib/server/db.js';
import { isAlbumOwner, memberFor } from '#lib/server/guard.js';
import { albums, photos } from '#lib/server/schema.js';
import { attachment, downloadName } from '#lib/server/archive-names.js';
import { mediaAbsPath, readOriginalName } from '#lib/server/storage.js';
import { playbackKey } from '#lib/server/video.js';
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { rateLimit } from '#lib/server/rate-limit.js';
import { requiredUuid } from '#lib/server/input.js';

const MIME: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	avif: 'image/avif',
	heic: 'image/heic',
	tif: 'image/tiff',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	webm: 'video/webm',
	mkv: 'video/x-matroska',
	'3gp': 'video/3gpp',
	m4v: 'video/x-m4v'
};
// Originals and playback copies are immutable once their row exists (both are written
// before the insert).
// Previews can be replaced (video placeholder -> client poster at the same key), so
// they revalidate cheaply by ETag. `private` keeps shared caches/CDNs out of it.
const CACHE_ORIGINAL = 'private, max-age=31536000, immutable';
const CACHE_PREVIEW = 'private, max-age=300, must-revalidate';

const toWeb = (stream: ReturnType<typeof createReadStream>) => Readable.toWeb(stream) as unknown as ReadableStream;

export const GET: RequestHandler = async ({ params, request, url, setHeaders, locals }) => {
	const [mediaItemId, variant, extra] = params.key.split('/');
	// preview: the thumbnail. original: the file as uploaded (what Download gives).
	// play: what the viewer shows, i.e. a video's small copy when it has one.
	if (!mediaItemId || !['preview', 'original', 'play'].includes(variant) || extra) throw error(404);
	requiredUuid(mediaItemId, 'Media item id');
	// One round trip for item + enabled album (this endpoint is hit once per thumbnail).
	const [row] = await db
		.select({ mediaItem: photos, album: { id: albums.id, ownerUserId: albums.ownerUserId } })
		.from(photos)
		.innerJoin(albums, and(eq(albums.id, photos.albumId), eq(albums.disabled, false)))
		.where(eq(photos.id, mediaItemId))
		.limit(1);
	if (!row) throw error(404);
	const { mediaItem, album } = row;
	const member = await memberFor(album.id, locals);
	if (!member) throw error(403);
	rateLimit(`media:${album.id}:${member.id}`, 600, 60_000);
	if (!mediaItem.approved && mediaItem.memberId !== member.id && !(await isAlbumOwner(album, locals))) throw error(404);

	// Every variant passed the same membership and approval checks above, so a video's
	// playback copy is exactly as visible as its original.
	const candidates =
		variant === 'preview'
			? [mediaItem.thumbKey]
			: variant === 'play'
				? [playbackKey(mediaItem), mediaItem.storageKey] // no copy (or it went missing): play the original
				: [mediaItem.storageKey];
	let abs = '';
	let size = 0;
	let etag = '';
	for (const key of candidates) {
		if (!key) continue;
		const path = mediaAbsPath(key);
		if (!path) throw error(403);
		try {
			const info = await stat(path);
			abs = path;
			size = info.size;
			etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
			break;
		} catch {
			/* try the next candidate */
		}
	}
	if (!abs) throw error(404);
	const cache = variant === 'preview' ? CACHE_PREVIEW : CACHE_ORIGINAL;
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers: { etag, 'cache-control': cache } });
	}

	const ext = abs.split('.').pop()?.toLowerCase() ?? '';
	const type = MIME[ext] ?? 'application/octet-stream';
	// "Download" in the viewer: save the file under the name it had on the uploader's
	// device (or a made-up one), instead of whatever the browser makes of a URL that
	// ends in "/original".
	if (url.searchParams.has('download')) {
		const name = downloadName(
			await readOriginalName(mediaItem.storageKey),
			ext || 'bin',
			`mira-${mediaItem.id.slice(0, 8)}`
		);
		setHeaders({ 'content-disposition': attachment(name) });
	}

	// Range support — required for video seeking and large-file streaming.
	const range = request.headers.get('range');
	if (range) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (!match || (!match[1] && !match[2])) {
			return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
		}
		let start = match && match[1] ? Number(match[1]) : 0;
		let end = match && match[2] ? Number(match[2]) : size - 1;
		if (!match[1] && match[2]) {
			const suffixLength = Math.min(size, Number(match[2]));
			start = size - suffixLength;
			end = size - 1;
		}
		if (Number.isNaN(start) || start < 0) start = 0;
		if (Number.isNaN(end) || end >= size) end = size - 1;
		if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
		setHeaders({
			'content-type': type,
			'content-length': String(end - start + 1),
			'content-range': `bytes ${start}-${end}/${size}`,
			'accept-ranges': 'bytes',
			'cache-control': cache,
			etag,
			'x-content-type-options': 'nosniff'
		});
		return new Response(toWeb(createReadStream(abs, { start, end })), { status: 206 });
	}

	setHeaders({
		'content-type': type,
		'content-length': String(size),
		'accept-ranges': 'bytes',
		'cache-control': cache,
		etag,
		'x-content-type-options': 'nosniff'
	});
	return new Response(toWeb(createReadStream(abs)));
};
