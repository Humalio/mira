// Starts the production server in build/, taking ORIGIN at start-up.
//
// adapter-node 6 no longer reads ORIGIN: it takes the address from the build or from each
// request's Host header, with https assumed. One image serves whatever address its operator
// gives it, so when ORIGIN is set every request reaches SvelteKit as if it arrived at that
// address, whatever Host or forwarded headers the client sent. Form posts are checked
// against it (CSRF), and sign-in callbacks, cookies and redirects follow it. Production
// requires ORIGIN (src/hooks.server.ts refuses to start without it).
import { subscribe } from 'node:diagnostics_channel';

const PROTOCOL = 'x-mira-origin-protocol';
const HOST = 'x-mira-origin-host';

if (process.env.ORIGIN) {
	let origin;
	try {
		origin = new URL(process.env.ORIGIN);
	} catch {
		throw new Error(`ORIGIN is not an address: ${process.env.ORIGIN} (expected e.g. https://photos.example.org)`);
	}
	if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/') {
		throw new Error('ORIGIN must be an http(s) origin without credentials or a path');
	}
	const protocol = origin.protocol.slice(0, -1);
	process.env.PROTOCOL_HEADER = PROTOCOL;
	process.env.HOST_HEADER = HOST;
	delete process.env.PORT_HEADER;
	// Published for every request before the server's 'request' event, so these headers are
	// in place before adapter-node reads them; a client's own copies are overwritten.
	subscribe('http.server.request.start', ({ request }) => {
		request.headers[PROTOCOL] = protocol;
		request.headers[HOST] = origin.host;
	});
}

await import('../build/index.js');
