import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default defineConfig(
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: { parser: ts.parser, extraFileExtensions: ['.svelte'] }
		}
	},
	{
		// svelte-check already surfaces Svelte compiler warnings (unused CSS, a11y,
		// intentional initial-value $state seeding); keep them as lint warnings rather
		// than hard errors that fail CI on deliberate code.
		rules: {
			'svelte/valid-compile': 'warn',
			'svelte/no-at-html-tags': 'warn',
			// Mira is served from the root of its address (no paths.base), and most of its
			// links carry a query string, point at a download or leave the site (share
			// intents, maps, the operator's contact), which resolve() cannot express.
			// Programmatic navigation (goto) is still checked.
			'svelte/no-navigation-without-resolve': ['error', { ignoreLinks: true }]
		}
	},
	{
		ignores: ['build/', '.svelte-kit/', 'dist/', 'internal/', '.agents/', '.claude/']
	}
);
