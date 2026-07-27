import { describe, expect, it } from 'vitest';
import { distinctNames, nameKey } from './names';

describe('nameKey', () => {
	it('ignores case and spacing', () => {
		expect(nameKey('  Zoe ')).toBe(nameKey('ZOE'));
		expect(nameKey('Ana  María')).toBe(nameKey('ana maría'));
		expect(nameKey('Zoe')).not.toBe(nameKey('Zoë'));
	});
});

describe('distinctNames', () => {
	const labels = (names: string[]) => [...distinctNames(names.map((name, i) => ({ id: String(i), name }))).values()];

	it('leaves unique names untouched', () => {
		expect(labels(['Zoe', 'Bruno', 'Ana'])).toEqual(['Zoe', 'Bruno', 'Ana']);
	});

	it('numbers later members who share a name, in joining order', () => {
		expect(labels(['Zoe', 'Bruno', 'zoe', 'ZOE '])).toEqual(['Zoe', 'Bruno', 'zoe (2)', 'ZOE (3)']);
	});

	it('never produces two identical labels', () => {
		const out = labels(['Zoe', 'Zoe (2)', 'Zoe', 'Zoe', 'zoe (3)']);
		expect(new Set(out.map(nameKey)).size).toBe(out.length);
		expect(out[2]).toBe('Zoe (3)');
	});
});
