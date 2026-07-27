import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// DATABASE_URL is read from process.env so this infrastructure module remains
// usable by the standalone initialization process as well as the SvelteKit server.
const url = process.env.DATABASE_URL ?? 'postgres://mira:mira@localhost:5432/mira';

/** Shared Drizzle client; connects on first use. Importing this module has no side effects. */
let sqlClient: ReturnType<typeof postgres> | null = null;
let database: PostgresJsDatabase<typeof schema> | null = null;

function getDatabase(): PostgresJsDatabase<typeof schema> {
	if (!database) {
		sqlClient = postgres(url, {
			max: 10,
			connect_timeout: 10,
			idle_timeout: 20,
			connection: {
				statement_timeout: 15_000,
				lock_timeout: 5_000,
				idle_in_transaction_session_timeout: 15_000
			}
		});
		database = drizzle(sqlClient, { schema });
	}
	return database;
}

/** Lazy proxy: importing this module does NOT connect; first property access does. */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
	get(_target, prop) {
		const target = getDatabase();
		const value = target[prop as keyof PostgresJsDatabase<typeof schema>];
		return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
	}
});
export { schema };
