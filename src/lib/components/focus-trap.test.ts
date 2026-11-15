import { describe, expect, it } from 'vitest';
import { wrapTarget } from './focus-trap';

describe('wrapTarget', () => {
	const dialog = 'dialog';
	const stops = ['name', 'save', 'cancel'];

	it('wraps Tab from the last stop to the first, and Shift+Tab from the first to the last', () => {
		expect(wrapTarget(stops, 'cancel', dialog, false)).toBe('name');
		expect(wrapTarget(stops, 'name', dialog, true)).toBe('cancel');
	});

	it('lets the browser move between the stops inside', () => {
		expect(wrapTarget(stops, 'name', dialog, false)).toBeNull();
		expect(wrapTarget(stops, 'save', dialog, false)).toBeNull();
		expect(wrapTarget(stops, 'save', dialog, true)).toBeNull();
		expect(wrapTarget(stops, 'cancel', dialog, true)).toBeNull();
	});

	it('steps back from the dialog itself to the last stop, and forward as usual', () => {
		expect(wrapTarget(stops, dialog, dialog, true)).toBe('cancel');
		expect(wrapTarget(stops, dialog, dialog, false)).toBeNull();
	});

	it('keeps focus on a dialog with nothing to tab to', () => {
		expect(wrapTarget([], dialog, dialog, false)).toBe(dialog);
		expect(wrapTarget([], dialog, dialog, true)).toBe(dialog);
	});
});
