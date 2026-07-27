<script lang="ts">
	import { Lock, Video } from '@lucide/svelte';
	import { page } from '$app/state';
	import { translator, normalizeLocale, type MessageKey } from '#lib/i18n/index.js';
	import { VIDEO_QUALITIES, DEFAULT_VIDEO_QUALITY, type VideoQuality } from '#lib/video-quality.js';
	import Switch from './Switch.svelte';

	const t = $derived(translator(normalizeLocale(page.data.locale)));

	let {
		autoApprove = $bindable(true),
		videoQuality = $bindable(DEFAULT_VIDEO_QUALITY),
		keepOnlyCopy = $bindable(false),
		locked = $bindable(false),
		closable = false
	}: {
		autoApprove?: boolean;
		videoQuality?: VideoQuality;
		keepOnlyCopy?: boolean;
		locked?: boolean;
		/** Offer "Close the album": only for an album that already exists. */
		closable?: boolean;
	} = $props();

	// Two sheets (create, edit) can show this component; keep their radio groups apart.
	const group = $props.id();
	// The recommended copy first, "no copy" last.
	const ORDER = [...VIDEO_QUALITIES].reverse();
	// Without a copy there is nothing to keep instead of the original.
	const savingSpace = $derived(keepOnlyCopy && videoQuality !== 'original');
	const LABEL: Record<VideoQuality, [MessageKey, MessageKey]> = {
		original: ['opts.vq.original', 'opts.vq.originalSub'],
		lossless: ['opts.vq.lossless', 'opts.vq.losslessSub'],
		balanced: ['opts.vq.balanced', 'opts.vq.balancedSub'],
		small: ['opts.vq.small', 'opts.vq.smallSub']
	};
</script>

<div class="opts">
	<div class="optgroup"><Lock size={13} /> {t('opts.security')}</div>
	<div class="optrow">
		<div class="optlabel"><b>{t('opts.approveUploads')}</b><small>{t('opts.approveUploadsSub')}</small></div>
		<!-- Stored as opt-out (autoApprove); presented as the opt-in "require approval" toggle. -->
		<Switch checked={!autoApprove} onchange={(v) => (autoApprove = !v)} label={t('opts.approveUploads')} />
	</div>
	{#if closable}
		<div class="optrow">
			<div class="optlabel"><b>{t('opts.close')}</b><small>{t('opts.closeSub')}</small></div>
			<Switch bind:checked={locked} label={t('opts.close')} />
		</div>
	{/if}

	<div class="optgroup"><Video size={13} /> {t('opts.optimize')}</div>
	<!-- The original is always kept; the owner chooses the copy the album plays from.
	     Each choice says what it costs. -->
	<fieldset class="quality">
		<legend>{t('opts.videoQuality')}</legend>
		{#each ORDER as q (q)}
			<label class="choice {videoQuality === q ? 'on' : ''}">
				<input type="radio" name={`vq-${group}`} value={q} bind:group={videoQuality} />
				<span class="optlabel"><b>{t(LABEL[q][0])}</b><small>{t(LABEL[q][1])}</small></span>
			</label>
		{/each}
	</fieldset>
	{#if videoQuality !== 'original'}
		<!-- The one switch that gives up an original. Off unless the owner turns it on,
		     and it says what is lost before anything is. -->
		<div class="optrow">
			<div class="optlabel"><b>{t('opts.saveSpace')}</b><small>{t('opts.saveSpaceSub')}</small></div>
			<Switch bind:checked={keepOnlyCopy} label={t('opts.saveSpace')} />
		</div>
	{/if}
	<p class="note" class:warn={savingSpace}>{savingSpace ? t('opts.vq.noteSaveSpace') : t('opts.vq.note')}</p>
</div>

<style>
	.opts {
		border: 1px solid var(--line);
		border-radius: 14px;
		padding: 4px 14px 14px;
		margin-top: 4px;
	}
	.optgroup {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
		margin: 14px 0 6px;
	}
	.optrow {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 7px 0;
	}
	.optlabel b {
		font-size: 14px;
		font-weight: 600;
	}
	.optlabel small {
		display: block;
		color: var(--muted);
		font-size: 12px;
		line-height: 1.4;
		margin-top: 2px;
	}
	.quality {
		border: none;
		margin: 0;
		padding: 0;
		min-width: 0;
		display: grid;
		gap: 6px;
	}
	.quality legend {
		padding: 0;
		margin-bottom: 6px;
		font-size: 14px;
		font-weight: 600;
	}
	.choice {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 9px 10px;
		border: 1px solid var(--line);
		border-radius: 12px;
		cursor: pointer;
	}
	.choice.on {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.choice input {
		flex: none;
		width: 18px;
		height: 18px;
		margin: 2px 0 0;
		padding: 0;
		accent-color: var(--accent-text);
	}
	.note {
		margin: 10px 0 0;
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted);
	}
	.note.warn {
		color: var(--ink);
		font-weight: 600;
	}
</style>
