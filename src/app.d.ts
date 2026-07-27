// See https://svelte.dev/docs/kit/types#app.d.ts
import type { DefaultSession } from '@auth/sveltekit';

declare global {
	namespace App {
		interface Error {
			message: string;
			/** Seconds until a rate-limited request may be retried (429 only). */
			retryAfter?: number;
		}
		interface Locals {
			/** Stable per-device identity for guests (no account). Set by hooks.server.ts. */
			deviceToken: string;
			/** Per-viewer UI language ('en' | 'es'). Set by hooks.server.ts. */
			locale: string;
			/** Per-viewer light/dark preference, from the mira_theme cookie. Set by hooks.server.ts. */
			theme: import('#lib/theme/skins.js').Theme;
		}
	}
}

// Add our owner fields to the Auth.js session user.
declare module '@auth/sveltekit' {
	interface Session {
		user: {
			id: string;
			isAdmin: boolean;
		} & DefaultSession['user'];
	}
}

export {};
