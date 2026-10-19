import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { variables } from '../../env';
import { publicOrigin } from './origin';

// `$app/env/public` is read once in the server; here it follows process.env so each
// case can set its own value.
vi.mock('$app/env/public', () => ({
	get PUBLIC_ORIGIN() {
		return process.env.PUBLIC_ORIGIN;
	}
}));

const request = new URL('http://127.0.0.1:5180/a/trip-abc?page=2');

describe('the address written into links that leave the page', () => {
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.PUBLIC_ORIGIN;
		delete process.env.PUBLIC_ORIGIN;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.PUBLIC_ORIGIN;
		else process.env.PUBLIC_ORIGIN = before;
	});

	it("is the request's own when PUBLIC_ORIGIN is not set", () => {
		expect(publicOrigin(request)).toBe('http://127.0.0.1:5180');
		process.env.PUBLIC_ORIGIN = '';
		expect(publicOrigin(request)).toBe('http://127.0.0.1:5180');
	});

	it('is PUBLIC_ORIGIN when the operator set it', () => {
		process.env.PUBLIC_ORIGIN = 'https://photos.example.org';
		expect(publicOrigin(request)).toBe('https://photos.example.org');
		process.env.PUBLIC_ORIGIN = 'https://photos.example.org:8443/';
		expect(publicOrigin(request)).toBe('https://photos.example.org:8443');
	});

	// SvelteKit hides PUBLIC_ names from the private environment; reading it there
	// silently fell back to the request's origin behind a proxy. It must stay a public,
	// start-up (not build-time) setting.
	it('is declared public and read at start-up', () => {
		expect(variables.PUBLIC_ORIGIN).toMatchObject({ public: true });
		expect(variables.PUBLIC_ORIGIN).not.toHaveProperty('static', true);
	});

	it('refuses anything that is not a bare http(s) origin', () => {
		for (const bad of [
			'ftp://photos.example.org',
			'https://user:secret@photos.example.org',
			'https://photos.example.org/mira'
		]) {
			process.env.PUBLIC_ORIGIN = bad;
			expect(() => publicOrigin(request), bad).toThrow(expect.objectContaining({ status: 500 }));
		}
	});
});
