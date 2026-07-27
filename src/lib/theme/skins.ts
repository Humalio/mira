/**
 * Thematic skins.
 *
 * A skin is pure data: a set of design tokens mapped onto CSS custom
 * properties. The whole UI reads from these variables, so adding a themed look
 * is one entry in `SKINS` — no component changes. Per album we store
 * `{ skin, accent }`; the resolver merges an optional accent override on top.
 *
 * Design intent: light and neutral. Backgrounds stay quiet so the photos
 * carry the colour; each skin has a single restrained accent for active states.
 * Tokens are serialised to an inline style on the app wrapper during SSR, so the
 * theme is correct on first paint (no flash).
 */

export type SkinTokens = {
	bg: string;
	surface: string;
	surface2: string;
	line: string;
	ink: string;
	muted: string;
	accent: string;
	/** The accent adjusted until it is readable as text on this skin; see `readableAccent`. */
	accentText: string;
	accentInk: string;
	radius: string;
	font: string;
	shadow: string;
	/** Quiet gradient shown on a cover with no photo yet. */
	coverGrad: string;
};

export type Skin = {
	id: string;
	name: string;
	/** `accentText` is derived per album (the owner can pick any accent), never stored. */
	tokens: Omit<SkinTokens, 'accentText'>;
};

const FONT = "'Plus Jakarta Sans Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const DARK_SHADOW = '0 10px 30px rgba(0, 0, 0, 0.40)';

export const SKINS: Record<string, Skin> = {
	// The Shared Frame brand: paper canvas, golden-apricot actions with plum text, a hint of
	// apricot on empty covers. Keeps the id 'daylight' so every album on the default look
	// follows the brand.
	daylight: {
		id: 'daylight',
		name: 'Mira',
		tokens: {
			bg: '#f8f5ef',
			surface: '#fffefb',
			surface2: '#eee6f0',
			line: '#dcd4de',
			ink: '#302833',
			muted: '#716574',
			accent: '#deb878',
			accentInk: '#38243d',
			radius: '16px',
			font: FONT,
			shadow: '0 8px 24px rgba(56, 36, 61, 0.1)',
			coverGrad: 'linear-gradient(160deg, #f6dccd 0%, #eee6f0 45%, #f8f5ef 75%)'
		}
	},
	sand: {
		id: 'sand',
		name: 'Sand',
		tokens: {
			bg: '#f5efe3',
			surface: '#fffdf8',
			surface2: '#efe6d4',
			line: '#e7ddc8',
			ink: '#2c2620',
			muted: '#9a8d76',
			accent: '#deb878',
			accentInk: '#2c2418',
			radius: '16px',
			font: FONT,
			shadow: '0 8px 24px rgba(80, 60, 25, 0.1)',
			coverGrad: 'linear-gradient(160deg, #f1e2bf 0%, #f5efe3 62%)'
		}
	},
	linen: {
		id: 'linen',
		name: 'Linen',
		tokens: {
			bg: '#f6f1ea',
			surface: '#fffdf9',
			surface2: '#efe7da',
			line: '#e7ddcc',
			ink: '#2a241d',
			muted: '#978b78',
			accent: '#bd7a52',
			accentInk: '#ffffff',
			radius: '16px',
			font: FONT,
			shadow: '0 8px 24px rgba(60, 45, 25, 0.12)',
			coverGrad: 'linear-gradient(160deg, #f3e3d6 0%, #f6f1ea 62%)'
		}
	},
	mist: {
		id: 'mist',
		name: 'Mist',
		tokens: {
			bg: '#f1f4f7',
			surface: '#ffffff',
			surface2: '#e8edf2',
			line: '#dde4ec',
			ink: '#1b2128',
			muted: '#7c8794',
			accent: '#5f88ad',
			accentInk: '#ffffff',
			radius: '16px',
			font: FONT,
			shadow: '0 8px 24px rgba(25, 40, 60, 0.10)',
			coverGrad: 'linear-gradient(160deg, #e3ecf5 0%, #f1f4f7 62%)'
		}
	},
	sage: {
		id: 'sage',
		name: 'Sage',
		tokens: {
			bg: '#f2f4f1',
			surface: '#ffffff',
			surface2: '#e8ece6',
			line: '#dde3d9',
			ink: '#1e231d',
			muted: '#82897e',
			accent: '#5e9079',
			accentInk: '#ffffff',
			radius: '16px',
			font: FONT,
			shadow: '0 8px 24px rgba(25, 45, 30, 0.10)',
			coverGrad: 'linear-gradient(160deg, #e4efe7 0%, #f2f4f1 62%)'
		}
	},
	scholar: {
		id: 'scholar',
		name: 'Scholar',
		tokens: {
			bg: '#f6f7ec',
			surface: '#fcfcf2',
			surface2: '#ece4c6',
			line: '#e3dcc0',
			ink: '#2a2620',
			muted: '#6b7d69',
			accent: '#7f0000',
			accentInk: '#f6f7ec',
			radius: '16px',
			font: FONT,
			shadow: '0 8px 24px rgba(70, 30, 20, 0.14)',
			coverGrad: 'linear-gradient(160deg, #efe3c9 0%, #f6f7ec 62%)'
		}
	},
	// The brand's dark roles; also what the default look becomes for a viewer who picks Dark.
	plum: {
		id: 'plum',
		name: 'Plum',
		tokens: {
			bg: '#211a26',
			surface: '#302636',
			surface2: '#423448',
			line: '#57445e',
			ink: '#f8f5ef',
			muted: '#c3b9c7',
			accent: '#deb878',
			accentInk: '#38243d',
			radius: '16px',
			font: FONT,
			shadow: DARK_SHADOW,
			coverGrad: 'linear-gradient(160deg, #3a2a40 0%, #211a26 62%)'
		}
	},
	ink: {
		id: 'ink',
		name: 'Ink',
		tokens: {
			bg: '#17181c',
			surface: '#1e2025',
			surface2: '#25272d',
			line: '#2f323a',
			ink: '#ececef',
			muted: '#9a9ca4',
			accent: '#9aa8e0',
			accentInk: '#0d1020',
			radius: '16px',
			font: FONT,
			shadow: DARK_SHADOW,
			coverGrad: 'linear-gradient(160deg, #23262e 0%, #17181c 62%)'
		}
	}
};

