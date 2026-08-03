import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('per-album switches kept beside the media', () => {
	let work: string;
	let options: typeof import('./album-options');
	let storage: typeof import('./storage');
	let invite: typeof import('./invite');

	beforeAll(async () => {
		work = mkdtempSync(join(tmpdir(), 'mira-options-'));
		process.env.MEDIA_DIR = join(work, 'media');
		options = await import('./album-options');
		storage = await import('./storage');
		invite = await import('./invite');
	});
	afterAll(() => rmSync(work, { recursive: true, force: true }));

	it('defaults to keeping originals when nothing was ever saved', async () => {
		expect(await options.getAlbumOptions('never-saved')).toMatchObject({ keepOnlyCopy: false });
	});

	it('remembers a change, for an album that has no media folder yet', async () => {
		expect(await options.saveAlbumOptions('fresh-album', { keepOnlyCopy: true })).toMatchObject({ keepOnlyCopy: true });
		expect(await options.getAlbumOptions('fresh-album')).toMatchObject({ keepOnlyCopy: true });
		await options.saveAlbumOptions('fresh-album', { keepOnlyCopy: false });
		expect(await options.getAlbumOptions('fresh-album')).toMatchObject({ keepOnlyCopy: false });
	});

	it('keeps the other switches when one changes', async () => {
		await options.saveAlbumOptions('event', { locked: true, inviteKey: 'abcdefgh2345' });
		await options.saveAlbumOptions('event', { keepOnlyCopy: true });
		expect(await options.getAlbumOptions('event')).toEqual({
			keepOnlyCopy: true,
			locked: true,
			inviteKey: 'abcdefgh2345'
		});
	});

	it('ignores values that could not have come from Mira', async () => {
		await storage.ensureMediaItemDir('odd', 'x');
		writeFileSync(storage.mediaWritePath('odd/album.json'), JSON.stringify({ inviteKey: '../x', locked: 'yes' }));
		expect(await options.getAlbumOptions('odd')).toEqual({ keepOnlyCopy: false, locked: false, inviteKey: null });
	});

	it('treats an album whose file cannot be read as closed, with no valid invitation', async () => {
		// Its old link was revoked. Then, after a restart, the file stops being readable.
		await storage.ensureMediaItemDir('damaged', 'x');
		const file = storage.mediaWritePath('damaged/album.json');
		const good = JSON.stringify({ keepOnlyCopy: false, locked: false, inviteKey: 'abcdefgh2345' });
		writeFileSync(file, good);
		const current = new URL('http://localhost/j/damaged?k=abcdefgh2345');

		// Reading a folder fails the way a disk error does (the file exists, no content comes).
		const aside = `${file}.aside`;
		renameSync(file, aside);
		mkdirSync(file);
		expect(await options.getAlbumOptions('damaged')).toEqual({
			keepOnlyCopy: false, // originals are kept
			locked: true, // nothing new is taken
			inviteKey: null,
			unreadable: true
		});
		// Neither the revoked plain link nor the current one lets anybody in meanwhile.
		expect(await invite.invitationValid('damaged', new URL('http://localhost/j/damaged'))).toBe(false);
		expect(await invite.invitationValid('damaged', current)).toBe(false);
		// And no change is written over settings nobody could read.
		await expect(options.saveAlbumOptions('damaged', { locked: false })).rejects.toBeInstanceOf(
			options.AlbumOptionsUnreadable
		);
		await expect(
			options.saveAlbumOptions('damaged', { locked: false }).catch(options.settingsUnavailable('Try later'))
		).rejects.toMatchObject({ status: 503, body: { message: 'Try later' } });

		// The moment it reads again the album is itself again: nothing cautious was cached.
		rmSync(file, { recursive: true });
		renameSync(aside, file);
		expect(readFileSync(file, 'utf8')).toBe(good);
		expect(await options.getAlbumOptions('damaged')).toEqual({
			keepOnlyCopy: false,
			locked: false,
			inviteKey: 'abcdefgh2345'
		});
		expect(await invite.invitationValid('damaged', current)).toBe(true);
	});

	it('is just as careful with a file whose content is damaged', async () => {
		await storage.ensureMediaItemDir('garbled', 'x');
		writeFileSync(storage.mediaWritePath('garbled/album.json'), '{ not json');
		expect(await options.getAlbumOptions('garbled')).toMatchObject({ locked: true, unreadable: true });
		await expect(options.saveAlbumOptions('garbled', { keepOnlyCopy: true })).rejects.toBeInstanceOf(
			options.AlbumOptionsUnreadable
		);
		expect(readFileSync(storage.mediaWritePath('garbled/album.json'), 'utf8')).toBe('{ not json');
	});

	it('keeps both changes when two are saved at the same moment', async () => {
		await Promise.all([
			options.saveAlbumOptions('busy', { locked: true }),
			options.saveAlbumOptions('busy', { inviteKey: 'abcdefgh2345' }),
			options.saveAlbumOptions('busy', { keepOnlyCopy: true })
		]);
		const saved = { keepOnlyCopy: true, locked: true, inviteKey: 'abcdefgh2345' };
		expect(await options.getAlbumOptions('busy')).toEqual(saved);
		expect(JSON.parse(readFileSync(storage.mediaWritePath('busy/album.json'), 'utf8'))).toEqual(saved);
	});

	it('refuses a slug that would leave the media folder', async () => {
		await expect(options.saveAlbumOptions('../../outside', { keepOnlyCopy: true })).rejects.toThrow();
	});
});
