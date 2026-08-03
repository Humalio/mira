import { describe, expect, it } from 'vitest';
import { parseIso6709, validPlace } from './place';

describe('where an item was taken', () => {
	it('reads the location tag phones write into videos', () => {
		expect(parseIso6709('+43.3183-001.9812/')).toEqual({ lat: 43.3183, lon: -1.9812 });
		expect(parseIso6709('-33.8688+151.2093+012.300/')).toEqual({ lat: -33.8688, lon: 151.2093 });
		expect(parseIso6709('')).toBeNull();
		expect(parseIso6709('2026-08-01T10:00:00Z')).toBeNull();
	});
	it('rejects coordinates that cannot be a place', () => {
		expect(validPlace(43.3, -1.98)).toEqual({ lat: 43.3, lon: -1.98 });
		expect(validPlace(0, 0)).toBeNull(); // what a camera writes when it has no fix
		expect(validPlace(91, 10)).toBeNull();
		expect(validPlace(10, 181)).toBeNull();
		expect(validPlace(undefined, 3)).toBeNull();
		expect(validPlace(Number.NaN, 3)).toBeNull();
	});
});
