import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The hosting page tells people to save "this" Compose file. It must be the file
// that ships, character for character, or the five-minute install is a lie.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

describe('the hosting page', () => {
	const page = read('site/hosting.html');
	const compose = read('deploy/compose.prod.yaml');

	it('shows exactly the Compose file in the repository', () => {
		const shown = /<pre><code id="compose">([\s\S]*?)<\/code><\/pre>/.exec(page)?.[1];
		expect(shown).toBeDefined();
		const text = shown!.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
		expect(text.trimEnd()).toBe(compose.trimEnd());
	});

	it('documents every setting its own .env example uses', () => {
		for (const name of ['ORIGIN', 'POSTGRES_PASSWORD', 'AUTH_SECRET', 'MIRA_ADMIN_PASSWORD', 'MIRA_OPERATOR_NAME']) {
			expect(compose, name).toContain(`\${${name}`);
			expect(page, name).toContain(name);
		}
		// ...and the three the guide promises to explain.
		for (const name of ['MIRA_IMAGE', 'MIRA_PORT', 'PUBLIC_ORIGIN']) expect(page).toContain(`<code>${name}</code>`);
	});

	// The release workflow publishes the version the Compose file names by default, so the
	// source must not claim another one.
	it('runs the version package.json names', () => {
		const { version } = JSON.parse(read('package.json')) as { version: string };
		expect(/image: \$\{MIRA_IMAGE:-ghcr\.io\/humalio\/mira:([^}]+)\}/.exec(compose)?.[1]).toBe(version);
	});
});
