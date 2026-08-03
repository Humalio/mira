import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { albums, appSettings, members, moments, photos, uploadSessions, users } from './schema';
import { authorizeSignIn, getSettings, hasAdministrator } from './users';
import { admitWithinQuota, saveRegistration } from './admin';
import { UPLOAD_TTL_MS } from './uploads';

// Database tests (npm run test:integration: a disposable database). Each test
// uses unique ids and removes what it created.

describe('env-provisioned administrators', () => {
	const provider = `test-${crypto.randomUUID().slice(0, 8)}`;
	const envBefore = process.env.MIRA_ADMIN_IDENTITIES;
	afterAll(async () => {
		process.env.MIRA_ADMIN_IDENTITIES = envBefore;
		await db.delete(users).where(eq(users.provider, provider));
	});
	const row = async (account: string) => (await db.select().from(users).where(eq(users.providerAccountId, account)))[0];

	it('grants from the env, revokes when removed, but never strands the last admin', async () => {
		process.env.MIRA_ADMIN_IDENTITIES = `${provider}:a,${provider}:b`;
		expect(await authorizeSignIn({ provider, providerAccountId: 'a' })).toBe(true);
		expect(await authorizeSignIn({ provider, providerAccountId: 'b' })).toBe(true);
		expect(await row('a')).toMatchObject({ isAdmin: true, adminFromEnv: true });

		process.env.MIRA_ADMIN_IDENTITIES = `${provider}:b`;
		await authorizeSignIn({ provider, providerAccountId: 'a' });
		expect(await row('a')).toMatchObject({ isAdmin: false, adminFromEnv: false });

		// Make b the only active admin platform-wide for this check.
		const others = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true));
		const onlyB = others.length === 1;
		process.env.MIRA_ADMIN_IDENTITIES = '';
		await authorizeSignIn({ provider, providerAccountId: 'b' });
		expect((await row('b')).isAdmin).toBe(onlyB ? true : false);
	});

	it('leaves admin-UI grants alone', async () => {
		process.env.MIRA_ADMIN_IDENTITIES = '';
		const before = await getSettings();
		await saveRegistration('open', ''); // "c" is a newcomer; let them in for this check
		await authorizeSignIn({ provider, providerAccountId: 'c' });
		await saveRegistration(before.registrationMode, before.registrationAllowlist);
		await db.update(users).set({ isAdmin: true, adminFromEnv: false }).where(eq(users.providerAccountId, 'c'));
		await authorizeSignIn({ provider, providerAccountId: 'c' });
		expect((await row('c')).isAdmin).toBe(true);
	});
});

describe('who may register', () => {
	const provider = `reg-${crypto.randomUUID().slice(0, 8)}`;
	const envBefore = process.env.MIRA_ADMIN_IDENTITIES;
	let before: Awaited<ReturnType<typeof getSettings>>;
	afterAll(async () => {
		process.env.MIRA_ADMIN_IDENTITIES = envBefore;
		await db.delete(users).where(eq(users.provider, provider));
		// Put the shared settings row back exactly as it was found.
		await db.delete(appSettings);
		await db.insert(appSettings).values(before);
	});

	it('a new installation starts closed, and an existing one keeps what it stores', async () => {
		before = await getSettings();
		await db.delete(appSettings);
		expect((await getSettings()).registrationMode).toBe('closed'); // created on first use
		await saveRegistration('open', '');
		expect((await getSettings()).registrationMode).toBe('open'); // a stored choice is never flipped
	});

	it('closed means only the named administrator gets in, once there is one', async () => {
		await saveRegistration('closed', '');
		process.env.MIRA_ADMIN_IDENTITIES = `${provider}:boss`;
		expect(await authorizeSignIn({ provider, providerAccountId: 'stranger' })).toBe(false);
		expect(await authorizeSignIn({ provider, providerAccountId: 'boss' })).toBe(true);
		// Someone who already has an account is not a new registration.
		expect(await authorizeSignIn({ provider, providerAccountId: 'boss' })).toBe(true);
		// The administrator's account exists now, so the door stays shut without the env too.
		process.env.MIRA_ADMIN_IDENTITIES = '';
		await db.update(users).set({ adminFromEnv: false }).where(eq(users.providerAccountId, 'boss'));
		expect(await authorizeSignIn({ provider, providerAccountId: 'stranger' })).toBe(false);
	});

	it('the password account stops counting as an administrator once the password is removed', async () => {
		const passwordBefore = process.env.MIRA_ADMIN_PASSWORD;
		const isPasswordAccount = and(eq(users.provider, 'password'), eq(users.providerAccountId, 'admin'));
		// For this check the password account is the only administrator the database knows.
		const others = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true));
		for (const other of others) await db.update(users).set({ isAdmin: false }).where(eq(users.id, other.id));
		try {
			await saveRegistration('closed', '');
			process.env.MIRA_ADMIN_IDENTITIES = '';
			process.env.MIRA_ADMIN_PASSWORD = 'a long test password';
			expect(await authorizeSignIn({ provider: 'password', providerAccountId: 'admin' })).toBe(true);
			expect((await db.select().from(users).where(isPasswordAccount))[0]).toMatchObject({ isAdmin: true });
			expect(await hasAdministrator()).toBe(true);
			expect(await authorizeSignIn({ provider, providerAccountId: 'early-stranger' })).toBe(false);

			// The operator moves to Google sign-in and removes the password. The row is
			// still there and still says "administrator", but nobody can sign in to it:
			// registration must not stay closed on its account, or nobody gets in at all.
			delete process.env.MIRA_ADMIN_PASSWORD;
			expect((await db.select().from(users).where(isPasswordAccount))[0]).toMatchObject({ isAdmin: true });
			expect(await hasAdministrator()).toBe(false);
			expect(await authorizeSignIn({ provider, providerAccountId: 'first-google-user' })).toBe(true);
		} finally {
			if (passwordBefore === undefined) delete process.env.MIRA_ADMIN_PASSWORD;
			else process.env.MIRA_ADMIN_PASSWORD = passwordBefore;
			await db.delete(users).where(isPasswordAccount);
			for (const other of others) await db.update(users).set({ isAdmin: true }).where(eq(users.id, other.id));
		}
	});

	it('the allow-list and open modes still decide for newcomers', async () => {
		await saveRegistration('allowlist', '@friends.example');
		expect(await authorizeSignIn({ provider, providerAccountId: 'x', email: 'x@other.example' })).toBe(false);
		expect(await authorizeSignIn({ provider, providerAccountId: 'y', email: 'y@friends.example' })).toBe(true);
		await saveRegistration('open', '');
		expect(await authorizeSignIn({ provider, providerAccountId: 'z' })).toBe(true);
	});
});

