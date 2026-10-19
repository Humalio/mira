import { describe, expect, it } from 'vitest';
import { sameSitePath } from './redirect';

describe('where a form may send someone back to', () => {
	it('keeps a path on this site, with its query and fragment', () => {
		expect(sameSitePath('/')).toBe('/');
		expect(sameSitePath('/a/trip-abc?page=2#top')).toBe('/a/trip-abc?page=2#top');
		expect(sameSitePath('/j/trip-abc?k=abcdefgh2345')).toBe('/j/trip-abc?k=abcdefgh2345');
	});

	it('goes home instead of to another site', () => {
		expect(sameSitePath('https://elsewhere.example/x')).toBe('/');
		expect(sameSitePath('//elsewhere.example')).toBe('/');
		expect(sameSitePath('/\\elsewhere.example')).toBe('/');
		expect(sameSitePath('javascript:alert(1)')).toBe('/');
	});

	it('is not fooled by a path that only becomes "//elsewhere" once normalised', () => {
		expect(sameSitePath('/.//elsewhere.example')).toBe('/');
		expect(sameSitePath('/%2e//elsewhere.example/x')).toBe('/');
		expect(sameSitePath('/..//elsewhere.example')).toBe('/');
		expect(sameSitePath('/.\\/elsewhere.example')).toBe('/');
	});
});
