import { describe, expect, it } from 'vitest';
import { createAttemptLimiter, isLocalAdmin, localAdmin, passwordGeneration, passwordMatches } from './local-admin';
import { isConfiguredAdmin } from './users';

// Generated per run: nothing here is a real credential.
const secret = `test-${crypto.randomUUID()}`;
const env = { MIRA_ADMIN_PASSWORD: secret, AUTH_SECRET: 'a'.repeat(40) };

describe('the administrator password', () => {
	it('is off unless a password is set, and off with a short one', () => {
		expect(localAdmin({})).toEqual({ enabled: false, problem: null, name: 'Administrator' });
		const short = localAdmin({ MIRA_ADMIN_PASSWORD: 'tooshort' });
		expect(short.enabled).toBe(false);
		expect(short.problem).toMatch(/at least 12 characters/);
		expect(localAdmin({ ...env, MIRA_ADMIN_NAME: ' Ana ' })).toEqual({ enabled: true, problem: null, name: 'Ana' });
	});

	it('accepts exactly the password and nothing else', () => {
		expect(passwordMatches(secret, env)).toBe(true);
		expect(passwordMatches(`${secret} `, env)).toBe(false);
		expect(passwordMatches(secret.toUpperCase(), env)).toBe(false);
		expect(passwordMatches('', env)).toBe(false);
		expect(passwordMatches(undefined, env)).toBe(false);
		expect(passwordMatches(['x'], env)).toBe(false);
		expect(passwordMatches('x'.repeat(5_000), env)).toBe(false);
	});

	it('never matches when the feature is off', () => {
		expect(passwordMatches('', {})).toBe(false);
		expect(passwordMatches('tooshort', { MIRA_ADMIN_PASSWORD: 'tooshort' })).toBe(false);
	});

	it('ends password sessions when the password changes or is removed', () => {
		const before = passwordGeneration(env);
		expect(before).toHaveLength(16);
		expect(passwordGeneration(env)).toBe(before);
		expect(passwordGeneration({ ...env, MIRA_ADMIN_PASSWORD: `${secret}-changed` })).not.toBe(before);
		expect(passwordGeneration({ ...env, AUTH_SECRET: 'b'.repeat(40) })).not.toBe(before);
		expect(passwordGeneration({ AUTH_SECRET: env.AUTH_SECRET })).toBe('');
	});

	it('makes the password account an administrator only while the password is set', () => {
		expect(isLocalAdmin('password', 'admin', env)).toBe(true);
		expect(isLocalAdmin('password', 'someone', env)).toBe(false);
		expect(isLocalAdmin('google', 'admin', env)).toBe(false);
		expect(isLocalAdmin('password', 'admin', {})).toBe(false);

		const kept = { password: process.env.MIRA_ADMIN_PASSWORD, ids: process.env.MIRA_ADMIN_IDENTITIES };
		try {
			process.env.MIRA_ADMIN_IDENTITIES = '';
			process.env.MIRA_ADMIN_PASSWORD = secret;
			expect(isConfiguredAdmin('password', 'admin')).toBe(true);
			delete process.env.MIRA_ADMIN_PASSWORD;
			expect(isConfiguredAdmin('password', 'admin')).toBe(false);
		} finally {
			if (kept.password === undefined) delete process.env.MIRA_ADMIN_PASSWORD;
			else process.env.MIRA_ADMIN_PASSWORD = kept.password;
			process.env.MIRA_ADMIN_IDENTITIES = kept.ids;
		}
	});
});

describe('guessing is slowed', () => {
	it('refuses everyone after ten wrong tries, then lets them try again', () => {
		const limiter = createAttemptLimiter(10, 5 * 60_000);
		const start = 1_000_000;
		for (let i = 0; i < 10; i++) {
			expect(limiter.allowed(start + i)).toBe(true);
			limiter.failed(start + i);
		}
		expect(limiter.allowed(start + 20)).toBe(false);
		expect(limiter.allowed(start + 4 * 60_000)).toBe(false);
		expect(limiter.allowed(start + 5 * 60_000)).toBe(true);
	});

	it('forgets earlier slips once someone gets it right', () => {
		const limiter = createAttemptLimiter(3, 60_000);
		limiter.failed(0);
		limiter.failed(1);
		limiter.reset();
		limiter.failed(2);
		limiter.failed(3);
		expect(limiter.allowed(4)).toBe(true);
	});
});
