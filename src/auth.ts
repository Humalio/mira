import { SvelteKitAuth, type SvelteKitAuthConfig } from '@auth/sveltekit';
import Credentials from '@auth/sveltekit/providers/credentials';
import Facebook from '@auth/sveltekit/providers/facebook';
import GitHub from '@auth/sveltekit/providers/github';
import Google from '@auth/sveltekit/providers/google';
import {
	LOCAL_ACCOUNT,
	LOCAL_PROVIDER,
	createAttemptLimiter,
	localAdmin,
	passwordGeneration,
	passwordMatches
} from '#lib/server/local-admin.js';
import { authorizeSignIn, getUserById, getUserByProvider } from '#lib/server/users.js';
import { building } from '$app/env';

// Auth.js reads AUTH_SECRET itself, but explicit validation gives operators a
// useful startup error. Build analysis imports this module, so runtime-only
// configuration must not be required while `building` is true.
const has = (a?: string, b?: string) => Boolean(a && b);

if (
	!building &&
	process.env.NODE_ENV === 'production' &&
	(!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32)
) {
	throw new Error('AUTH_SECRET must be set to at least 32 characters in production');
}

const providers: SvelteKitAuthConfig['providers'] = [];
/**
 * Active providers, for rendering login buttons. `dev` is the password-less dev
 * provider; `password` is the administrator password (see #lib/server/local-admin).
 */
export const enabledProviders: { id: string; name: string; dev?: boolean; password?: boolean }[] = [];

// Each social provider activates only when its credentials are present in the
// environment — "add another network" is just two more env vars, no code change.
if (has(process.env.AUTH_GOOGLE_ID, process.env.AUTH_GOOGLE_SECRET)) {
	providers.push(Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET }));
	enabledProviders.push({ id: 'google', name: 'Google' });
}
if (has(process.env.AUTH_FACEBOOK_ID, process.env.AUTH_FACEBOOK_SECRET)) {
	providers.push(Facebook({ clientId: process.env.AUTH_FACEBOOK_ID, clientSecret: process.env.AUTH_FACEBOOK_SECRET }));
	enabledProviders.push({ id: 'facebook', name: 'Facebook' });
}
if (has(process.env.AUTH_GITHUB_ID, process.env.AUTH_GITHUB_SECRET)) {
	providers.push(GitHub({ clientId: process.env.AUTH_GITHUB_ID, clientSecret: process.env.AUTH_GITHUB_SECRET }));
	enabledProviders.push({ id: 'github', name: 'GitHub' });
}

// The administrator password: a way in that needs no application registered with
// Google or GitHub. Wrong guesses are slowed for everyone at once (see local-admin).
const admin = localAdmin();
if (!building && admin.problem) {
	if (process.env.NODE_ENV === 'production') throw new Error(admin.problem);
	console.warn(admin.problem);
}
if (admin.enabled) {
	const attempts = createAttemptLimiter();
	providers.push(
		Credentials({
			id: LOCAL_PROVIDER,
			name: 'Administrator password',
			credentials: { password: { label: 'Password', type: 'password' } },
			authorize: (creds) => {
				if (!attempts.allowed()) return null;
				if (!passwordMatches(creds?.password)) {
					attempts.failed();
					return null;
				}
				attempts.reset();
				return { id: LOCAL_ACCOUNT, name: admin.name };
			}
		})
	);
	enabledProviders.push({ id: LOCAL_PROVIDER, name: 'Administrator password', password: true });
}

if (!building && process.env.NODE_ENV === 'production' && providers.length === 0) {
	throw new Error(
		'Nobody could sign in: set MIRA_ADMIN_PASSWORD (at least 12 characters), or an OAuth provider id and secret'
	);
}
if (
	!building &&
	process.env.NODE_ENV === 'production' &&
	!admin.enabled &&
	!(process.env.MIRA_ADMIN_IDENTITIES ?? '').trim()
) {
	console.warn(
		'No administrator is configured (MIRA_ADMIN_PASSWORD or MIRA_ADMIN_IDENTITIES). Unless an account was made administrator in the admin settings earlier, nobody can open them and closed registration is not enforced.'
	);
}

