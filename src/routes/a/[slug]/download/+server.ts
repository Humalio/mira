import { isAlbumOwner, resolveAlbumMember } from '#lib/server/guard.js';
import { translator } from '#lib/i18n/index.js';
import { db } from '#lib/server/db.js';
import { favorites, members, moments, photos } from '#lib/server/schema.js';
import { attachment, downloadName, uniqueNames } from '#lib/server/archive-names.js';
import { mediaAbsPath, readOriginalName } from '#lib/server/storage.js';
import { playbackKey } from '#lib/server/video.js';
import { error } from '@sveltejs/kit';
import { ZipArchive } from 'archiver';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { Readable, Transform } from 'node:stream';
import { createReadStream, type ReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { rateLimit } from '#lib/server/rate-limit.js';
import { LIMITS, requiredUuid } from '#lib/server/input.js';

/**
 * A file the archive opens only when it reaches it, and whose open handle is kept in
 * `open` so a download the client abandons can close it: archiver's own abort leaves
 * the file it was reading open.
 */
function lazyFile(path: string, open: Set<ReadStream>): Readable {
	let source: ReadStream | null = null;
	return new Readable({
		read() {
			if (source) return void source.resume();
			const file = (source = createReadStream(path));
			open.add(file);
			file.on('data', (chunk) => {
				if (!this.push(chunk)) file.pause();
			});
			file.on('end', () => this.push(null));
			file.on('error', (e) => this.destroy(e));
			file.on('close', () => open.delete(file));
		},
		destroy(cause, callback) {
			source?.destroy();
			callback(cause);
		}
	});
}

const sanitizeSegment = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'file';
const DOWNLOAD_SCOPES = new Set(['album', 'member', 'ids', 'favs']);
const MAX_CONCURRENT_DOWNLOADS = 2;
const MAX_ARCHIVE_ITEMS = 5000;
const STALL_TIMEOUT_MS = 60_000;
let activeDownloads = 0;
const activeByMember = new Set<string>();

export const GET: RequestHandler = async ({ params, url, locals }) => {
	const t = translator(locals.locale);
	const { album, member } = await resolveAlbumMember(params.slug, locals);
	rateLimit(`download:${album.id}:${member.id}`, 6, 60_000);
	const isOwner = await isAlbumOwner(album, locals);

	const scope = url.searchParams.get('scope') ?? 'album';
	const id = url.searchParams.get('id');
	if (!DOWNLOAD_SCOPES.has(scope)) throw error(400, 'Invalid download scope');
	if (scope === 'member' && !id) throw error(400, 'A download id is required');
	// The person downloading decides: every video as uploaded (the default), or the
	// small copy the album plays, which downloads many times faster. Photos, and videos
	// that have no copy, are always the original.
	const smallVideos = url.searchParams.get('videos') === 'copy';
	const scopedId = scope === 'member' ? requiredUuid(id, 'Download id') : null;
	// Any member may download another member's contributions: the same items are
	// already reachable through the whole-album archive, and the visibility filter
	// below still hides other people's unapproved uploads.
	const scopedMember =
		scope === 'member'
			? (
					await db
						.select({ id: members.id, displayName: members.displayName })
						.from(members)
						.where(and(eq(members.id, scopedId!), eq(members.albumId, album.id)))
						.limit(1)
				)[0]
			: undefined;
	if (scope === 'member' && !scopedMember) throw error(404, t('srv.nothingToDownload'));
	const requestedIds = scope === 'ids' ? (url.searchParams.get('ids') ?? '').split(',').filter(Boolean) : [];
	if (requestedIds.length > LIMITS.selectedMedia) throw error(400, 'Too many selected media items');
	const selectedIds = requestedIds.map((requestedId) => requiredUuid(requestedId, 'Media item id'));
	if (scope === 'ids' && !selectedIds.length) throw error(404, t('srv.nothingToDownload'));
	// One archive per member, so a single guest can't take every global slot.
	if (activeByMember.has(member.id)) throw error(429, 'A download is already in progress');
	if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) throw error(503, 'The download service is busy; try again shortly');
	activeDownloads++;
	activeByMember.add(member.id);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		activeDownloads--;
		activeByMember.delete(member.id);
	};
	try {
		const rows = await db
			.select({
				mediaItemId: photos.id,
				momentId: photos.momentId,
				memberId: photos.memberId,
				storageKey: photos.storageKey,
				kind: photos.kind,
				optimized: photos.optimized,
				by: members.displayName,
				moment: moments.name
			})
			.from(photos)
			.innerJoin(members, eq(photos.memberId, members.id))
			.innerJoin(moments, eq(photos.momentId, moments.id))
			.where(
				and(
					eq(photos.albumId, album.id),
					isOwner ? undefined : or(eq(photos.approved, true), eq(photos.memberId, member.id)),
					scopedMember ? eq(photos.memberId, scopedMember.id) : undefined,
					scope === 'ids' ? inArray(photos.id, selectedIds) : undefined,
					scope === 'favs'
						? sql`exists (select 1 from ${favorites} where ${favorites.photoId} = ${photos.id} and ${favorites.memberId} = ${member.id})`
						: undefined
				)
			)
			// Timeline order, so the numbered file names follow the album instead of
			// whatever order the planner happened to return.
			.orderBy(asc(sql`coalesce(${photos.takenAt}, ${photos.createdAt})`), asc(photos.id))
			.limit(MAX_ARCHIVE_ITEMS + 1);
		if (rows.length > MAX_ARCHIVE_ITEMS)
			throw error(413, `Archive exceeds ${MAX_ARCHIVE_ITEMS} items; choose a smaller scope`);

		let label = sanitizeSegment(album.name);
		if (scopedMember) {
			label = `${sanitizeSegment(album.name)}-${sanitizeSegment(scopedMember.displayName)}`;
		} else if (scope === 'ids') {
			label = `${sanitizeSegment(album.name)}-selection`;
		} else if (scope === 'favs') {
			label = `${sanitizeSegment(album.name)}-favorites`;
		}

		if (!rows.length) throw error(404, t('srv.nothingToDownload'));
		const available: Array<{ row: (typeof rows)[number]; abs: string; stats: Stats; original: string | null }> = [];
		const reachable = async (key: string | null) => {
			const abs = key && mediaAbsPath(key);
			if (!abs) return null;
			return stat(abs).then(
				(stats) => (stats.isFile() ? { abs, stats } : null),
				() => null
			);
		};
		for (let offset = 0; offset < rows.length; offset += 32) {
			const batch = await Promise.all(
				rows.slice(offset, offset + 32).map(async (row) => {
					// A copy that has gone missing must not cost the person the video.
					const file = (smallVideos ? await reachable(playbackKey(row)) : null) ?? (await reachable(row.storageKey));
					return file ? { row, ...file, original: await readOriginalName(row.storageKey) } : null;
				})
			);
			for (const entry of batch) if (entry) available.push(entry);
		}
		if (!available.length) throw error(404, t('srv.nothingToDownload'));

		const archive = new ZipArchive({ zlib: { level: 0 } }); // store without deflate: media is already compressed
		// A client that stops reading (backgrounded tab, slow-loris) would otherwise hold
		// one of the two global slots forever. Any stretch without progress aborts it.
		let stall: NodeJS.Timeout | undefined;
		const pass: Transform = new Transform({
			transform(chunk, _encoding, callback) {
				armStall();
				callback(null, chunk);
			}
		});
		const armStall = () => {
			clearTimeout(stall);
			stall = setTimeout(() => pass.destroy(new Error('download stalled')), STALL_TIMEOUT_MS);
		};
		armStall();
		const open = new Set<ReadStream>();
		pass.once('close', () => {
			clearTimeout(stall);
			release();
			// The client went away (or stalled) before the end: stop, and close what is open.
			if (!pass.writableFinished) {
				archive.abort();
				for (const file of open) file.destroy();
			}
		});
		pass.once('end', release);
		archive.on('warning', (w) => console.warn('[download] archive warning', { albumId: album.id, warning: String(w) }));
		archive.on('error', (e) => {
			console.error('[download] archive failed mid-stream', { albumId: album.id, error: String(e) });
			archive.abort();
			pass.destroy(e);
		});
		archive.pipe(pass);

		// Each file keeps the name it had on the uploader's device, so it can be matched
		// against a camera roll; two files of the same name in one folder are numbered
		// apart, and one whose name is unknown is called after its uploader.
		let n = 0;
		const unique = uniqueNames();
		for (const { row: r, abs, stats, original } of available) {
			const ext = abs.split('.').pop() ?? 'jpg'; // of the file actually sent
			const fallback = `${sanitizeSegment(r.by)}-${String(++n).padStart(3, '0')}`;
			archive.append(lazyFile(abs, open), {
				name: unique(sanitizeSegment(r.moment), downloadName(original, ext, fallback)),
				stats
			});
		}
		archive.finalize().catch((e) => pass.destroy(e));

		return new Response(Readable.toWeb(pass) as unknown as ReadableStream, {
			headers: {
				'content-type': 'application/zip',
				'content-disposition': attachment(`${label}.zip`),
				'cache-control': 'private, no-store'
			}
		});
	} catch (cause) {
		release();
		throw cause;
	}
};