describe('admitWithinQuota', () => {
	const u = `q-${crypto.randomUUID()}`;
	afterAll(async () => {
		await db.delete(albums).where(eq(albums.ownerUserId, u));
		await db.delete(users).where(eq(users.id, u));
	});
	const insert = (id: string, bytes: number) => async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
		await tx.insert(photos).values({
			id,
			albumId: u,
			momentId: `${u}m`,
			memberId: `${u}e`,
			storageKey: 'k',
			thumbKey: 't',
			mime: 'image/jpeg',
			sizeBytes: bytes
		});
	};
	const album = { ownerUserId: u };

	it('admits up to the cap using the trigger-maintained counter', async () => {
		await db.insert(users).values({ id: u, provider: 'quota-test', providerAccountId: u, quotaMb: 1 });
		await db.insert(albums).values({ id: u, slug: u, name: 'Q', ownerUserId: u });
		await db.insert(moments).values({ id: `${u}m`, albumId: u, name: 'M', position: 0 });
		await db.insert(members).values({ id: `${u}e`, albumId: u, deviceToken: u, displayName: 'x' });
		expect(await admitWithinQuota(album, 700_000, insert(`${u}1`, 700_000))).toBe(true);
		expect(await admitWithinQuota(album, 400_000, insert(`${u}2`, 400_000))).toBe(false);
		expect(await admitWithinQuota(album, 300_000, insert(`${u}3`, 300_000))).toBe(true);
		const [owner] = await db.select({ used: users.usedBytes }).from(users).where(eq(users.id, u));
		expect(owner.used).toBe(1_000_000);
	});

	it('keeps the space a video under way has reserved, for that video alone', async () => {
		await db.delete(photos).where(eq(photos.albumId, u));
		const video = `${u}v`;
		await db.insert(uploadSessions).values({
			id: video,
			albumId: u,
			momentId: `${u}m`,
			memberId: `${u}e`,
			deviceToken: u,
			mime: 'video/mp4',
			declaredBytes: 600_000,
			chunkSize: 100_000,
			totalChunks: 6,
			state: 'receiving',
			approved: true,
			quality: 'small',
			expiresAt: new Date(Date.now() + UPLOAD_TTL_MS)
		});
		// 600 kB of the 1 MB are held for the video: a 500 kB photo no longer fits.
		expect(await admitWithinQuota(album, 500_000, insert(`${u}4`, 500_000))).toBe(false);
		expect(await admitWithinQuota(album, 300_000, insert(`${u}5`, 300_000))).toBe(true);
		// The video itself is not held back by its own reservation.
		const finish = async () => {};
		expect(await admitWithinQuota(album, 600_000, finish, video)).toBe(true);
		expect(await admitWithinQuota(album, 800_000, finish, video)).toBe(false);
	});
});
