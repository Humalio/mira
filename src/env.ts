import { defineEnvVars } from '@sveltejs/kit/env';

// The settings SvelteKit hands to application code through $app/env/private and
// $app/env/public. Both are read when the server starts (dynamic), so one image serves
// any installation. Unset values stay undefined; the modules that read them choose the
// default. Other settings (DATABASE_URL, AUTH_*, MIRA_*) are read from process.env by
// modules that also run outside SvelteKit, such as scripts/init-db.mjs and the tests.
export const variables = defineEnvVars({
	PUBLIC_ORIGIN: { public: true, schema: (input) => input },
	MEDIA_DIR: { schema: (input) => input }
});
