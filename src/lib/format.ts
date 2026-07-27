import { localeTag } from '#lib/i18n/index.js';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/**
 * A file size a person can read at a glance, in the viewer's number format:
 * "640 KB", "42.1 MB", "982 MB", "1.03 GB" (or "1,03 GB" in Spanish).
 */
export function formatBytes(bytes: number, locale: string): string {
	const number = (value: number, digits: number) =>
		new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: digits }).format(value);
	if (bytes >= GB) return `${number(bytes / GB, 2)} GB`;
	if (bytes >= 100 * MB) return `${number(bytes / MB, 0)} MB`;
	if (bytes >= MB) return `${number(bytes / MB, 1)} MB`;
	return `${number(Math.max(1, bytes / KB), 0)} KB`;
}
