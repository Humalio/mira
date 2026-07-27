import { describe, expect, it } from 'vitest';
import { formatBytes } from './format';

describe('formatBytes', () => {
	it('reads like the sizes people quote', () => {
		expect(formatBytes(300, 'en')).toBe('1 KB');
		expect(formatBytes(640 * 1024, 'en')).toBe('640 KB');
		expect(formatBytes(42.1 * 1024 * 1024, 'en')).toBe('42.1 MB');
		expect(formatBytes(982 * 1024 * 1024, 'en')).toBe('982 MB');
		expect(formatBytes(1.03 * 1024 ** 3, 'en')).toBe('1.03 GB');
	});
	it('uses the viewer’s decimal separator', () => {
		expect(formatBytes(1.03 * 1024 ** 3, 'es')).toBe('1,03 GB');
	});
});
