import { describe, it, expect } from 'vitest';
import { isAllowlisted } from './users';

describe('isAllowlisted', () => {
	it('matches an exact email address', () => {
		expect(isAllowlisted('a@b.com', 'a@b.com')).toBe(true);
		expect(isAllowlisted('x@b.com', 'a@b.com')).toBe(false);
	});

	it('matches an @domain entry', () => {
		expect(isAllowlisted('anyone@corp.com', '@corp.com')).toBe(true);
		expect(isAllowlisted('anyone@other.com', '@corp.com')).toBe(false);
	});

	it('is case- and whitespace-insensitive', () => {
		expect(isAllowlisted('  A@B.COM ', 'a@b.com')).toBe(true);
	});

	it('parses a multi-entry list (commas / newlines / spaces)', () => {
		expect(isAllowlisted('a@b.com', 'c@d.com, @corp.com\n a@b.com')).toBe(true);
	});

	it('rejects a null/empty email or an empty allowlist', () => {
		expect(isAllowlisted(null, '@corp.com')).toBe(false);
		expect(isAllowlisted('', '@corp.com')).toBe(false);
		expect(isAllowlisted('a@b.com', '')).toBe(false);
	});
});
