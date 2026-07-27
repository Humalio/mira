/**
 * Signing in with an administrator password, for an installation that should work
 * without registering an application with Google or GitHub first.
 *
 * Set `MIRA_ADMIN_PASSWORD` (at least 12 characters) and the sign-in page offers a
 * password field. Whoever knows the password is the one local account,
 * `password:admin`, which is an administrator. Other people who should own albums
 * still sign in through an OAuth provider; guests never sign in at all.
 *
 * Nothing is stored: the password lives only in the environment, next to
 * `AUTH_SECRET` and the database password, and is compared in constant time. The
 * trade-offs, plainly:
 *
 * - One factor. There is no second step and no "forgot password"; the provider's own
 *   protections (2-step sign-in, alerts) that come with Google or GitHub are absent.
 * - Guessing is slowed for everyone at once: after ten wrong tries nobody can sign in
 *   with the password for five minutes, the right one included. That caps guessing at
 *   two tries a minute, and it means a stranger can keep the operator out of the
 *   password login while they keep trying (albums and guests are unaffected).
 * - Changing or removing the password signs out every session that used it.
 *
 * Operators: docs/DEPLOYMENT.md, "Signing in".
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const LOCAL_PROVIDER = 'password';
export const LOCAL_ACCOUNT = 'admin';
export const MIN_PASSWORD_LENGTH = 12;

type Env = Record<string, string | undefined>;

export type LocalAdmin = {
	enabled: boolean;
	/** Why a password that was set is not being used; null when there is nothing wrong. */
	problem: string | null;
	/** The name the local account is shown under. */
	name: string;
};

export function localAdmin(env: Env = process.env): LocalAdmin {
	const name = (env.MIRA_ADMIN_NAME ?? '').trim().slice(0, 120) || 'Administrator';
	const password = env.MIRA_ADMIN_PASSWORD ?? '';
	if (!password) return { enabled: false, problem: null, name };
	if (password.length < MIN_PASSWORD_LENGTH) {
		return {
			enabled: false,
			problem: `MIRA_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters; the password sign-in is off`,
			name
		};
	}
	return { enabled: true, problem: null, name };
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Is this the administrator password? Constant time, and false whenever the feature is off. */
export function passwordMatches(candidate: unknown, env: Env = process.env): boolean {
	if (!localAdmin(env).enabled || typeof candidate !== 'string' || candidate.length > 1_000) return false;
	return timingSafeEqual(digest(candidate), digest(env.MIRA_ADMIN_PASSWORD ?? ''));
}

/**
 * A short mark of the current password, kept in each password session. When the
 * password is changed or removed the mark no longer matches and those sessions end.
 */
export function passwordGeneration(env: Env = process.env): string {
	if (!localAdmin(env).enabled) return '';
	return createHmac('sha256', env.AUTH_SECRET ?? '')
		.update(`mira:admin-password|${env.MIRA_ADMIN_PASSWORD}`)
		.digest('base64url')
		.slice(0, 16);
}

/** Is this identity the password administrator of a copy that has the password sign-in on? */
export const isLocalAdmin = (provider: string, providerAccountId: string, env: Env = process.env): boolean =>
	provider === LOCAL_PROVIDER && providerAccountId === LOCAL_ACCOUNT && localAdmin(env).enabled;

/**
 * Slows password guessing: after `max` wrong tries inside `windowMs`, every attempt is
 * refused until the window has passed. Process-wide, which fits the single local
 * account and the single server (see maintenance.ts).
 */
export function createAttemptLimiter(max = 10, windowMs = 5 * 60_000) {
	let failures = 0;
	let windowStart = 0;
	const expire = (now: number) => {
		if (now - windowStart >= windowMs) failures = 0;
	};
	return {
		allowed(now = Date.now()): boolean {
			expire(now);
			return failures < max;
		},
		failed(now = Date.now()): void {
			expire(now);
			if (failures === 0) windowStart = now;
			failures++;
		},
		reset(): void {
			failures = 0;
		}
	};
}
