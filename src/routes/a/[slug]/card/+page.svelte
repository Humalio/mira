<script lang="ts">
	import { ArrowLeft, Printer } from '@lucide/svelte';
	import { translator } from '#lib/i18n/index.js';

	let { data } = $props();
	const t = $derived(translator(data.locale));
	// The address as a person would type it: no "https://", no trailing slash.
	const shown = $derived(data.joinUrl.replace(/^https?:\/\//, ''));
</script>

<svelte:head><title>{data.albumName} · Mira</title></svelte:head>

<div class="page">
	<div class="sheet-tools">
		<a class="tool" href={`/a/${data.album.slug}`}><ArrowLeft size={18} /> {t('card.back')}</a>
		<button class="tool go" onclick={() => window.print()}><Printer size={18} /> {t('card.print')}</button>
	</div>

	<main class="card">
		<p class="brand"><img src="/mira-mark.svg" alt="" />Mira</p>
		<h1>{data.albumName}</h1>
		<p class="ask">{t('card.scan')}</p>
		<img class="code" src={data.qr} alt={t('board.invite.qrAlt')} width="900" height="900" />
		<p class="how">{t('card.noAccount')}</p>
		<p class="link">{shown}</p>
	</main>
</div>

<style>
	/* White behind the card, on this page only (not a global rule: it would outlive the page). */
	.page {
		min-height: 100dvh;
		background: #fff;
	}
	.sheet-tools {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		max-width: 520px;
		margin: 0 auto;
		padding: 14px 16px 0;
	}
	.tool {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 11px 15px;
		border-radius: 12px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink);
		font-weight: 700;
		font-size: 14px;
	}
	.tool.go {
		background: var(--accent);
		color: var(--accent-ink);
		border-color: transparent;
	}
	.card {
		max-width: 520px;
		margin: 18px auto 40px;
		padding: 34px 28px 30px;
		text-align: center;
		color: #302833;
		background: #fff;
		border: 1px solid #dcd4de;
		border-radius: 22px;
	}
	.brand {
		margin: 0;
		font-family: var(--font-brand);
		font-size: 18px;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: #38243d;
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.brand img {
		height: 18px;
		width: auto;
	}
	h1 {
		margin: 8px 0 0;
		font-family: var(--font-brand);
		font-size: clamp(28px, 8vw, 40px);
		font-weight: 600;
		line-height: 1.12;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}
	.ask {
		margin: 14px 0 0;
		font-size: 19px;
		font-weight: 700;
	}
	.code {
		display: block;
		width: min(78%, 340px);
		height: auto;
		margin: 18px auto 14px;
	}
	.how {
		margin: 0;
		font-size: 15px;
		color: #4f4552;
	}
	.link {
		margin: 12px 0 0;
		font-size: 12.5px;
		color: #716574;
		overflow-wrap: anywhere;
	}
	@media print {
		.sheet-tools {
			display: none;
		}
		.card {
			margin: 0 auto;
			border: none;
			max-width: none;
			padding-top: 12mm;
		}
		.code {
			width: 90mm;
		}
		@page {
			margin: 14mm;
		}
	}
</style>
