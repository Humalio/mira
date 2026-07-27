import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import { existsSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * @auth/sveltekit 1.11 (the latest release) is written for SvelteKit 2. Two places meet
 * SvelteKit 3 changes, and this rewrites them as the package is compiled:
 * - it imports `base` from `$app/paths`, which SvelteKit 3 removed. Mira has no base path,
 *   so `base` is the empty string it always was.
 * - its signIn and signOut actions send the browser on with `redirect()`, which SvelteKit 3
 *   refuses for another site unless the call allows it. Those redirects go to the sign-in
 *   service or to Auth.js's own pages by design, so they are allowed. Mira's sign-in forms
 *   post to Auth.js's endpoints instead, which answer with a plain Response.
 * Either rewrite fails the build if the package changes under it. Remove this, and the
 * package.json override of its SvelteKit peer range, once @auth/sveltekit supports
 * SvelteKit 3.
 */
function authForSvelteKit3(): Plugin {
	const base = /import \{ base \} from "\$app\/paths";/;
	const redirect = /redirect\(302, ([\w.]+(?:\.toString\(\))?)\)/g;
	return {
		name: 'mira:auth-sveltekit-3',
		enforce: 'pre',
		transform(code, id) {
			// The dev server adds a ?v= query to dependency ids.
			const file = id.split('?')[0];
			if (!file.includes('/node_modules/@auth/sveltekit/dist/')) return;
			let out = code;
			if (file.endsWith('/env.js')) {
				if (!base.test(out)) throw new Error('@auth/sveltekit env.js changed: review the SvelteKit 3 rewrite');
				out = out.replace(base, 'const base = "";');
			}
			if (file.endsWith('/actions.js')) {
				out = out.replace(redirect, 'redirect(302, $1, { external: true })');
				if (out === code) throw new Error('@auth/sveltekit actions.js changed: review the SvelteKit 3 rewrite');
			}
			return out === code ? undefined : { code: out, map: null };
		}
	};
}

export default defineConfig(({ command }) => {
	// The server modules (auth, db, hooks) read process.env directly so they also work
	// outside SvelteKit, and Vite only feeds .env to $env/import.meta.env. Without this
	// `npm run dev` silently ignored DATABASE_URL, AUTH_* and MIRA_DEV_AUTH from .env.
	// Variables already set in the environment win; builds never read .env.
	if (command === 'serve' && existsSync('.env')) process.loadEnvFile('.env');

	return {
		// Emit fonts as same-origin files so font-src 'self' remains sufficient.
		build: { assetsInlineLimit: 0 },
		plugins: [
			authForSvelteKit3(),
			sveltekit({
				preprocess: vitePreprocess(),
				adapter: adapter(),
				csp: {
					mode: 'auto',
					directives: {
						'default-src': ['self'],
						'base-uri': ['self'],
						'frame-ancestors': ['none'],
						// Chromium checks the OAuth redirect after the same-origin form POST.
						'form-action': [
							'self',
							'https://accounts.google.com',
							'https://github.com',
							'https://www.facebook.com',
							'https://facebook.com'
						],
						'object-src': ['none'],
						'img-src': ['self', 'data:', 'blob:'],
						'media-src': ['self', 'blob:'],
						'font-src': ['self'],
						// Components use dynamic style attributes for theme tokens and artwork.
						'style-src': ['self', 'unsafe-inline'],
						'script-src': ['self'],
						'connect-src': ['self'],
						'worker-src': ['self', 'blob:']
					}
				}
			})
		],
		// Pin to 5180 to avoid colliding with Vite's default port (5173).
		server: { host: '127.0.0.1', port: 5180 }
	};
});
