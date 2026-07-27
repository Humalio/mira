<script lang="ts">
	import { page } from '$app/state';
	import { CircleAlert, SearchX } from '@lucide/svelte';
	import Brand from '#lib/components/Brand.svelte';
	import { translator, normalizeLocale } from '#lib/i18n/index.js';

	// The root layout's data survives a failing child load, so the page is still
	// localized; fall back to English when even that is unavailable.
	const t = $derived(translator(normalizeLocale(page.data.locale)));
	const notFound = $derived(page.status === 404);
	// Kit's stock messages ("Not Found", "Error: 403") add nothing to the title.
	const detail = $derived(
		page.error?.message && !/^(not found|error: \d+|internal error)$/i.test(page.error.message)
			? page.error.message
			: ''
	);
</script>

<svelte:head><title>{page.status} · Mira</title></svelte:head>

<div class="app errpage">
	<Brand />
	<div class="hero">
		<div class="big">
			{#if notFound}<SearchX size={46} strokeWidth={1.5} />{:else}<CircleAlert size={46} strokeWidth={1.5} />{/if}
		</div>
		<h3>{notFound ? t('error.notFound') : t('error.generic')}</h3>
		{#if detail}<p class="detail">{detail}</p>{/if}
		{#if notFound}<p>{t('error.hint')}</p>{/if}
		<a class="homelink" href="/">{t('error.home')}</a>
		<small class="status">{page.status}</small>
	</div>
</div>

<style>
	.errpage {
		padding: 22px 18px 40px;
	}
	.hero {
		padding-top: 60px;
	}
	.detail {
		color: var(--ink);
	}
	.homelink {
		display: inline-block;
		padding: 13px 22px;
		border-radius: 14px;
		background: var(--accent);
		color: var(--accent-ink);
		font-weight: 700;
	}
	.status {
		display: block;
		margin-top: 18px;
		color: var(--muted);
		font-size: 12px;
	}
</style>
