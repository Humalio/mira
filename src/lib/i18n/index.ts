// Lightweight, SSR-friendly i18n. Locale catalogs are per-language JSON files in
// ./messages, auto-discovered via glob (translators edit JSON, not code). A catalog
// is only offered to people once its code is listed in ENABLED_LOCALES below. The
// viewer's locale is a per-device cookie, resolved server-side. Pure and dependency-free.
import en from './messages/en.json';

// `eager` bundles every catalog at build time — fine for a handful of locales. For a
// large language set, switch to lazy `import.meta.glob` and load the active one only.
const modules = import.meta.glob('./messages/*.json', { eager: true, import: 'default' }) as Record<
	string,
	Record<string, string>
>;

/** locale code -> message catalog, keyed off the JSON filename (en.json -> "en"). */
export const catalogs: Record<string, Record<string, string>> = {};
for (const [path, msgs] of Object.entries(modules)) {
	const code = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
	catalogs[code] = msgs;
}

export type MessageKey = keyof typeof en;
export const DEFAULT_LOCALE = 'en';
/**
 * Languages people can actually get: the picker lists exactly these, and browser
 * language detection and saved choices only ever resolve to one of them. A catalog
 * that is in the repository but not listed here is kept in key parity by the tests
 * and never served; add its code once its JSON file has been reviewed.
 * See docs/LANGUAGES.md.
 */
const ENABLED_LOCALES = ['en', 'es', 'de', 'fr', 'pt', 'it'];
export const LOCALES = ENABLED_LOCALES.filter((code) => Object.hasOwn(catalogs, code)).sort();

const REGIONS: Record<string, string> = {
	en: 'en-GB',
	es: 'es-ES',
	de: 'de-DE',
	fr: 'fr-FR',
	pt: 'pt-PT',
	it: 'it-IT'
};
const NAMES: Record<string, string> = {
	en: 'English (UK)',
	es: 'Español (España)',
	de: 'Deutsch (Deutschland)',
	fr: 'Français (France)',
	pt: 'Português (Portugal)',
	it: 'Italiano (Italia)'
};
export const isLocale = (v: unknown): boolean => typeof v === 'string' && LOCALES.includes(v);
export const normalizeLocale = (v: string | null | undefined): string => {
	const language = v?.trim().toLowerCase().split('-')[0] ?? '';
	return isLocale(language) ? language : DEFAULT_LOCALE;
};
export const localeTag = (locale: string): string => REGIONS[normalizeLocale(locale)];
export const localeName = (locale: string): string => NAMES[normalizeLocale(locale)];

/** Saved selection wins; otherwise honour the browser's weighted language preferences. */
export function resolveLocale(saved: string | undefined, acceptLanguage: string | null): string {
	if (saved && isLocale(saved.toLowerCase().split('-')[0])) return normalizeLocale(saved);
	const choices = (acceptLanguage ?? '')
		.split(',')
		.map((entry, index) => {
			const [code, ...parameters] = entry.trim().split(';');
			const quality = parameters.find((value) => value.trim().startsWith('q='));
			const weight = quality ? Number(quality.trim().slice(2)) : 1;
			return { code: code.toLowerCase().split('-')[0], weight, index };
		})
		.filter((entry) => Number.isFinite(entry.weight) && entry.weight > 0 && entry.weight <= 1)
		.sort((a, b) => b.weight - a.weight || a.index - b.index);
	return choices.find((entry) => isLocale(entry.code))?.code ?? DEFAULT_LOCALE;
}

/** A translator bound to a locale. Missing keys fall back to English; `{name}`
 *  placeholders are filled from `params`. */
export function translator(locale: string) {
	const dict = catalogs[normalizeLocale(locale)];
	return (key: MessageKey, params?: Record<string, string | number>): string => {
		let s = dict[key] ?? (en as Record<string, string>)[key];
		if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
		return s;
	};
}
