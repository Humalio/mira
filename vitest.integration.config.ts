import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
	resolve: base.resolve,
	test: {
		environment: 'node',
		include: ['src/**/*.db.test.ts'],
		// A disposable database and media folder for the whole run (src/test/database.ts).
		globalSetup: ['src/test/database.ts'],
		setupFiles: ['src/test/database-env.ts'],
		// The files share that database, and two of the things they exercise act on all of
		// it: restart recovery re-runs every interrupted upload, and the deletion sweep
		// drains every queued deletion. Side by side they would undo each other's set-up.
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 30_000
	}
});
