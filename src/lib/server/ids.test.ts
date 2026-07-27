import { describe, it, expect } from 'vitest';
import { memberScopedId, slugify, shortId } from './ids';
import { UUID_PATTERN } from './input';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SUFFIX = new RegExp(`-[${ALPHABET}]{12}$`);

describe('slugify', () => {
	it('lowercases, strips diacritics, and hyphenates', () => {
		expect(slugify('Costa Bravá 2026')).toMatch(/^costa-brava-2026-/);
	});

	it('appends a 12-char suffix from the safe alphabet', () => {
		expect(slugify('Trip')).toMatch(SUFFIX);
	});

	it('falls back to "album" when the name has no usable characters', () => {
		expect(slugify('  !!!  ')).toMatch(/^album-/);
	});

	it('caps the readable base at 24 chars', () => {
		const base = slugify('a'.repeat(50)).replace(SUFFIX, '');
		expect(base.length).toBe(24);
	});
});

describe('shortId', () => {
	it('is the requested length', () => {
		expect(shortId()).toHaveLength(6);
		expect(shortId(12)).toHaveLength(12);
	});

	it('uses only the unambiguous alphabet (no 0/o/1/l)', () => {
		expect([...shortId(200)].every((c) => ALPHABET.includes(c))).toBe(true);
	});
});

describe('memberScopedId', () => {
	const key = '0b0e5a52-6f0c-4c0e-9a3f-2d1c7b8e9f10';
	const marta = '11111111-1111-4111-8111-111111111111';
	const iker = '22222222-2222-4222-8222-222222222222';

	it('is a valid id, and the same one every time a member retries with the same key', () => {
		const id = memberScopedId(marta, key);
		expect(id).toMatch(UUID_PATTERN);
		expect(memberScopedId(marta, key)).toBe(id);
		expect(memberScopedId(marta, key.toUpperCase())).toBe(id);
	});

	it('never is the key itself, and differs for every other member', () => {
		// The key is whatever the browser sent, possibly somebody else's id: it must not
		// come out as an id that addresses their media.
		expect(memberScopedId(marta, key)).not.toBe(key);
		expect(memberScopedId(marta, iker)).not.toBe(iker);
		expect(memberScopedId(iker, key)).not.toBe(memberScopedId(marta, key));
	});
});
