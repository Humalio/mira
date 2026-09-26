import { describe, it, expect } from 'vitest';
import { translator, normalizeLocale, LOCALES, catalogs, resolveLocale, localeTag } from './index';
import en from './messages/en.json';

describe('normalizeLocale', () => {
	it('accepts supported locales and falls back to en', () => {
		expect(normalizeLocale('es')).toBe('es');
		expect(normalizeLocale('en')).toBe('en');
		expect(normalizeLocale('es-MX')).toBe('es');
		expect(normalizeLocale(null)).toBe('en');
	});
});

describe('translator', () => {
	it('returns strings in the requested locale', () => {
		expect(translator('es')('create.submit')).toBe('Crear álbum');
		expect(translator('en')('create.submit')).toBe('Create album');
	});

	it('interpolates {name} params', () => {
		expect(translator('en')('signin.continue', { provider: 'Google' })).toBe('Continue with Google');
	});

	it('falls back to English for an unknown locale', () => {
		expect(translator('unsupported')('prefs.language')).toBe('Language');
	});
});

describe('message catalogs', () => {
	it('every locale covers exactly the en keys (no missing/extra translations)', () => {
		const enKeys = Object.keys(en).sort();
		// Every catalog in the repository, enabled or not: a switched-off language must
		// stay complete so it can be enabled after review without a catch-up pass.
		expect(Object.keys(catalogs).sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'pt']);
		for (const loc of Object.keys(catalogs)) {
			expect(Object.keys(catalogs[loc]).sort()).toEqual(enKeys);
		}
	});

	it('offers every catalog in the repository', () => {
		expect(LOCALES).toEqual(['de', 'en', 'es', 'fr', 'it', 'pt']);
		expect(normalizeLocale('de-AT')).toBe('de');
		expect(translator('pt')('create.submit')).not.toBe('Create album');
		expect(resolveLocale('fr', 'fr-FR,es;q=0.8')).toBe('fr');
		expect(resolveLocale(undefined, 'it-IT')).toBe('it');
		// A language with no catalog falls back to English, never to a guess.
		expect(normalizeLocale('ja')).toBe('en');
	});
});

describe('browser language negotiation', () => {
	it('honours saved choices and weighted browser preferences', () => {
		expect(resolveLocale('es', 'de-DE')).toBe('es');
		expect(resolveLocale(undefined, 'ja;q=1,es-AR;q=0.9,en;q=0.5')).toBe('es');
		expect(resolveLocale(undefined, 'ja,de;q=0.9,es;q=0.5,en;q=0.4')).toBe('de');
		expect(resolveLocale(undefined, 'es;q=0,en-GB;q=0.5')).toBe('en');
		expect(resolveLocale(undefined, 'ja')).toBe('en');
		expect(localeTag('es')).toBe('es-ES');
		expect(localeTag('pt')).toBe('pt-PT');
		expect(localeTag('ja')).toBe('en-GB');
	});
	it('preserves interpolation placeholders in every catalog', () => {
		for (const catalog of Object.values(catalogs)) {
			for (const [key, value] of Object.entries(en)) {
				expect((catalog[key].match(/\{\w+\}/g) ?? []).sort()).toEqual((value.match(/\{\w+\}/g) ?? []).sort());
			}
		}
	});
});
