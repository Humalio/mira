import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Standalone from vite.config.ts. Tests import pure helpers directly, so they don't
// need the SvelteKit plugin. `#lib` resolves through package.json "imports"; the
// SvelteKit virtual modules some server helpers import ($app/env and the variables
// declared in src/env.ts) get test stand-ins. The more specific names come first.
const stub = (file: string) => fileURLToPath(new URL(`./src/test/${file}`, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: '$app/env/private', replacement: stub('app-env-private.ts') },
			{ find: '$app/env/public', replacement: stub('app-env-public.ts') },
			{ find: /^\$app\/env$/, replacement: stub('app-env.ts') }
		]
	},
	test: {
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,ts}'],
		// Database tests (*.db.test.ts) need PostgreSQL: npm run test:integration.
		exclude: ['src/**/*.db.test.ts', 'node_modules/**']
	}
});
