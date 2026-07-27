<script lang="ts">
	import { page } from '$app/state';
	import { translator, normalizeLocale } from '#lib/i18n/index.js';

	// Who runs this copy and how long photos are kept, said before anyone signs in or
	// joins. The operator's own words when they set them (see #lib/server/operator),
	// otherwise the neutral truth.
	const t = $derived(translator(normalizeLocale(page.data.locale)));
	const operator = $derived(page.data.operator);
</script>

<p class="opnote">
	{operator?.name ? t('op.runBy', { name: operator.name }) : t('op.runByUnknown')}
	{operator?.retention ?? t('op.keptDefault')}
	<a href="/privacy">{t('op.privacyLink')}</a>
</p>

<style>
	.opnote {
		margin: 14px auto 0;
		max-width: 420px;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--muted);
		text-align: center;
	}
	.opnote a {
		color: var(--accent-text, inherit);
		font-weight: 600;
		white-space: nowrap;
	}
</style>
