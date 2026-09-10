<script lang="ts">
	import Brand from '#lib/components/Brand.svelte';
	import Preferences from '#lib/components/Preferences.svelte';
	import { translator } from '#lib/i18n/index.js';

	let { data, form } = $props();
	const t = $derived(translator(data.locale));
	const usable = $derived(data.valid && !form?.gone);
</script>

<svelte:head>
	<title>Mira</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="app" style={data.valid ? data.themeStyle : ''}>
	<div class="wrap">
		<Brand />
		{#if usable && data.valid}
			<h2>{t('return.title', { album: data.albumName, name: data.memberName })}</h2>
			<p class="tagline">{t('return.body', { name: data.memberName })}</p>
			<form method="POST">
				<button class="primary" type="submit">{t('return.submit', { name: data.memberName })}</button>
			</form>
		{:else}
			<h2>{t('return.invalid.title')}</h2>
			<p class="tagline">{t('return.invalid.body')}</p>
		{/if}
		<div class="lang"><Preferences /></div>
	</div>
</div>

<style>
	.wrap {
		padding: 72px 22px;
	}
	h2 {
		font-family: var(--font-brand);
		font-weight: 600;
		margin-top: 36px;
		font-size: 27px;
		letter-spacing: -0.01em;
	}
	.lang {
		display: flex;
		justify-content: center;
		margin-top: 28px;
	}
</style>
