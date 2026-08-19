import { db } from '#lib/server/db.js';
import { users } from '#lib/server/schema.js';
import {
	assertAdminMutationAllowed,
	deleteAccount,
	effectiveQuotaMb,
	ADMIN_PAGE_SIZE,
	listAlbumsForAdmin,
	listUsersForAdmin,
	platformStats,
	saveLimits,
	saveMaintenance,
	saveRegistration,
	setAlbumDisabled,
	setUserQuota
} from '#lib/server/admin.js';
import { getSettings, getUserById } from '#lib/server/users.js';
import { translator } from '#lib/i18n/index.js';
import { error, fail, isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { boundedInteger, LIMITS, optionalText, requireContentLength, requiredUuid } from '#lib/server/input.js';
import { rateLimit } from '#lib/server/rate-limit.js';

/** Resolve the current admin, or throw. Used by load and every action. */
async function requireAdmin(locals: App.Locals) {
	const t = translator(locals.locale);
	const session = await locals.auth();
	if (!session?.user) throw error(401, t('srv.signIn'));
	const me = await getUserById(session.user.id);
	if (!me?.isAdmin) throw error(403, t('srv.adminsOnly'));
	return me;
}

async function requireAdminAction(request: Request, locals: App.Locals) {
	const admin = await requireAdmin(locals);
	rateLimit(`admin-action:${admin.id}`, 240, 60_000);
	requireContentLength(request, LIMITS.formBytes);
	return admin;
}

/** Positive page number from the query string, clamped to something sane. */
function pageParam(url: URL, key: string): number {
	const n = Number(url.searchParams.get(key));
	return Number.isSafeInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const me = await requireAdmin(locals);
	const userQ = (url.searchParams.get('uq') ?? '').trim().slice(0, 200);
	const albumQ = (url.searchParams.get('aq') ?? '').trim().slice(0, 200);
	const userPage = pageParam(url, 'up');
	const albumPage = pageParam(url, 'ap');

	// Paged and searched in SQL: the previous version loaded every account and every
	// album on each admin visit, which grows without bound with the platform.
	const [settings, stats, userResult, albumResult] = await Promise.all([
		getSettings(),
		platformStats(),
		listUsersForAdmin(userQ, userPage),
		listAlbumsForAdmin(albumQ, albumPage)
	]);

	const userList = userResult.rows.map((u) => ({
		id: u.id,
		name: u.name,
		email: u.email,
		provider: u.provider,
		isAdmin: u.isAdmin,
		isBlocked: u.isBlocked,
		quotaMb: u.quotaMb,
		effectiveQuotaMb: effectiveQuotaMb(u.quotaMb, settings),
		usedBytes: u.usedBytes,
		albums: u.albums,
		createdAt: u.createdAt,
		isSelf: u.id === me.id
	}));

	return {
		settings,
		stats,
		users: userList,
		albums: albumResult.rows,
		paging: {
			pageSize: ADMIN_PAGE_SIZE,
			userQ,
			userPage,
			usersMatched: userResult.matched,
			albumQ,
			albumPage,
			albumsMatched: albumResult.matched
		}
	};
};

export const actions: Actions = {
	registration: async ({ request, locals }) => {
		await requireAdminAction(request, locals);
		const fd = await request.formData();
		const mode = String(fd.get('mode') ?? '');
		if (!['open', 'closed', 'allowlist'].includes(mode)) return fail(400, { error: 'Invalid registration mode' });
		await saveRegistration(mode, optionalText(fd.get('allowlist'), 'Allowlist', LIMITS.allowlist));
		return { ok: true };
	},

	limits: async ({ request, locals }) => {
		await requireAdminAction(request, locals);
		const fd = await request.formData();
		try {
			await saveLimits({
				defaultQuotaMb: boundedInteger(fd.get('defaultQuotaMb'), 'Default quota', 0, 2_000_000),
				maxAlbumsPerUser: boundedInteger(fd.get('maxAlbumsPerUser'), 'Album limit', 0, 10_000),
				maxUploadMb: boundedInteger(fd.get('maxUploadMb'), 'Image size limit', 1, 50),
				maxVideoMb: boundedInteger(fd.get('maxVideoMb'), 'Video size limit', 1, 5120)
			});
		} catch (cause) {
			return fail(400, { error: isHttpError(cause) ? cause.body.message : 'Invalid limits' });
		}
		return { ok: true };
	},

	maintenance: async ({ request, locals }) => {
		await requireAdminAction(request, locals);
		const fd = await request.formData();
		await saveMaintenance({
			uploadsPaused: fd.get('uploadsPaused') === '1',
			albumCreationPaused: fd.get('albumCreationPaused') === '1'
		});
		return { ok: true };
	},

	setQuota: async ({ request, locals }) => {
		await requireAdminAction(request, locals);
		const fd = await request.formData();
		const id = requiredUuid(fd.get('userId'), 'Account id');
		const raw = String(fd.get('quotaMb') ?? '').trim();
		await setUserQuota(id, raw === '' ? null : boundedInteger(raw, 'Quota', 0, 2_000_000));
		return { ok: true };
	},

	block: async ({ request, locals }) => {
		const me = await requireAdminAction(request, locals);
		const id = requiredUuid((await request.formData()).get('userId'), 'Account id');
		if (id === me.id) return fail(400, { error: translator(locals.locale)('srv.cantBlockYourself') });
		await db.transaction(async (tx) => {
			await assertAdminMutationAllowed(tx, me.id, id, true);
			await tx.update(users).set({ isBlocked: true }).where(eq(users.id, id));
		});
		return { ok: true };
	},

	unblock: async ({ request, locals }) => {
		await requireAdminAction(request, locals);
		const id = requiredUuid((await request.formData()).get('userId'), 'Account id');
		await db.update(users).set({ isBlocked: false }).where(eq(users.id, id));
		return { ok: true };
	},

	setAdmin: async ({ request, locals }) => {
		const me = await requireAdminAction(request, locals);
		const fd = await request.formData();
		const id = requiredUuid(fd.get('userId'), 'Account id');
		const desired = fd.get('isAdmin');
		if (desired !== '0' && desired !== '1') return fail(400, { error: 'Invalid administrator state' });
		if (id === me.id) return fail(400, { error: translator(locals.locale)('srv.cantChangeOwnAdmin') });
		await db.transaction(async (tx) => {
			await assertAdminMutationAllowed(tx, me.id, id, desired === '0');
			await tx
				.update(users)
				// An explicit admin-UI decision is no longer tied to MIRA_ADMIN_IDENTITIES.
				.set({ isAdmin: desired === '1', adminFromEnv: false })
				.where(eq(users.id, id));
		});
		return { ok: true };
	},

	deleteAccount: async ({ request, locals }) => {
		const me = await requireAdminAction(request, locals);
		const fd = await request.formData();
		const id = requiredUuid(fd.get('userId'), 'Account id');
		if (id === me.id) return fail(400, { error: translator(locals.locale)('srv.cantDeleteYourself') });
		await deleteAccount(id, me.id);
		return { ok: true };
	},

	toggleAlbum: async ({ request, locals }) => {
		await requireAdminAction(request, locals);
		const fd = await request.formData();
		await setAlbumDisabled(requiredUuid(fd.get('albumId'), 'Album id'), fd.get('disabled') === '1');
		return { ok: true };
	}
};
