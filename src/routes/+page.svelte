<script lang="ts">
	import { enhance } from '$app/forms';
	import { ChevronDown, ChevronUp, Images, LogOut, Plus, Settings, Shield } from '@lucide/svelte';
	import AlbumOptions from '#lib/components/AlbumOptions.svelte';
	import Brand from '#lib/components/Brand.svelte';
	import Preferences from '#lib/components/Preferences.svelte';
	import OperatorNote from '#lib/components/OperatorNote.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import { longpress } from '#lib/longpress.js';
	import { translator } from '#lib/i18n/index.js';
	import { DEFAULT_VIDEO_QUALITY, type VideoQuality } from '#lib/video-quality.js';

	let { data, form } = $props();
	const t = $derived(translator(data.locale));

	let createOpen = $state(false);
	// Open by default: a new owner should see what will happen to the group's videos
	// rather than discover it behind a collapsed row.
	let showOptions = $state(true);
	let createApprove = $state(true);
	// The starting choice for a NEW album; the owner picks any of the four here or later.
	let createQuality = $state<VideoQuality>(DEFAULT_VIDEO_QUALITY);
	let createKeepOnlyCopy = $state(false);

	let editOpen = $state(false);
	let editSlug = $state('');
	let editName = $state('');
	let editApprove = $state(true);
	let editQuality = $state<VideoQuality>(DEFAULT_VIDEO_QUALITY);
	let editKeepOnlyCopy = $state(false);
	let editLocked = $state(false);
	// Delete asks twice. Reset on open so a previous album's confirm can't carry over.
	let confirmDelete = $state(false);

	type AlbumItem = (typeof data.albums)[number];
	function openEditAlbum(album: AlbumItem) {
		editSlug = album.slug;
		editName = album.name;
		editApprove = album.autoApprove;
		editQuality = album.videoQuality;
		editKeepOnlyCopy = album.keepOnlyCopy;
		editLocked = album.locked;
		confirmDelete = false;
		editOpen = true;
	}
</script>

<svelte:head><title>Mira</title></svelte:head>

