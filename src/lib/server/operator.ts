/**
 * Who runs this copy of Mira and how long it keeps things, as the operator states it.
 *
 * A guest who opens an invitation link is about to hand photos to a server they know
 * nothing about. The sign-in page, the join page and /privacy say who is behind it,
 * in the operator's own words:
 *
 *   MIRA_OPERATOR_NAME     who runs it: a person, a family, a club ("Ana Etxeberria")
 *   MIRA_OPERATOR_CONTACT  how to reach them: an email address or an https:// page
 *   MIRA_RETENTION_NOTE    how long photos are kept ("Albums are deleted a year after the event.")
 *
 * All optional. With none set, the pages say the neutral truth: a private copy, run by
 * whoever sent the link, kept until deleted. Read from the environment on each call so
 * it needs no schema and follows a container restart.
 */
export type Operator = {
	name: string | null;
	/** Shown as text; `href` is set only for an email address or an http(s) page. */
	contact: { text: string; href: string | null } | null;
	retention: string | null;
};

const text = (value: string | undefined, max: number): string | null => {
	const clean = Array.from(value ?? '', (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
	return clean || null;
};

export function operatorInfo(env: Record<string, string | undefined> = process.env): Operator {
	const contact = text(env.MIRA_OPERATOR_CONTACT, 200);
	let href: string | null = null;
	if (contact && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(contact)) href = `mailto:${contact}`;
	else if (contact && /^https?:\/\/[^\s<>"']+$/i.test(contact)) href = contact;
	return {
		name: text(env.MIRA_OPERATOR_NAME, 120),
		contact: contact ? { text: contact, href } : null,
		retention: text(env.MIRA_RETENTION_NOTE, 300)
	};
}
