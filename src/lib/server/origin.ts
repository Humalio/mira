import { PUBLIC_ORIGIN } from '$app/env/public';
import { error } from '@sveltejs/kit';

/**
 * The address people outside reach this server at, for anything that leaves the page:
 * invitation links, QR codes and link previews. `PUBLIC_ORIGIN` when the operator set
 * it (behind a proxy the request's own origin may be an internal one), else the
 * request's.
 *
 * Declared public in src/env.ts and read from `$app/env/public`, at start-up rather
 * than build time, so one image serves any address.
 */
export function publicOrigin(url: URL): string {
	const configured = PUBLIC_ORIGIN;
	if (!configured) return url.origin;
	const parsed = new URL(configured);
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/') {
		throw error(500, 'PUBLIC_ORIGIN must be an http(s) origin without credentials or a path');
	}
	return parsed.origin;
}
