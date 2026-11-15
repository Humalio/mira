import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The schema's SQL without comments, with every run of whitespace made one space. Quoted
 * text ('values' and "names") is kept exactly as written: inside quotes a space or a "--"
 * is part of the value. Function bodies between $$ are read the same way, which is right
 * for the PL/pgSQL functions in schema.sql.
 */
export function normalizeSchema(sql) {
	const words = [];
	let word = '';
	const gap = () => {
		if (word) words.push(word);
		word = '';
	};
	let i = 0;
	while (i < sql.length) {
		if (/\s/.test(sql[i])) {
			gap();
			i++;
		} else if (sql.startsWith('--', i)) {
			gap();
			const end = sql.indexOf('\n', i);
			i = end < 0 ? sql.length : end;
		} else if (sql.startsWith('/*', i)) {
			gap();
			// Block comments nest in PostgreSQL.
			let depth = 0;
			do {
				const step = sql.startsWith('/*', i) ? 1 : sql.startsWith('*/', i) ? -1 : 0;
				depth += step;
				i += step ? 2 : 1;
			} while (depth > 0 && i < sql.length);
		} else if (sql[i] === "'" || sql[i] === '"') {
			// Up to the closing quote; a doubled quote inside is the quote character itself.
			const quote = sql[i];
			let end = i + 1;
			while (end < sql.length && !(sql[end] === quote && sql[end + 1] !== quote)) {
				end += sql[end] === quote ? 2 : 1;
			}
			word += sql.slice(i, end + 1);
			i = end + 1;
		} else {
			word += sql[i];
			i++;
		}
	}
	gap();
	return words.join(' ');
}

/**
 * What init-db stores to recognise the schema it set up. `current` ignores comments and
 * layout, so rewording a comment or re-indenting a line in schema.sql does not make every
 * existing installation refuse to start. `legacy` is how earlier versions hashed the
 * file (its exact text), kept so the databases they set up are still recognised.
 */
export function schemaFingerprints(sql) {
	const text = sql.replaceAll('\r\n', '\n');
	return { current: sha256(normalizeSchema(text)), legacy: sha256(text) };
}
