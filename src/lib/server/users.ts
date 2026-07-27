import { and, eq, sql } from 'drizzle-orm';
import { db } from './db';
import { newId } from './ids';
import { LOCAL_ACCOUNT, LOCAL_PROVIDER, isLocalAdmin, localAdmin } from './local-admin';
import { appSettings, users, type User } from './schema';

/** Identity claimed by a provider during sign-in. */
export interface ProviderIdentity {
	provider: string;
	providerAccountId: string;
	email?: string | null;
	name?: string | null;
	image?: string | null;
}

const configuredAdmins = () =>
	(process.env.MIRA_ADMIN_IDENTITIES ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);

/**
 * Exact provider/account identities provisioned as platform administrators, plus the
 * password account of a copy that signs in with an administrator password.
 */
export function isConfiguredAdmin(provider: string, providerAccountId: string): boolean {
	return configuredAdmins().includes(`${provider}:${providerAccountId}`) || isLocalAdmin(provider, providerAccountId);
}

/**
 * Does this copy of Mira have someone in charge: an administrator named in the
 * environment, or an administrator account? "Closed" registration only binds once
 * there is one. Without anybody able to open the door again, closing it would lock
 * the installation for good.
 *
 * The password account only counts while the password sign-in is on. Its row stays in
 * the database after `MIRA_ADMIN_PASSWORD` is removed, still marked administrator, but
 * nobody can sign in to it any more: counting it kept registration closed on a copy
 * that had just moved to Google or GitHub, so the first sign-in there was refused.
 */
export async function hasAdministrator(): Promise<boolean> {
	if (configuredAdmins().length || localAdmin().enabled) return true;
	// Reached only with the password sign-in off (see the line above).
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				eq(users.isAdmin, true),
				sql`not (${users.provider} = ${LOCAL_PROVIDER} and ${users.providerAccountId} = ${LOCAL_ACCOUNT})`
			)
		)
		.limit(1);
	return Boolean(row);
}

/** Look up an owner by their provider identity. */
export async function getUserByProvider(provider: string, providerAccountId: string): Promise<User | undefined> {
	const rows = await db
		.select()
		.from(users)
		.where(sql`${users.provider} = ${provider} and ${users.providerAccountId} = ${providerAccountId}`)
		.limit(1);
	return rows[0];
}

/** Look up an owner by primary key. */
export async function getUserById(id: string): Promise<User | undefined> {
	const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
	return rows[0];
}

export type Settings = typeof appSettings.$inferSelect;

/**
 * Read the singleton settings row, creating it on first access.
 *
 * A new installation starts with registration CLOSED: a server someone put on the
 * internet for their own friends should not hand an owner account to whoever finds
 * it. The administrator opens it, or lists who may register, in the admin settings.
 * An installation that already has its settings row keeps whatever it stores; nothing
 * here ever changes a stored choice.
 */
export async function getSettings(): Promise<Settings> {
	const rows = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
	if (rows[0]) return rows[0];
	const [created] = await db
		.insert(appSettings)
		.values({ id: 1, registrationMode: 'closed' })
		.onConflictDoNothing()
		.returning();
	if (created) return created;
	const [raced] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
	if (!raced) throw new Error('settings singleton could not be created or read');
	return raced;
}

/** True if an email is permitted by an allowlist (exact address or `@domain`). */
export function isAllowlisted(email: string | null | undefined, allowlist: string): boolean {
	if (!email) return false;
	const e = email.trim().toLowerCase();
	const domain = e.split('@')[1] ?? '';
	const entries = allowlist
		.split(/[\s,;]+/)
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return entries.some((entry) => (entry.startsWith('@') ? domain === entry.slice(1) : entry === e));
}

/**
 * Decide whether a provider identity may sign in, upserting the owner record.
 *
 * - Blocked users are always rejected.
 * - Explicitly configured administrators always pass registration gating.
 * - New users are gated by registration mode: open, closed, or allowlist. "Closed"
 *   applies once the installation has an administrator (see `hasAdministrator`).
 *
 * Returns true to allow the sign-in, false to deny.
 */
export async function authorizeSignIn(id: ProviderIdentity): Promise<boolean> {
	if (!id.provider || !id.providerAccountId || id.provider.length > 80 || id.providerAccountId.length > 300)
		return false;
	const configuredAdmin = isConfiguredAdmin(id.provider, id.providerAccountId);
	const existing = await getUserByProvider(id.provider, id.providerAccountId);
	if (existing) {
		if (existing.isBlocked) return false;
		await db.transaction(async (tx) => {
			// Same key as admin-UI mutations: serializes the last-admin check below.
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mira:admin-governance'))`);
			let isAdmin = existing.isAdmin;
			let adminFromEnv = existing.adminFromEnv;
			if (configuredAdmin) {
				isAdmin = true;
				adminFromEnv = true;
			} else if (existing.adminFromEnv && existing.isAdmin) {
				// The identity was removed from MIRA_ADMIN_IDENTITIES: revoke the rights it
				// granted, unless that would leave the platform with no active admin.
				const [{ others }] = await tx
					.select({ others: sql<number>`count(*)::int` })
					.from(users)
					.where(sql`${users.isAdmin} and not ${users.isBlocked} and ${users.id} <> ${existing.id}`);
				if (others > 0) {
					isAdmin = false;
					adminFromEnv = false;
					console.warn('[auth] revoked env-provisioned admin no longer in MIRA_ADMIN_IDENTITIES', {
						userId: existing.id
					});
				} else {
					console.warn('[auth] kept last active admin although it is no longer in MIRA_ADMIN_IDENTITIES', {
						userId: existing.id
					});
				}
			}
			await tx
				.update(users)
				.set({
					email: id.email?.slice(0, 320) ?? existing.email,
					name: id.name?.slice(0, 120) ?? existing.name,
					image: id.image?.slice(0, 2_000) ?? existing.image,
					isAdmin,
					adminFromEnv
				})
				.where(eq(users.id, existing.id));
		});
		return true;
	}

	if (!configuredAdmin) {
		const settings = await getSettings();
		if (settings.registrationMode === 'closed' && (await hasAdministrator())) return false;
		if (settings.registrationMode === 'allowlist' && !isAllowlisted(id.email, settings.registrationAllowlist)) {
			return false;
		}
	}

	const [created] = await db
		.insert(users)
		.values({
			id: newId(),
			provider: id.provider,
			providerAccountId: id.providerAccountId,
			email: id.email?.slice(0, 320) ?? null,
			name: id.name?.slice(0, 120) ?? null,
			image: id.image?.slice(0, 2_000) ?? null,
			isAdmin: configuredAdmin,
			adminFromEnv: configuredAdmin
		})
		.onConflictDoNothing()
		.returning({ id: users.id });
	if (!created) {
		// Concurrent callbacks for the same provider identity converge on the row
		// that won the unique-key race instead of turning one login into a 500.
		const raced = await getUserByProvider(id.provider, id.providerAccountId);
		if (!raced || raced.isBlocked) return false;
		if (configuredAdmin && !raced.isAdmin) {
			await db.update(users).set({ isAdmin: true, adminFromEnv: true }).where(eq(users.id, raced.id));
		}
	}
	return true;
}
