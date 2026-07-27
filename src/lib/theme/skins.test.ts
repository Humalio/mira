import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	BAR_TINT,
	DARK_SKIN,
	DEFAULT_SKIN,
	SKINS,
	TEXT_CONTRAST,
	blend,
	contrastRatio,
	getSkin,
	normalizeTheme,
	readableAccent,
	resolveTokens,
	tokensToStyle
} from './skins';

describe('getSkin', () => {
	it('falls back to the default for anything that is not a skin, built-in object keys included', () => {
		for (const name of ['constructor', '__proto__', 'toString', 'nope', '', null, undefined])
			expect(getSkin(name), String(name)).toBe(SKINS[DEFAULT_SKIN]);
		expect(getSkin('daylight')).toBe(SKINS.daylight);
	});
});

describe('contrastRatio', () => {
	it('matches the WCAG reference values', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
		expect(contrastRatio('#fff', '#ffffff')).toBe(1);
		expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
	});
});

describe('accent as text', () => {
	// Everything a link is drawn on, including the filter bar's accent tint over the page.
	const backgrounds = (id: string, accent = SKINS[id].tokens.accent) => [
		SKINS[id].tokens.bg,
		SKINS[id].tokens.surface,
		SKINS[id].tokens.surface2,
		blend(SKINS[id].tokens.bg, accent, BAR_TINT)
	];

	it('is readable (AA) on every skin with its own accent', () => {
		for (const id of Object.keys(SKINS)) {
			const tokens = resolveTokens(id);
			for (const bg of backgrounds(id)) {
				expect(contrastRatio(tokens.accentText, bg), `${id} on ${bg}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
			}
		}
	});

	it('stays readable whatever accent the owner picks', () => {
		for (const id of Object.keys(SKINS)) {
			for (const accent of ['#ffffff', '#000000', '#ffee00', '#4f8cff', '#ff6b6b', '#deb878', '#123']) {
				const tokens = resolveTokens(id, accent);
				expect(tokens.accent).toBe(accent); // buttons keep the chosen colour
				for (const bg of backgrounds(id, accent)) {
					expect(contrastRatio(tokens.accentText, bg), `${id} ${accent} on ${bg}`).toBeGreaterThanOrEqual(
						TEXT_CONTRAST
					);
				}
			}
		}
	});

	it('leaves an already readable accent alone and falls back to ink for junk', () => {
		expect(readableAccent('#7f0000', '#2a2620', ['#f6f7ec'])).toBe('#7f0000');
		expect(readableAccent('not-a-colour', '#2a2620', ['#f6f7ec'])).toBe('#2a2620');
	});

	it('is serialised for the page and matches the stylesheet default', () => {
		const tokens = resolveTokens('daylight');
		expect(tokensToStyle(tokens)).toContain(`--accent-text:${tokens.accentText}`);
		expect(readFileSync('src/app.css', 'utf8')).toContain(`var(--accent) ${BAR_TINT * 100}%, transparent`);
		// Pages outside an album (home, admin, errors) only have the :root defaults.
		expect(readFileSync('src/app.css', 'utf8')).toContain(`--accent-text: ${tokens.accentText};`);
	});
});

describe('viewer theme', () => {
	it('accepts only light and dark, defaulting to light', () => {
		expect(normalizeTheme('dark')).toBe('dark');
		for (const value of ['light', 'DARK', '', null, undefined, 'auto']) expect(normalizeTheme(value)).toBe('light');
	});

	it('turns the default look dark, keeps an album accent, and leaves chosen skins alone', () => {
		expect(resolveTokens(DEFAULT_SKIN, null, 'dark').bg).toBe(SKINS[DARK_SKIN].tokens.bg);
		expect(resolveTokens(DEFAULT_SKIN, '#4f8cff', 'dark').accent).toBe('#4f8cff');
		expect(resolveTokens('sage', null, 'dark')).toEqual(resolveTokens('sage'));
		expect(resolveTokens(DEFAULT_SKIN, null, 'light')).toEqual(resolveTokens(DEFAULT_SKIN));
	});

	it('matches the stylesheet dark defaults', () => {
		const tokens = resolveTokens(DEFAULT_SKIN, null, 'dark');
		const css = readFileSync('src/app.css', 'utf8');
		const dark = css.slice(css.indexOf(":root[data-theme='dark']"));
		expect(dark).toContain(`--bg: ${tokens.bg};`);
		expect(dark).toContain(`--accent-text: ${tokens.accentText};`);
	});
});