{#if !data.user}
	<!-- Logged out: the landing + sign-in. Joining a shared link never lands here.
	     Native form POSTs straight to the Auth.js endpoints — no client JS needed. -->
	<div class="app signin">
		<div class="signin-inner">
			<Brand size={38} />
			<h2 class="headline">{t('signin.headline')}</h2>
			<p class="sub">{t('signin.sub')}</p>

			{#if data.signInProblem}
				<p class="err" role="alert">
					{data.signInProblem === 'denied' ? t('signin.denied') : t('signin.failed')}
				</p>
			{/if}
			<div class="providers">
				{#each data.providers as p, i (p.id)}
					{#if p.password}
						<!-- The administrator password: no account with Google or GitHub needed. -->
						<form class="devform" method="POST" action="/auth/callback/password">
							<input
								type="password"
								name="password"
								maxlength="1000"
								placeholder={t('signin.passwordPlaceholder')}
								aria-label={t('signin.passwordPlaceholder')}
								autocomplete="current-password"
								required
							/>
							<input type="hidden" name="callbackUrl" value="/" />
							<button class="provider" class:primary={i === 0} type="submit">{t('signin.passwordSubmit')}</button>
						</form>
					{:else if p.dev}
						<form class="devform" method="POST" action="/auth/callback/dev">
							<input
								name="username"
								maxlength="80"
								placeholder={t('signin.devPlaceholder')}
								autocomplete="username"
								autocapitalize="off"
								spellcheck="false"
								required
							/>
							<input type="hidden" name="callbackUrl" value="/" />
							<button class="provider primary" type="submit">{p.name}</button>
						</form>
					{:else}
						<form method="POST" action={`/auth/signin/${p.id}`}>
							<input type="hidden" name="callbackUrl" value="/" />
							<button class="provider" class:primary={i === 0} type="submit"
								>{t('signin.continue', { provider: p.name })}</button
							>
						</form>
					{/if}
				{/each}
				{#if !data.providers.length}
					<p class="hint">{t('signin.noProviders')}</p>
				{/if}
			</div>
		</div>

		<p class="reassure">{t('signin.reassure')}</p>
		<OperatorNote />
		<div class="langfoot"><Preferences /></div>
	</div>
{:else}
	<div class="app home with-bar">
		<div class="topline">
			<Brand />
			<div class="acct">
				{#if data.user.isAdmin}
					<a class="iconbtn" href="/admin" aria-label={t('a11y.admin')} title={t('a11y.admin')}><Shield size={19} /></a>
				{/if}
				<form method="POST" action="/auth/signout">
					<input type="hidden" name="callbackUrl" value="/" />
					<button class="iconbtn" type="submit" aria-label={t('a11y.signOut')} title={t('a11y.signOut')}
						><LogOut size={19} /></button
					>
				</form>
			</div>
		</div>
		<p class="tagline">{t('home.signedInAs', { who: data.user.name ?? data.user.email ?? '' })}</p>

		{#if data.albums.length}
			<div class="section-label">{t('home.yourAlbums')}</div>
			{#each data.albums as album (album.slug)}
				<div class="album-card">
					<a class="album-link" href={`/a/${album.slug}`} use:longpress={{ onpress: () => openEditAlbum(album) }}>
						<div class="thumb">
							{#if album.cover}<img src={album.cover} alt="" loading="lazy" decoding="async" />{/if}
						</div>
						<div class="meta">
							<b>{album.name}</b><small
								>{album.itemCount} {album.itemCount === 1 ? t('home.item') : t('home.items')}</small
							>
						</div>
					</a>
					<button class="album-cog" aria-label={t('home.albumSettings')} onclick={() => openEditAlbum(album)}>
						<Settings size={19} />
					</button>
				</div>
			{/each}
		{:else}
			<div class="hero" style="padding-top: 60px;">
				<div class="big"><Images size={46} strokeWidth={1.5} /></div>
				<h3>{t('home.emptyTitle')}</h3>
				<p>{t('home.emptyBody')}</p>
			</div>
		{/if}
		<div class="langfoot"><Preferences /></div>
	</div>

	{#if data.canCreate}
		<div class="bar">
			<button class="share" onclick={() => (createOpen = true)}><Plus size={20} /> {t('home.newAlbum')}</button>
		</div>
	{:else if data.createBlockedReason}
		<div class="bar"><div class="pausednote">{data.createBlockedReason}</div></div>
	{/if}
{/if}

{#if createOpen}
	<Sheet title={t('create.sheetTitle')} autofocus onclose={() => (createOpen = false)}>
		<p class="hint">{t('create.hint')}</p>
		<form method="POST" action="?/create" use:enhance>
			<label class="field" for="an">{t('create.albumName')}</label>
			<input id="an" type="text" name="albumName" maxlength="120" placeholder={t('create.albumPlaceholder')} required />

			<button type="button" class="optstoggle" onclick={() => (showOptions = !showOptions)}>
				{t('create.options')}
				{#if showOptions}<ChevronUp size={16} />{:else}<ChevronDown size={16} />{/if}
			</button>
			{#if showOptions}
				<AlbumOptions
					bind:autoApprove={createApprove}
					bind:videoQuality={createQuality}
					bind:keepOnlyCopy={createKeepOnlyCopy}
				/>
			{/if}

			<input type="hidden" name="autoApprove" value={createApprove ? '1' : '0'} />
			<input type="hidden" name="videoQuality" value={createQuality} />
			<input type="hidden" name="keepOnlyCopy" value={createKeepOnlyCopy ? '1' : '0'} />

			{#if form?.error}<p class="err">{form.error}</p>{/if}
			<button class="primary" type="submit">{t('create.submit')}</button>
		</form>
		<button class="ghost" onclick={() => (createOpen = false)}>{t('common.cancel')}</button>
	</Sheet>
{/if}

{#if editOpen}
	<Sheet title={t('edit.sheetTitle')} onclose={() => (editOpen = false)}>
		<form
			method="POST"
			action="?/update"
			use:enhance={() =>
				async ({ update, result }) => {
					await update({ reset: false });
					if (result.type === 'success') editOpen = false;
				}}
		>
			<label class="field" for="ename">{t('create.albumName')}</label>
			<input id="ename" type="text" name="name" maxlength="120" bind:value={editName} required />
			<div style="height: 14px;"></div>
			<AlbumOptions
				bind:autoApprove={editApprove}
				bind:videoQuality={editQuality}
				bind:keepOnlyCopy={editKeepOnlyCopy}
				bind:locked={editLocked}
				closable
			/>
			<input type="hidden" name="albumSlug" value={editSlug} />
			<input type="hidden" name="autoApprove" value={editApprove ? '1' : '0'} />
			<input type="hidden" name="videoQuality" value={editQuality} />
			<input type="hidden" name="keepOnlyCopy" value={editKeepOnlyCopy ? '1' : '0'} />
			<input type="hidden" name="locked" value={editLocked ? '1' : '0'} />
			<button class="primary" type="submit">{t('edit.save')}</button>
		</form>

		<div class="danger">
			{#if !confirmDelete}
				<button class="danger-link" onclick={() => (confirmDelete = true)}>{t('edit.delete')}</button>
			{:else}
				<b class="danger-ask">{t('edit.deleteAsk', { name: editName })}</b>
				<small class="danger-warn">{t('edit.deleteWarn')}</small>
				<form
					method="POST"
					action="?/deleteAlbum"
					use:enhance={() =>
						async ({ update, result }) => {
							await update({ reset: false });
							if (result.type === 'success') editOpen = false;
						}}
				>
					<input type="hidden" name="albumSlug" value={editSlug} />
					<button class="danger-go" type="submit">{t('edit.deleteConfirm')}</button>
				</form>
				<button class="ghost" onclick={() => (confirmDelete = false)}>{t('edit.deleteKeep')}</button>
			{/if}
		</div>

		<!-- Hidden while the delete confirm is armed: the choice there is delete-or-keep,
		     and a second generic Cancel next to it just reads as a duplicate. -->
		{#if !confirmDelete}
			<button class="ghost" onclick={() => (editOpen = false)}>{t('common.cancel')}</button>
		{/if}
	</Sheet>
{/if}

<style>
	/* Delete lives below the save action and asks twice. #b3261e matches the admin
	   take-down affordance — the palette has no danger token. */
	.danger {
		margin-top: 18px;
		padding-top: 16px;
		border-top: 1px solid var(--line);
	}
	.danger-link {
		width: 100%;
		padding: 13px;
		border-radius: 14px;
		background: transparent;
		color: #b3261e;
	}
	.danger-ask {
		display: block;
		margin-bottom: 6px;
		color: var(--ink);
	}
	.danger-warn {
		display: block;
		margin-bottom: 12px;
		color: var(--muted);
		line-height: 1.4;
	}
	.danger-go {
		width: 100%;
		padding: 13px;
		border-radius: 14px;
		background: #b3261e;
		color: #fff;
		font-weight: 600;
	}

	/* ---- sign-in landing ---------------------------------------------------- */
	.signin {
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
		padding: 0 22px calc(20px + env(safe-area-inset-bottom));
		background: var(--cover-grad), var(--bg);
	}
	.signin-inner {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: flex-start;
		max-width: 380px;
		width: 100%;
		margin: 0 auto;
	}
	.headline {
		font-family: var(--font-brand);
		font-weight: 600;
		font-size: clamp(30px, 9vw, 40px);
		line-height: 1.08;
		letter-spacing: -0.02em;
		color: var(--ink);
		margin: 22px 0 0;
	}
	.sub {
		color: var(--muted);
		font-size: 15px;
		line-height: 1.5;
		margin: 14px 0 0;
		max-width: 19em;
	}
	.providers {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 30px;
	}
	.provider {
		width: 100%;
		padding: 15px 16px;
		border-radius: 14px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink);
		font-weight: 700;
		font-size: 16px;
		box-shadow: var(--shadow);
	}
	.provider.primary {
		background: var(--accent);
		color: var(--accent-ink);
		border-color: transparent;
	}
	.provider:active {
		transform: scale(0.985);
	}
	.devform {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.devform input {
		width: 100%;
		padding: 14px 16px;
		border-radius: 14px;
		background: var(--surface);
		border: 1px solid var(--line);
		color: var(--ink);
		font-size: 16px;
	}
	.reassure {
		color: var(--muted);
		font-size: 13px;
		text-align: center;
		max-width: 320px;
		margin: 16px auto 0;
	}
	.langfoot {
		display: flex;
		justify-content: center;
		margin-top: 24px;
	}

	/* ---- logged-in header --------------------------------------------------- */
	.topline {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.acct {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.iconbtn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		border-radius: 11px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink);
	}
	.iconbtn:active {
		background: var(--surface-2);
	}
	.pausednote {
		flex: 1;
		max-width: 320px;
		text-align: center;
		font-size: 13px;
		color: var(--muted);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 14px;
		padding: 13px 16px;
		box-shadow: var(--shadow);
	}
</style>
