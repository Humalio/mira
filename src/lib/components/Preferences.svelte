<script lang="ts">
	import { page } from '$app/state';
	import { translator, LOCALES, localeName, normalizeLocale } from '#lib/i18n/index.js';
	import { THEMES, normalizeTheme } from '#lib/theme/skins.js';

	// Locale, theme and current path come from the page (set server-side via cookies), so
	// the pickers work with no props and reflect the active choice everywhere they render.
	const locale = $derived(normalizeLocale(page.data.locale));
	const theme = $derived(normalizeTheme(page.data.theme));
	const t = $derived(translator(locale));
	const back = $derived(page.url.pathname + page.url.search);
	// Swatches show the canvas each theme gives the page.
	const SWATCH = { light: '#f8f5ef', dark: '#211a26' } as const;
</script>

<div class="prefs">
	<form class="pref" method="POST" action="/set-locale">
		<input type="hidden" name="redirect" value={back} />
		<label class="lbl" for="lang-sel">{t('prefs.language')}</label>
		<select id="lang-sel" name="locale" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
			{#each LOCALES as l (l)}
				<option value={l} selected={l === locale}>{localeName(l)}</option>
			{/each}
		</select>
	</form>
	<form class="pref" method="POST" action="/set-theme">
		<input type="hidden" name="redirect" value={back} />
		<span class="lbl" id="theme-lbl">{t('prefs.theme')}</span>
		<span class="swatches" role="group" aria-labelledby="theme-lbl">
			{#each THEMES as id (id)}
				<button
					class="sw"
					class:on={theme === id}
					name="theme"
					value={id}
					style="background:{SWATCH[id]}"
					aria-label={t(`prefs.theme.${id}`)}
					aria-pressed={theme === id}
					title={t(`prefs.theme.${id}`)}
				></button>
			{/each}
		</span>
	</form>
</div>

<style>
	.prefs {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 10px 20px;
	}
	.pref {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.lbl {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}
	select {
		font: inherit;
		font-size: 13px;
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 4px 8px;
		cursor: pointer;
	}
	.swatches {
		display: inline-flex;
		gap: 8px;
	}
	.sw {
		width: 24px;
		height: 24px;
		padding: 0;
		border-radius: 50%;
		border: 1.5px solid var(--line);
		transition: transform 0.12s;
	}
	.sw.on {
		border-color: var(--ink);
		transform: scale(1.12);
	}
	.sw:focus-visible {
		outline: 3px solid var(--accent-text);
		outline-offset: 3px;
	}
</style>
