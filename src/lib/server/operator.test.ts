import { describe, expect, it } from 'vitest';
import { operatorInfo } from './operator';

describe('what the operator says about this copy', () => {
	it('is empty when nothing is set, so the pages fall back to the neutral wording', () => {
		expect(operatorInfo({})).toEqual({ name: null, contact: null, retention: null });
		expect(operatorInfo({ MIRA_OPERATOR_NAME: '   ' }).name).toBeNull();
	});

	it('passes on the name and the retention note as plain text', () => {
		const info = operatorInfo({
			MIRA_OPERATOR_NAME: ' Ana Etxeberria ',
			MIRA_RETENTION_NOTE: 'Albums are deleted\na year after the event.'
		});
		expect(info.name).toBe('Ana Etxeberria');
		expect(info.retention).toBe('Albums are deleted a year after the event.');
		expect(operatorInfo({ MIRA_OPERATOR_NAME: 'x'.repeat(500) }).name).toHaveLength(120);
	});

	it('links an email address or a web page, and nothing else', () => {
		expect(operatorInfo({ MIRA_OPERATOR_CONTACT: 'ana@example.org' }).contact).toEqual({
			text: 'ana@example.org',
			href: 'mailto:ana@example.org'
		});
		expect(operatorInfo({ MIRA_OPERATOR_CONTACT: 'https://example.org/contact' }).contact?.href).toBe(
			'https://example.org/contact'
		);
		// Anything else is shown as written but never becomes a link.
		expect(operatorInfo({ MIRA_OPERATOR_CONTACT: 'javascript:alert(1)' }).contact).toEqual({
			text: 'javascript:alert(1)',
			href: null
		});
		expect(operatorInfo({ MIRA_OPERATOR_CONTACT: 'ask at the bar' }).contact?.href).toBeNull();
	});
});
