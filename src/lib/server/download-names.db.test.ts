import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from './db';
import { albums, members, moments, photos, users } from './schema';
import { deleteMediaTree, ensureMediaItemDir, mediaWritePath } from './storage';
import { writeFile } from 'node:fs/promises';
import { GET as download } from '../../routes/a/[slug]/download/+server';
import { GET as media } from '../../routes/media/[...key]/+server';
import { POST as upload } from '../../routes/a/[slug]/upload/+server';

// Downloads carry the names the files had on people's devices.

describe('downloads keep original file names', () => {
	const ownerId = crypto.randomUUID();
	const albumId = crypto.randomUUID();
	const momentId = crypto.randomUUID();
	const slug = `names-${albumId}`;
	const person = (name: string) => ({ id: crypto.randomUUID(), name, deviceToken: crypto.randomUUID() });
	const marta = person('Marta');
	const zoe = person('Zoe');
	const locals = (p: typeof marta) => ({ deviceToken: p.deviceToken, locale: 'en', auth: async () => null });

	afterAll(async () => {
		await db.delete(albums).where(eq(albums.id, albumId));
		await db.delete(users).where(eq(users.id, ownerId));
		await deleteMediaTree(slug);
	});

	async function setup() {
		await db.insert(users).values({ id: ownerId, provider: 'test-names', providerAccountId: ownerId, quotaMb: 0 });
		await db.insert(albums).values({ id: albumId, slug, name: 'Names', ownerUserId: ownerId });
		await db.insert(moments).values({ id: momentId, albumId, name: 'Day 1' });
		for (const p of [marta, zoe])
			await db.insert(members).values({ id: p.id, albumId, deviceToken: p.deviceToken, displayName: p.name });
	}

	async function send(p: typeof marta, fileName: string, colour: string) {
		const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: colour } })
			.jpeg()
			.toBuffer();
		const form = new FormData();
		form.append('momentId', momentId);
		form.append('photos', new File([new Uint8Array(image)], fileName, { type: 'image/jpeg' }));
		const encoded = new Response(form);
		const body = Buffer.from(await encoded.arrayBuffer());
		const response = await upload({
			params: { slug },
			request: new Request(`http://localhost/a/${slug}/upload`, {
				method: 'POST',
				headers: { 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.length) },
				body
			}),
			locals: locals(p)
		} as unknown as Parameters<typeof upload>[0]);
		expect(await response.json()).toMatchObject({ added: 1 });
	}

	/** The file names in a ZIP, from its central directory. */
	function namesIn(zip: Buffer): string[] {
		const names: string[] = [];
		const end = zip.length - 22;
		let at = zip.readUInt32LE(end + 16);
		for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
			expect(zip.readUInt32LE(at)).toBe(0x02014b50);
			const [name, extra, comment] = [zip.readUInt16LE(at + 28), zip.readUInt16LE(at + 30), zip.readUInt16LE(at + 32)];
			names.push(zip.subarray(at + 46, at + 46 + name).toString('utf8'));
			at += 46 + name + extra + comment;
		}
		return names;
	}

	it('names each file as it was on the device, and tells namesakes apart', async () => {
		await setup();
		await send(marta, 'IMG_0001.JPG', '#c33');
		await send(zoe, 'IMG_0001.JPG', '#3c3'); // two phones, the same counter
		await send(zoe, 'Cumpleaños Ana.jpg', '#33c');
		await send(marta, '../../escape.jpg', '#cc3');
		// An item from before names were kept: no name beside it.
		const old = crypto.randomUUID();
		await ensureMediaItemDir(slug, old);
		await writeFile(mediaWritePath(`${slug}/${old}/orig.jpg`), 'old');
		await db.insert(photos).values({
			id: old,
			albumId,
			momentId,
			memberId: marta.id,
			storageKey: `${slug}/${old}/orig.jpg`,
			thumbKey: `${slug}/${old}/thumb.webp`,
			mime: 'image/jpeg',
			sizeBytes: 3
		});

		const url = new URL(`http://localhost/a/${slug}/download?scope=album`);
		const response = await download({ params: { slug }, url, locals: locals(zoe) } as unknown as Parameters<
			typeof download
		>[0]);
		const names = namesIn(Buffer.from(await response.arrayBuffer()));
		expect(names).toHaveLength(5);
		expect(names).toEqual(
			expect.arrayContaining([
				'Day_1/IMG_0001.JPG',
				'Day_1/IMG_0001 (2).JPG',
				'Day_1/Cumpleaños Ana.jpg',
				'Day_1/escape.jpg'
			])
		);
		// The unnamed one keeps the old made-up form: uploader and a number.
		expect(names.filter((name) => /^Day_1\/Marta-\d{3}\.jpg$/.test(name))).toHaveLength(1);
	});

	it('saves a single download under its original name', async () => {
		const [named] = await db.select().from(photos).where(eq(photos.memberId, zoe.id)).limit(1);
		const url = new URL(`http://localhost/media/${named.id}/original?download`);
		const headers: Record<string, string> = {};
		await media({
			params: { key: `${named.id}/original` },
			request: new Request(url),
			url,
			locals: locals(zoe),
			setHeaders: (h: Record<string, string>) => Object.assign(headers, h)
		} as unknown as Parameters<typeof media>[0]);
		expect(headers['content-disposition']).toMatch(/^attachment; filename="(IMG_0001\.JPG|Cumplea_os Ana\.jpg)"/);
	});
});
