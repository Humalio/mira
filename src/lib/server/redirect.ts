/**
 * Where a form may send someone back to on this site: the path it asked for, or the
 * home page when that is anything else.
 *
 * Parsing as a URL catches the obvious (`https://elsewhere`, `//elsewhere`) and the
 * backslash variants a prefix check misses. It is not enough alone: `/.//elsewhere` and
 * `/%2e//elsewhere` are same-origin to the parser, but their normalised path is
 * `//elsewhere`, which a browser reads in a `Location` header as another site. So the
 * result must also be a plain single-slash path.
 */
export function sameSitePath(target: string): string {
	const base = new URL('http://mira.invalid');
	let url: URL;
	try {
		url = new URL(target, base);
	} catch {
		return '/';
	}
	if (url.origin !== base.origin) return '/';
	const path = `${url.pathname}${url.search}${url.hash}`;
	return path.startsWith('/') && !path.startsWith('//') ? path : '/';
}
