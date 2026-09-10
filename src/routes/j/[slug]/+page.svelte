<script lang="ts">
	import Brand from '#lib/components/Brand.svelte';
	import Preferences from '#lib/components/Preferences.svelte';
	import OperatorNote from '#lib/components/OperatorNote.svelte';
	import { translator } from '#lib/i18n/index.js';
	let { data, form } = $props();
	const t = $derived(translator(data.locale));
</script>

<svelte:head>
	<title>{data.albumName} · Mira</title>
	<!-- What WhatsApp, Telegram, iMessage and the rest show when the invitation is pasted:
	     the album's name, one line of what to expect, and a neutral picture. Never a
	     photo from the album: anyone holding the link can fetch this page. -->
	<meta name="description" content={t('join.previewDescription')} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Mira" />
	<meta property="og:title" content={t('join.previewTitle', { album: data.albumName })} />
	<meta property="og:description" content={t('join.previewDescription')} />
	<meta property="og:url" content={data.joinUrl} />
	<meta property="og:image" content={data.previewImage} />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta name="twitter:card" content="summary_large_image" />
	<!-- An invitation is for the people it was sent to, not for search results. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="app" style={data.themeStyle}>
	<div style="padding: 72px 22px;">
		<Brand />
		{#if data.expired}
			<!-- The owner replaced the invitation: this link names the album but opens nothing. -->
			<h2
				style="font-family: var(--font-brand); font-weight: 600; margin-top: 36px; font-size: 27px; letter-spacing: -0.01em;"
			>
				{t('join.expired.title')}
			</h2>
			<p class="tagline">{t('join.expired.body', { album: data.albumName })}</p>
		{:else}
			<h2
				style="font-family: var(--font-brand); font-weight: 600; margin-top: 36px; font-size: 27px; letter-spacing: -0.01em;"
			>
				{t('join.title', { album: data.albumName })}
			</h2>
			<p class="tagline">{t('join.tagline')}</p>
			<form method="POST">
				<input
					type="text"
					name="name"
					maxlength="80"
					placeholder={t('join.namePlaceholder')}
					autocomplete="name"
					value={form?.name ?? ''}
					required
				/>
				{#if form?.error}<p style="color: #ff6b6b; font-size: 13px;">{form.error}</p>{/if}
				{#if form?.nameTaken}
					<p class="hint" role="status" style="margin-top: 10px;">{t('join.nameTaken', { name: form.name })}</p>
				{/if}
				<button class="primary" type="submit">{t('join.submit')}</button>
				{#if form?.nameTaken}
					<button class="ghost" type="submit" name="confirm" value="1"
						>{t('join.joinAnyway', { name: form.name })}</button
					>
				{/if}
			</form>
			<p style="margin-top: 14px; font-size: 13px; color: var(--muted); text-align: center;">
				{data.videosReduced ? t('join.originalsVideoCopies') : t('join.originals')}
			</p>
		{/if}
		<!-- Before handing over photos: whose server this is, and how long it keeps them. -->
		<OperatorNote />
		<!-- Guests never see the home page, so this is their one chance to pick a language. -->
		<div style="display: flex; justify-content: center; margin-top: 28px;"><Preferences /></div>
	</div>
</div>
