import { inject } from 'vitest';

// Runs in each database test file before its imports: the application's database and
// media modules read these at import time, so they see only the disposable copies.
process.env.DATABASE_URL = inject('databaseUrl');
process.env.MEDIA_DIR = inject('mediaDir');
