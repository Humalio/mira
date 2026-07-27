<script lang="ts">
	import Brand from '#lib/components/Brand.svelte';
	import Preferences from '#lib/components/Preferences.svelte';
	import { translator } from '#lib/i18n/index.js';

	// Plain answers for someone about to put photos on a server they do not know: who
	// runs it, what is kept, who sees it, for how long. Every statement here is true of
	// the software itself; the operator's own name, contact and retention are added
	// when they set them (see #lib/server/operator).
	let { data } = $props();
	const t = $derived(translator(data.locale));
	const operator = $derived(data.operator);
</script>

<svelte:head><title>{t('op.privacyLink')} · Mira</title></svelte:head>

<div class="app privacy">
	<Brand />
	<h2>{t('op.privacyLink')}</h2>

	<section>
		<h3>{t('privacy.who.h')}</h3>
		<p>{operator.name ? t('op.runBy', { name: operator.name }) : t('op.runByUnknown')}</p>
		{#if operator.contact}
			<p>
				{t('privacy.who.contact')}
				{#if operator.contact.href}
					<a href={operator.contact.href} rel="noopener noreferrer">{operator.contact.text}</a>
				{:else}{operator.contact.text}{/if}
			</p>
		{/if}
		<p>{t('privacy.who.project')}</p>
	</section>

	<section>
		<h3>{t('privacy.what.h')}</h3>
		<p>{t('privacy.what.media')}</p>
		<p>{t('privacy.what.guest')}</p>
		<p>{t('privacy.what.owner')}</p>
	</section>

	<section>
		<h3>{t('privacy.see.h')}</h3>
		<p>{t('privacy.see.body')}</p>
	</section>

	<section>
		<h3>{t('privacy.long.h')}</h3>
		<p>{operator.retention ?? t('op.keptDefault')}</p>
		<p>{t('privacy.long.delete')}</p>
	</section>

	<section>
		<h3>{t('privacy.track.h')}</h3>
		<p>{t('privacy.track.body')}</p>
	</section>

	<section>
		<h3>{t('privacy.ask.h')}</h3>
		<p>{t('privacy.ask.body')}</p>
	</section>

	<!-- Guests arrive from an invitation, owners from the sign-in page: go back to
	     wherever that was rather than guess. -->
	<button class="ghost" onclick={() => history.back()}>{t('privacy.back')}</button>
	<div class="lang"><Preferences /></div>
</div>

<style>
	.privacy {
		padding: 28px 22px 48px;
	}
	h2 {
		font-family: var(--font-brand);
		font-weight: 600;
		font-size: 27px;
		letter-spacing: -0.01em;
		margin: 26px 0 6px;
	}
	section {
		margin-top: 22px;
	}
	h3 {
		font-size: 15px;
		font-weight: 700;
		margin: 0 0 6px;
	}
	p {
		margin: 0 0 8px;
		font-size: 14.5px;
		line-height: 1.5;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	a {
		color: var(--accent-text);
		font-weight: 600;
	}
	.ghost {
		margin-top: 26px;
	}
	.lang {
		display: flex;
		justify-content: center;
		margin-top: 20px;
	}
</style>
