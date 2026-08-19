import { handle as authHandle } from './auth';
import { resolveLocale, localeTag } from '#lib/i18n/index.js';
import { normalizeTheme } from '#lib/theme/skins.js';
import { sequence, type Handle, type ServerInit } from '@sveltejs/kit/hooks';
import { randomUUID } from 'node:crypto';
import { building } from '$app/env';
import { UUID_PATTERN } from '#lib/server/input.js';

const COOKIE = 'mira_device';
const LOCALE_COOKIE = 'mira_locale';
const THEME_COOKIE = 'mira_theme';
const ONE_YEAR = 60 * 60 * 24 * 365;
const isProd = process.env.NODE_ENV === 'production';
const configuredOrigin = process.env.ORIGIN;
const canonicalOrigin = (() => {
	if (!isProd || building) return null;
	if (!configuredOrigin) throw new Error('ORIGIN is required in production');
	const parsed = new URL(configuredOrigin);
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/') {
		throw new Error('ORIGIN must be an http(s) origin without credentials or a path');
	}
	return parsed.origin;
})();

/**
 * Guest identity = a stable random token in an httpOnly cookie. No account
 * needed to join an album. Production database initialization run before the server starts.
 */
const miraHandle: Handle = async ({ event, resolve }) => {
	if (canonicalOrigin && event.url.origin !== canonicalOrigin) {
		return new Response('Invalid request origin', { status: 400 });
	}
	let token = event.cookies.get(COOKIE);
	if (!token || !UUID_PATTERN.test(token)) {
		token = randomUUID();
		event.cookies.set(COOKIE, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: isProd,
			maxAge: ONE_YEAR
		});
	}
	event.locals.deviceToken = token;
	// Per-viewer language, chosen via the selector (see /set-locale). Reflected into
	// <html lang> so screen readers and the browser announce the right language.
	event.locals.locale = resolveLocale(event.cookies.get(LOCALE_COOKIE), event.request.headers.get('accept-language'));
	// Light or dark, chosen beside the language (see /set-theme). Rendered into
	// <html data-theme> on the server, so the page is right on first paint.
	event.locals.theme = normalizeTheme(event.cookies.get(THEME_COOKIE));

	const resolved = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('%lang%', localeTag(event.locals.locale)).replace('%theme%', event.locals.theme)
	});
	// Auth.js answers a refused sign-in (wrong password, registration closed) with
	// Response.redirect(), whose headers cannot be changed: setting one threw, and the
	// person saw a 500 page instead of the sign-in screen with its explanation.
	let response = resolved;
	try {
		response.headers.set('x-content-type-options', 'nosniff');
	} catch {
		response = new Response(resolved.body, {
			status: resolved.status,
			statusText: resolved.statusText,
			headers: new Headers(resolved.headers)
		});
		response.headers.set('x-content-type-options', 'nosniff');
	}
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
	response.headers.set('x-frame-options', 'DENY');
	return response;
};

/**
 * Auth.js does not memoize `locals.auth()`: every call re-decodes the JWT and runs
 * the `jwt` callback, which re-reads the user row. Guards call it 2–4× per request
 * (memberFor, isAlbumOwner, layout), so resolve it once per request.
 */
const memoizeAuth: Handle = ({ event, resolve }) => {
	const auth = event.locals.auth;
	let session: ReturnType<typeof auth> | undefined;
	event.locals.auth = () => (session ??= auth());
	return resolve(event);
};

export const handle = sequence(miraHandle, authHandle, memoizeAuth);

/** Background housekeeping runs off the request path (dynamic import keeps $env out of init). */
export const init: ServerInit = async () => {
	if (building) return;
	const { startMaintenance } = await import('#lib/server/maintenance.js');
	try {
		await startMaintenance();
	} catch (cause) {
		console.error('[startup]', cause instanceof Error ? cause.message : cause);
		process.exit(1);
	}
};
