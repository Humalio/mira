/**
 * Keeping Tab inside a modal dialog. `aria-modal` tells assistive technology that the page
 * behind is inert, but the browser still tabs into it; the dialog has to wrap round itself.
 */

const TABBABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'summary',
	'audio[controls]',
	'video[controls]',
	'[contenteditable="true"]',
	'[tabindex]'
].join(',');

/** The elements Tab stops at inside `root`, in order. */
export function tabStops(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
		// tabindex="-1": focusable from script, skipped by Tab.
		if (el.tabIndex < 0) return false;
		// Not rendered (display: none, or inside a collapsed block): Tab skips it.
		if (!el.getClientRects().length) return false;
		// A radio group is a single stop: its checked radio, or the first when none is.
		if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
			const group = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
				(r) => r.name === el.name
			);
			return el === (group.find((r) => r.checked) ?? group[0]);
		}
		return true;
	});
}

/**
 * Where Tab (Shift+Tab when `back`) should send focus instead of letting it leave the
 * dialog, or null when the browser's own move stays inside. The dialog itself holds focus
 * when it opens, and Shift+Tab from there would step out backwards, so that wraps too.
 */
export function wrapTarget<T>(stops: readonly T[], active: unknown, dialog: T, back: boolean): T | null {
	if (!stops.length) return dialog;
	const first = stops[0];
	const last = stops[stops.length - 1];
	if (back) return active === first || active === dialog ? last : null;
	return active === last ? first : null;
}
