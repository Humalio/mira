import { describe, expect, it } from 'vitest';
import { boundedInteger, jsonObject, requireContentLength, requiredText, requiredUuid } from './input';

describe('server input validation', () => {
	it('trims bounded required text', () => {
		expect(requiredText('  album  ', 'Name', 10)).toBe('album');
		expect(() => requiredText('   ', 'Name', 10)).toThrow();
		expect(() => requiredText('too long', 'Name', 3)).toThrow();
	});

	it('accepts only canonical UUID identifiers', () => {
		expect(requiredUuid('550e8400-e29b-41d4-a716-446655440000', 'Id')).toBe('550e8400-e29b-41d4-a716-446655440000');
		expect(() => requiredUuid('../media', 'Id')).toThrow();
	});

	it('rejects non-integer and out-of-range numbers', () => {
		expect(boundedInteger('4', 'Limit', 1, 5)).toBe(4);
		expect(() => boundedInteger('4.5', 'Limit', 1, 5)).toThrow();
		expect(() => boundedInteger('-1', 'Limit', 1, 5)).toThrow();
	});

	it('requires an honest bounded Content-Length', () => {
		expect(() => requireContentLength(new Request('http://localhost'), 5)).toThrow();
		expect(() =>
			requireContentLength(new Request('http://localhost', { headers: { 'content-length': '6' } }), 5)
		).toThrow();
		expect(() =>
			requireContentLength(new Request('http://localhost', { headers: { 'content-length': '5' } }), 5)
		).not.toThrow();
	});

	it('accepts objects but rejects arrays and null JSON bodies', () => {
		expect(jsonObject({ ok: true })).toEqual({ ok: true });
		expect(() => jsonObject([])).toThrow();
		expect(() => jsonObject(null)).toThrow();
	});
});
