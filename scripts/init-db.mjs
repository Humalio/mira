import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const schema = (await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const fingerprint = createHash('sha256').update(schema).digest('hex');
const client = postgres(url, { max: 1, connect_timeout: 10 });

// After a host reboot or `docker compose restart` the database container starts at the
// same moment as this one (`depends_on` only orders `compose up`). Wait for it instead
// of dying with a stack trace and leaning on the restart policy.
const NOT_READY = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'CONNECT_TIMEOUT', '57P03']);
async function waitForDatabase() {
	const deadline = Date.now() + 60_000;
	for (;;) {
		try {
			await client`select 1`;
			return;
		} catch (cause) {
			if (!NOT_READY.has(cause?.code) || Date.now() > deadline) throw cause;
			console.log('Waiting for the database to accept connections');
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
}

try {
	await waitForDatabase();
	await client.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtext('mira:initial-schema'))`;
		const [state] = await tx`select to_regclass('public.mira_schema') as marker`;
		if (state.marker) {
			const rows = await tx`select fingerprint from public.mira_schema where id = 1`;
			if (rows.length !== 1 || rows[0].fingerprint !== fingerprint) {
				throw new Error('Database schema differs from this day-zero release. Use a fresh database.');
			}
			console.log('Mira database already initialized');
			return;
		}
		const [existing] = await tx`select exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    ) as occupied`;
		if (existing.occupied) throw new Error('Day-zero setup requires an empty database; existing data was not changed.');
		await tx.unsafe(schema);
		await tx`create table public.mira_schema (
      id integer primary key check (id = 1), fingerprint text not null
    )`;
		await tx`insert into public.mira_schema (id, fingerprint) values (1, ${fingerprint})`;
		console.log('Mira day-zero database initialized');
	});
} finally {
	await client.end();
}
