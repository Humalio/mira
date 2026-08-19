import { redirect } from '@sveltejs/kit';
import { normalizeLocale } from '#lib/i18n/index.js';
import type { RequestHandler } from './$types';
import { LIMITS, requireContentLength } from '#lib/server/input.js';
import { rateLimit, requestAddress } from '#lib/server/rate-limit.js';
import { sameSitePath } from '#lib/server/redirect.js';

const FIVE_YEARS = 60 * 60 * 24 * 365 * 5;

/** Set the viewer's language cookie, then return to the page they were on. */
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	rateLimit(`locale:${requestAddress(request, getClientAddress)}`, 30, 60_000);
	requireContentLength(request, LIMITS.formBytes);
	const fd = await request.formData();
	const locale = normalizeLocale(String(fd.get('locale') ?? ''));
	cookies.set('mira_locale', locale, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: FIVE_YEARS
	});

	throw redirect(303, sameSitePath(String(fd.get('redirect') ?? '/')));
};
