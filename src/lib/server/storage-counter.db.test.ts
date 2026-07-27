import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

// Database test for the used_bytes triggers (initial schema), run by
// npm run test:integration against a disposable, freshly initialized database.
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

class Rollback extends Error {}

/** Run `body` in a transaction that is always rolled back, so the test leaves no rows. */
async function inRollback(body: (tx: postgres.TransactionSql) => Promise<void>) {
	await sql
		.begin(async (tx) => {
			await body(tx);
			throw new Rollback();
		})
		.catch((cause) => {
			if (!(cause instanceof Rollback)) throw cause;
		});
}

const used = async (tx: postgres.TransactionSql, id: string) =>
	Number((await tx`select used_bytes from users where id = ${id}`)[0]?.used_bytes);

describe('users.used_bytes triggers', () => {
	afterAll(async () => {
		await sql.end();
	});

	it('tracks inserts, deletes and cascades exactly', async () => {
		await inRollback(async (tx) => {
			const u = `t-${crypto.randomUUID()}`;
			await tx`insert into users (id, provider, provider_account_id) values (${u}, 'test', ${u})`;
			for (const a of ['a', 'b']) {
				await tx`insert into albums (id, slug, name, owner_user_id) values (${u + a}, ${u + a}, 'A', ${u})`;
				await tx`insert into moments (id, album_id, name, position) values (${u + a + 'm'}, ${u + a}, 'M', 0)`;
				await tx`insert into members (id, album_id, device_token, display_name) values (${u + a + 'e'}, ${u + a}, ${u + a}, 'x')`;
			}
			const add = (id: string, a: string, bytes: number) =>
				tx`insert into photos (id, album_id, moment_id, member_id, storage_key, thumb_key, mime, size_bytes)
				   values (${u + id}, ${u + a}, ${u + a + 'm'}, ${u + a + 'e'}, 'k', 't', 'image/jpeg', ${bytes})`;
			await add('1', 'a', 100);
			await add('2', 'a', 50);
			await add('3', 'b', 7);
			expect(await used(tx, u)).toBe(157);

			await tx`delete from photos where id = ${u + '1'}`;
			expect(await used(tx, u)).toBe(57);

			await tx`delete from moments where id = ${u + 'am'}`; // cascades photo 2
			expect(await used(tx, u)).toBe(7);

			await tx`delete from albums where id = ${u + 'b'}`; // cascades photo 3 once, not twice
			expect(await used(tx, u)).toBe(0);
		});
	});
});
