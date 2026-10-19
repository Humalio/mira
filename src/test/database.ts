import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
	export interface ProvidedContext {
		databaseUrl: string;
		mediaDir: string;
	}
}

/**
 * Global setup for the database tests: a fresh, randomly named database on the server in
 * TEST_DATABASE_URL, initialized from database/schema.sql, plus an empty media folder.
 * Both are removed afterwards. Some of what these tests exercise acts on the whole
 * database (restart recovery, the deletion sweep), so they never run against DATABASE_URL.
 */
export default async function setup(project: TestProject) {
	const server = process.env.TEST_DATABASE_URL;
	if (!server) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL server');
	const name = `mira_test_${randomUUID().replaceAll('-', '')}`;
	const admin = postgres(server, { max: 1, onnotice: () => {} });
	await admin`create database ${admin(name)}`;
	const url = new URL(server);
	url.pathname = `/${name}`;
	const mediaDir = await mkdtemp(join(tmpdir(), 'mira-test-media-'));
	try {
		await promisify(execFile)(process.execPath, ['scripts/init-db.mjs'], {
			env: { ...process.env, DATABASE_URL: url.toString() }
		});
	} catch (error) {
		await admin`drop database ${admin(name)} with (force)`;
		await admin.end();
		throw error;
	}
	project.provide('databaseUrl', url.toString());
	project.provide('mediaDir', mediaDir);
	return async () => {
		try {
			await admin`drop database if exists ${admin(name)} with (force)`;
		} finally {
			await admin.end({ timeout: 5 });
			await rm(mediaDir, { recursive: true, force: true });
		}
	};
}
