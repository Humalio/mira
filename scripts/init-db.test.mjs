import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const run = promisify(execFile);
// Deliberately require an explicit test server; never fall back to DATABASE_URL. Each check
// creates (and drops) its own randomly named database on it.
const serverUrl = process.env.TEST_DATABASE_URL;
if (!serverUrl) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL server');
test('day-zero setup serializes first boot, preserves data on restart, and refuses incompatible databases', async () => {
	const admin = postgres(serverUrl, { max: 1 });
	const names = [];
	const clients = [];
	async function database() {
		const name = `mira_setup_${randomUUID().replaceAll('-', '')}`;
		await admin`create database ${admin(name)}`;
		names.push(name);
		const url = new URL(serverUrl);
		url.pathname = `/${name}`;
		const db = postgres(url.toString(), { max: 1 });
		clients.push(db);
		const init = () =>
			run(process.execPath, ['scripts/init-db.mjs'], {
				env: { ...process.env, DATABASE_URL: url.toString() }
			});
		return { db, init };
	}
	try {
		const fresh = await database();
		await Promise.all([fresh.init(), fresh.init()]);
		await fresh.db`insert into public.app_settings (id, registration_mode) values (1, 'closed')`;
		await fresh.init();
		assert.equal((await fresh.db`select registration_mode from public.app_settings`)[0].registration_mode, 'closed');
		await fresh.db`update public.mira_schema set fingerprint = 'different'`;
		await assert.rejects(fresh.init(), /schema differs/);
		assert.equal((await fresh.db`select registration_mode from public.app_settings`)[0].registration_mode, 'closed');
		const occupied = await database();
		await occupied.db`create table public.keep_me (value text)`;
		await occupied.db`insert into public.keep_me values ('untouched')`;
		await assert.rejects(occupied.init(), /requires an empty database/);
		assert.equal((await occupied.db`select value from public.keep_me`)[0].value, 'untouched');
		assert.equal((await occupied.db`select to_regclass('public.users') as users`)[0].users, null);
	} finally {
		await Promise.all(clients.map((db) => db.end()));
		for (const name of names) await admin`drop database ${admin(name)}`;
		await admin.end();
	}
});
