import { redirect } from '@sveltejs/kit';
import { normalizeTheme } from '#lib/theme/skins.js';
import type { RequestHandler } from './$types';
import { LIMITS, requireContentLength } from '#lib/server/input.js';
import { rateLimit, requestAddress } from '#lib/server/rate-limit.js';
import { sameSitePath } from '#lib/server/redirect.js';

const FIVE_YEARS = 60 * 60 * 24 * 365 * 5;

/** Set the viewer's light/dark theme cookie, then return to the page they were on. */
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	rateLimit(`theme:${requestAddress(request, getClientAddress)}`, 30, 60_000);
	requireContentLength(request, LIMITS.formBytes);
	const fd = await request.formData();
	const theme = normalizeTheme(String(fd.get('theme') ?? ''));
	cookies.set('mira_theme', theme, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: FIVE_YEARS
	});

	throw redirect(303, sameSitePath(String(fd.get('redirect') ?? '/')));
};