// Dev-only password-less login, for exercising the full owner/admin flow without an
// OAuth HTTPS callback. Hard-gated to non-production: even if MIRA_DEV_AUTH=1 leaks
// into a production environment the provider is never registered — the gate is code,
// not a comment, because it would otherwise be an unauthenticated-admin backdoor.
const devAuthRequested = process.env.MIRA_DEV_AUTH === '1';
if (devAuthRequested && process.env.NODE_ENV === 'production') {
	console.warn('MIRA_DEV_AUTH is set in production — the password-less dev login is disabled.');
}
if (devAuthRequested && process.env.NODE_ENV !== 'production') {
	providers.push(
		Credentials({
			id: 'dev',
			name: 'Dev login',
			credentials: { username: { label: 'Username', type: 'text' } },
			authorize: (creds) => {
				const username = String(creds?.username ?? '')
					.trim()
					.toLowerCase();
				if (!username) return null;
				return { id: `dev:${username}`, name: username, email: `${username}@dev.local` };
			}
		})
	);
	enabledProviders.push({ id: 'dev', name: 'Dev login', dev: true });
}

/** True only if GitHub confirms `email` is a verified address on the account. Fails closed. */
async function githubEmailVerified(accessToken: string | undefined, email: string | null | undefined) {
	if (!accessToken || !email) return false;
	try {
		const res = await fetch('https://api.github.com/user/emails', {
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: 'application/vnd.github+json',
				'user-agent': 'mira'
			},
			signal: AbortSignal.timeout(5_000)
		});
		if (!res.ok) return false;
		const emails = (await res.json()) as Array<{ email?: string; verified?: boolean }>;
		const wanted = email.trim().toLowerCase();
		return emails.some((entry) => entry.verified === true && entry.email?.trim().toLowerCase() === wanted);
	} catch (cause) {
		console.warn('[auth] GitHub email verification unavailable; treating email as unverified', String(cause));
		return false;
	}
}

export const { handle, signIn, signOut } = SvelteKitAuth({
	// adapter-node constructs request URLs from the configured ORIGIN; hooks also
	// rejects non-canonical production origins before Auth.js sees the request.
	trustHost: true,
	secret: process.env.AUTH_SECRET,
	providers,
	// Our own login UI lives on the home page, not Auth.js's default screen.
	pages: { signIn: '/' },
	session: { strategy: 'jwt' },
	callbacks: {
		signIn: async ({ user, account, profile }) => {
			if (!account) return false;
			// The registration allowlist keys on email, so an unverified provider email
			// must not satisfy it. Google states verification in the ID token; GitHub can
			// report an unverified primary address, so ask its API; Facebook only
			// returns confirmed addresses.
			const emailVerified =
				account.provider === 'google'
					? profile?.email_verified === true
					: account.provider === 'github'
						? await githubEmailVerified(account.access_token, user.email)
						: true;
			return authorizeSignIn({
				provider: account.provider,
				providerAccountId: account.providerAccountId ?? user.id ?? '',
				email: emailVerified ? user.email : null,
				name: user.name,
				image: user.image
			});
		},
		jwt: async ({ token, account }) => {
			// On initial sign-in, resolve our internal user id from the provider identity.
			if (account) {
				const u = await getUserByProvider(account.provider, account.providerAccountId ?? token.sub ?? '');
				if (!u || u.isBlocked) return null;
				token.uid = u.id;
				// A password session carries a mark of the password it was opened with.
				if (account.provider === LOCAL_PROVIDER) token.pg = passwordGeneration();
			}
			// The password was changed or removed since: that session is over.
			if (token.pg !== undefined && token.pg !== passwordGeneration()) return null;
			if (!token.uid) return null;
			// On every request, re-read the user so an admin block/delete takes effect live.
			const u = await getUserById(token.uid as string);
			if (!u || u.isBlocked) return null;
			token.isAdmin = u.isAdmin;
			token.name = u.name;
			token.email = u.email ?? undefined;
			token.picture = u.image ?? undefined;
			return token;
		},
		session: ({ session, token }) => {
			if (token.uid) {
				session.user.id = token.uid as string;
				session.user.isAdmin = Boolean(token.isAdmin);
			}
			return session;
		}
	}
});
