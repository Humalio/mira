/**
 * Per-album switches that have no column in the day-zero database schema.
 *
 * The schema is fingerprinted and there is no upgrade path yet (see README), so adding
 * a column would lock every existing installation out. These few switches therefore
 * live in one small JSON file beside the album's media, `<MEDIA_DIR>/<slug>/album.json`:
 * it is on the same volume and in the same backup as the photos it governs, and it
 * disappears with the album's folder when the album is deleted. A missing file means
 * "all defaults", which are the permissive, nothing-lost choices (keep originals, album
 * open, the plain invitation link works).
 *
 * A file that exists but cannot be read (a disk error, too many open files, damaged
 * content) is a different matter: the album may be closed and its old invitation
 * revoked, and nobody can tell. Until the file reads again the album is therefore
 * treated as closed with no valid invitation, originals are kept, nothing is cached,
 * and no change is saved over the file (see `unreadable`).
 *
 * The media route only ever serves keys recorded in the database, so this file is
 * never reachable from the web.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { error } from '@sveltejs/kit';
import { mediaWritePath, writeFileAtomic } from './storage';

export type AlbumOptions = {
	/**
	 * "Save space: keep only the small copy". When true, a video's original file is
	 * deleted once its playback copy exists. Off by default: Mira is for sharing originals.
	 */
	keepOnlyCopy: boolean;
	/** The album is closed: nothing new can be added; looking and downloading still work. */
	locked: boolean;
	/**
	 * Set once the owner resets the invitation link. From then on joining needs
	 * `?k=<inviteKey>`, so the link and QR code handed out before stop letting people
	 * in. Null means the album's plain link works, as it always did.
	 */
	inviteKey: string | null;
	/**
	 * Present (and true) only when the album's file exists but could not be read just
	 * now. The other values are then the cautious ones, not the album's own: closed, and
	 * originals kept. Nobody can join through any link meanwhile (see invite.ts).
	 */
	unreadable?: true;
};

const DEFAULTS: AlbumOptions = { keepOnlyCopy: false, locked: false, inviteKey: null };
const UNREADABLE: AlbumOptions = { keepOnlyCopy: false, locked: true, inviteKey: null, unreadable: true };

/** The album's settings file could not be read, so a change cannot safely be written over it. */
export class AlbumOptionsUnreadable extends Error {
	constructor(slug: string) {
		super(`album settings of ${slug} cannot be read; not overwriting them`);
		this.name = 'AlbumOptionsUnreadable';
	}
}

/**
 * For a route that saves a switch: answers 503 with `message` (in the owner's language)
 * when the settings cannot be read, instead of an unexplained error page.
 * Use as `saveAlbumOptions(…).catch(settingsUnavailable(message))`.
 */
export const settingsUnavailable =
	(message: string) =>
	(cause: unknown): never => {
		if (cause instanceof AlbumOptionsUnreadable) throw error(503, message);
		throw cause;
	};

// Single instance (see maintenance.ts), so a process-local cache is always current.
const cache = new Map<string, AlbumOptions>();
// One change at a time per album: each is "read, alter, write", and two at once (close
// the album while resetting its link) would write the older picture over the newer.
const saving = new Map<string, Promise<unknown>>();
// An unreadable file is asked for again on every request; say so once a minute, not each time.
const warned = new Map<string, number>();

const optionsPath = (slug: string) => mediaWritePath(`${slug}/album.json`);

/** The album's switches; defaults when it has never saved any. */
export async function getAlbumOptions(slug: string): Promise<AlbumOptions> {
	const cached = cache.get(slug);
	if (cached) return cached;
	let options = DEFAULTS;
	try {
		const stored = JSON.parse(await readFile(optionsPath(slug), 'utf8')) as Partial<AlbumOptions> | null;
		options = {
			keepOnlyCopy: stored?.keepOnlyCopy === true,
			locked: stored?.locked === true,
			inviteKey:
				typeof stored?.inviteKey === 'string' && /^[a-z0-9]{8,64}$/.test(stored.inviteKey) ? stored.inviteKey : null
		};
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			// Not cached: the next request reads the file again, and the album is itself
			// again the moment the file can be read.
			const now = Date.now();
			if (now - (warned.get(slug) ?? 0) > 60_000) {
				if (warned.size > 1_000) warned.clear();
				warned.set(slug, now);
				console.error('[album-options] unreadable; treating the album as closed and its invitation as void', {
					slug,
					cause: String(cause)
				});
			}
			return UNREADABLE;
		}
	}
	cache.set(slug, options);
	return options;
}

/**
 * Change some of the album's switches, leaving the others as they are. Throws
 * `AlbumOptionsUnreadable` rather than replace a file it could not read.
 */
export function saveAlbumOptions(slug: string, patch: Partial<AlbumOptions>): Promise<AlbumOptions> {
	const save = async (): Promise<AlbumOptions> => {
		const current = await getAlbumOptions(slug);
		if (current.unreadable) throw new AlbumOptionsUnreadable(slug);
		const next = { ...current, ...patch };
		const path = optionsPath(slug);
		await mkdir(dirname(path), { recursive: true });
		await writeFileAtomic(path, Buffer.from(JSON.stringify(next)));
		cache.set(slug, next);
		return next;
	};
	const turn = (saving.get(slug) ?? Promise.resolve()).then(save, save);
	saving.set(slug, turn);
	const forget = () => {
		if (saving.get(slug) === turn) saving.delete(slug);
	};
	turn.then(forget, forget);
	return turn;
}