export const DEFAULT_SKIN = 'daylight';
/** The default look's dark counterpart, used when the viewer picks the dark theme. */
export const DARK_SKIN = 'plum';

/** The viewer's own light/dark preference (a cookie), separate from an album's skin. */
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export function normalizeTheme(value: string | null | undefined): Theme {
	return value === 'dark' ? 'dark' : 'light';
}

export function getSkin(skinId: string | null | undefined): Skin {
	// Own keys only: "constructor" or "__proto__" must not pass for a skin.
	return skinId && Object.hasOwn(SKINS, skinId) ? SKINS[skinId] : SKINS[DEFAULT_SKIN];
}

const channels = (hex: string): [number, number, number] | null => {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
	return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};

/** WCAG 2 relative luminance of an sRGB colour. */
function luminance(rgb: [number, number, number]): number {
	const [r, g, b] = rgb.map((v) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two hex colours (1 when either is not a hex colour). */
export function contrastRatio(a: string, b: string): number {
	const ca = channels(a);
	const cb = channels(b);
	if (!ca || !cb) return 1;
	const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal-size text. */
export const TEXT_CONTRAST = 4.5;

/**
 * The accent as a TEXT colour. Accents are chosen to fill buttons (pale sand on the
 * default skin, or anything the owner picks), which is often unreadable as a link on
 * the page background. Blend it towards the skin's ink, a little at a time, until it
 * clears AA against every given background; the hue stays recognisable.
 */
export function readableAccent(accent: string, ink: string, backgrounds: string[]): string {
	const from = channels(accent);
	if (!from || !channels(ink)) return ink;
	for (let step = 0; step <= 20; step++) {
		const mixed = blend(accent, ink, step / 20);
		if (backgrounds.every((bg) => contrastRatio(mixed, bg) >= TEXT_CONTRAST)) return mixed;
	}
	return ink;
}

/** `amount` of `b` laid over `a` (0 = all a, 1 = all b), as a hex colour. */
export function blend(a: string, b: string, amount: number): string {
	const from = channels(a);
	const to = channels(b);
	if (!from || !to) return a;
	return (
		'#' +
		from
			.map((v, i) =>
				Math.round(v + (to[i] - v) * amount)
					.toString(16)
					.padStart(2, '0')
			)
			.join('')
	);
}

/** Share of accent in the filter bar's tint; keep in step with `.filterbar` in app.css. */
export const BAR_TINT = 0.08;

/**
 * Merge a per-album accent override onto a skin's tokens. An album on the default look
 * follows the viewer's theme; a skin the owner picked on purpose stays as chosen.
 */
export function resolveTokens(
	skinId: string | null | undefined,
	accent?: string | null,
	theme: Theme = 'light'
): SkinTokens {
	const skin = getSkin(skinId);
	const base = (theme === 'dark' && skin.id === DEFAULT_SKIN ? SKINS[DARK_SKIN] : skin).tokens;
	const chosen = accent || base.accent;
	return {
		...base,
		accent: chosen,
		// Links sit on the page, on cards, on inset panels and on the tinted filter bar.
		accentText: readableAccent(chosen, base.ink, [
			base.bg,
			base.surface,
			base.surface2,
			blend(base.bg, chosen, BAR_TINT)
		])
	};
}

const CSS_VAR: Record<keyof SkinTokens, string> = {
	bg: '--bg',
	surface: '--surface',
	surface2: '--surface-2',
	line: '--line',
	ink: '--ink',
	muted: '--muted',
	accent: '--accent',
	accentText: '--accent-text',
	accentInk: '--accent-ink',
	radius: '--radius',
	font: '--font',
	shadow: '--shadow',
	coverGrad: '--cover-grad'
};

/** Serialize tokens to an inline `style` string for SSR (no theme flash). */
export function tokensToStyle(tokens: SkinTokens): string {
	return (Object.keys(tokens) as (keyof SkinTokens)[]).map((k) => `${CSS_VAR[k]}:${tokens[k]}`).join(';');
}

/** Lightweight list for the skin picker UI. */
export const SKIN_LIST = Object.values(SKINS).map((s) => ({
	id: s.id,
	name: s.name,
	accent: s.tokens.accent,
	bg: s.tokens.bg
}));
