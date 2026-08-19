<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import {
		ArrowLeft,
		Ban,
		Check,
		HardDrive,
		Images,
		LayoutGrid,
		Search,
		Shield,
		ShieldCheck,
		SlidersHorizontal,
		Trash2,
		Undo2,
		Users,
		Video
	} from '@lucide/svelte';
	import Segmented from '#lib/components/Segmented.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import { translator } from '#lib/i18n/index.js';

	let { data, form } = $props();
	const t = $derived(translator(data.locale));

	// Search and paging are server-side (GET params) so the page stays bounded as the
	// platform grows; the tab is kept in the URL so a search lands back on its tab.
	const TABS = ['overview', 'users', 'albums', 'settings'];
	let tab = $state(
		untrack(() =>
			TABS.includes(page.url.searchParams.get('tab') ?? '') ? page.url.searchParams.get('tab')! : 'overview'
		)
	);
	let q = $state(untrack(() => data.paging.userQ));
	let albumQ = $state(untrack(() => data.paging.albumQ));
	const lastUserPage = $derived(Math.max(1, Math.ceil(data.paging.usersMatched / data.paging.pageSize)));
	const lastAlbumPage = $derived(Math.max(1, Math.ceil(data.paging.albumsMatched / data.paging.pageSize)));
	function pageHref(key: 'up' | 'ap', n: number): string {
		// A throwaway copy that only builds a link; nothing renders from it reactively.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams(page.url.search);
		params.set('tab', key === 'up' ? 'users' : 'albums');
		params.set(key, String(n));
		return `?${params}`;
	}

	// Settings form state (seeded from loaded settings). Bound to the inputs so a
	// post-save form reset can't blank them, and kept across saves.
	let regMode = $state(untrack(() => data.settings.registrationMode));
	let allowlist = $state(untrack(() => data.settings.registrationAllowlist));
	let defaultQuotaMb = $state(untrack(() => data.settings.defaultQuotaMb));
	let maxAlbumsPerUser = $state(untrack(() => data.settings.maxAlbumsPerUser));
	let maxUploadMb = $state(untrack(() => data.settings.maxUploadMb));
	let maxVideoMb = $state(untrack(() => data.settings.maxVideoMb));
	let uploadsPaused = $state(untrack(() => data.settings.uploadsPaused));
	let albumCreationPaused = $state(untrack(() => data.settings.albumCreationPaused));

	// Shared enhance handler for the settings forms: never reset (it would blank
	// the bound inputs), and flash a brief "Saved" on success.
	let saved = $state('');
	let savedTimer: ReturnType<typeof setTimeout>;
	function keep(tag: string) {
		return () =>
			async ({ update, result }: { update: (o?: { reset?: boolean }) => Promise<void>; result: { type: string } }) => {
				await update({ reset: false });
				if (result.type === 'success') {
					saved = tag;
					clearTimeout(savedTimer);
					savedTimer = setTimeout(() => (saved = ''), 1600);
				}
			};
	}

	// Per-user dialogs.
	type UserRow = (typeof data.users)[number];
	let quotaUser = $state<UserRow | null>(null);
	let quotaVal = $state('');
	let deleteAccountRow = $state<UserRow | null>(null);

	function openQuota(u: UserRow) {
		quotaUser = u;
		quotaVal = u.quotaMb == null ? '' : String(u.quotaMb);
	}
	function openDelete(u: UserRow) {
		deleteAccountRow = u;
	}

	function fmtBytes(n: number): string {
		if (!n) return '0 B';
		const u = ['B', 'KB', 'MB', 'GB', 'TB'];
		let v = n;
		let i = 0;
		while (v >= 1024 && i < u.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
	}
	const quotaLabel = (u: UserRow) =>
		u.effectiveQuotaMb > 0
			? t('admin.quota.short', { used: fmtBytes(u.usedBytes), limit: u.effectiveQuotaMb })
			: t('admin.quota.noLimit', { used: fmtBytes(u.usedBytes) });
</script>

<svelte:head><title>Mira · {t('admin.title')}</title></svelte:head>

<div class="app admin">
	<div class="topline">
		<a class="iconbtn" href="/" aria-label={t('admin.back')} title={t('admin.back')}><ArrowLeft size={19} /></a>
		<h2>{t('admin.title')}</h2>
		<span class="spacer"></span>
	</div>

	<Segmented
		bind:value={tab}
		options={[
			{ value: 'overview', label: t('admin.tab.overview'), icon: LayoutGrid },
			{ value: 'users', label: t('admin.tab.users'), icon: Users },
			{ value: 'albums', label: t('admin.tab.albums'), icon: Images },
			{ value: 'settings', label: t('admin.tab.settings'), icon: SlidersHorizontal }
		]}
	/>

	{#if form?.error}<p class="err">{form.error}</p>{/if}

	{#if tab === 'overview'}
		<div class="stats">
			<div class="stat">
				<span class="n">{data.stats.users}</span><span class="l"><Users size={13} /> {t('admin.stat.users')}</span><span
					class="s">{t('admin.stat.usersSub', { admins: data.stats.admins, blocked: data.stats.blocked })}</span
				>
			</div>
			<div class="stat">
				<span class="n">{data.stats.albums}</span><span class="l"><Images size={13} /> {t('admin.stat.albums')}</span
				><span class="s">{t('admin.stat.albumsSub', { n: data.stats.disabledAlbums })}</span>
			</div>
			<div class="stat">
				<span class="n">{data.stats.photos}</span><span class="l"><Images size={13} /> {t('admin.stat.photos')}</span>
			</div>
			<div class="stat">
				<span class="n">{data.stats.videos}</span><span class="l"><Video size={13} /> {t('admin.stat.videos')}</span>
			</div>
			<div class="stat wide">
				<span class="n">{fmtBytes(data.stats.bytes)}</span><span class="l"
					><HardDrive size={13} /> {t('admin.stat.storage')}</span
				>
			</div>
		</div>
	{:else if tab === 'users'}
		<form class="searchrow" method="GET" data-sveltekit-reset="false">
			<Search size={17} />
			<input type="hidden" name="tab" value="users" />
			<input type="hidden" name="aq" value={data.paging.albumQ} />
			<input type="search" name="uq" placeholder={t('admin.users.search')} bind:value={q} />
		</form>
		<div class="countline">
			{t('admin.users.count', {
				shown: data.users.length,
				total: data.paging.usersMatched,
				unit: data.paging.usersMatched === 1 ? t('admin.unit.user') : t('admin.unit.users')
			})}
			{#if lastUserPage > 1}
				<span class="pager">
					{#if data.paging.userPage > 1}<a href={pageHref('up', data.paging.userPage - 1)}>‹</a>{/if}
					{data.paging.userPage} / {lastUserPage}
					{#if data.paging.userPage < lastUserPage}<a href={pageHref('up', data.paging.userPage + 1)}>›</a>{/if}
				</span>
			{/if}
		</div>

		{#each data.users as u (u.id)}
			<div class="row" class:blocked={u.isBlocked}>
				<div class="rowmeta">
					<b>
						{u.name ?? u.email ?? u.id}
						{#if u.isAdmin}<span class="tag admin"><ShieldCheck size={13} /> {t('admin.tag.admin')}</span>{/if}
						{#if u.isBlocked}<span class="tag blk">{t('admin.tag.blocked')}</span>{/if}
					</b>
					<small
						>{t('admin.users.rowMeta', {
							provider: u.provider,
							albums: u.albums,
							unit: u.albums === 1 ? t('admin.unit.album') : t('admin.unit.albums'),
							quota: quotaLabel(u)
						})}</small
					>
				</div>
				<div class="actions">
					<button
						class="iconbtn"
						title={t('admin.action.quotaTitle')}
						aria-label={t('admin.action.quota')}
						onclick={() => openQuota(u)}><HardDrive size={16} /></button
					>
					{#if !u.isSelf}
						<form method="POST" action="?/setAdmin" use:enhance>
							<input type="hidden" name="userId" value={u.id} />
							<input type="hidden" name="isAdmin" value={u.isAdmin ? '0' : '1'} />
							<button
								class="iconbtn"
								type="submit"
								title={u.isAdmin ? t('admin.action.revokeAdmin') : t('admin.action.makeAdmin')}
								aria-label={t('admin.action.toggleAdmin')}><Shield size={16} /></button
							>
						</form>
						{#if u.isBlocked}
							<form method="POST" action="?/unblock" use:enhance>
								<input type="hidden" name="userId" value={u.id} />
								<button
									class="iconbtn"
									type="submit"
									title={t('admin.action.unblock')}
									aria-label={t('admin.action.unblock')}><Undo2 size={16} /></button
								>
							</form>
						{:else}
							<form method="POST" action="?/block" use:enhance>
								<input type="hidden" name="userId" value={u.id} />
								<button
									class="iconbtn danger"
									type="submit"
									title={t('admin.action.block')}
									aria-label={t('admin.action.block')}><Ban size={16} /></button
								>
							</form>
						{/if}
						<button
							class="iconbtn danger"
							title={t('admin.action.deleteUser')}
							aria-label={t('admin.action.delete')}
							onclick={() => openDelete(u)}><Trash2 size={16} /></button
						>
					{:else}
						<span class="you">{t('admin.you')}</span>
					{/if}
				</div>
			</div>
		{/each}
		{#if !data.users.length}<div class="empty-note">{t('admin.users.noMatch', { q: data.paging.userQ })}</div>{/if}
	{:else if tab === 'albums'}
		<form class="searchrow" method="GET" data-sveltekit-reset="false">
			<Search size={17} />
			<input type="hidden" name="tab" value="albums" />
			<input type="hidden" name="uq" value={data.paging.userQ} />
			<input type="search" name="aq" placeholder={t('admin.albums.search')} bind:value={albumQ} />
		</form>
		<div class="countline">
			{t('admin.users.count', {
				shown: data.albums.length,
				total: data.paging.albumsMatched,
				unit: data.paging.albumsMatched === 1 ? t('admin.unit.album') : t('admin.unit.albums')
			})}
			{#if lastAlbumPage > 1}
				<span class="pager">
					{#if data.paging.albumPage > 1}<a href={pageHref('ap', data.paging.albumPage - 1)}>‹</a>{/if}
					{data.paging.albumPage} / {lastAlbumPage}
					{#if data.paging.albumPage < lastAlbumPage}<a href={pageHref('ap', data.paging.albumPage + 1)}>›</a>{/if}
				</span>
			{/if}
		</div>

		{#each data.albums as a (a.id)}
			<div class="row" class:blocked={a.disabled}>
				<div class="rowmeta">
					<b
						>{a.name}{#if a.disabled}<span class="tag blk">{t('admin.tag.disabled')}</span>{/if}</b
					>
					<small
						>{a.ownerName || a.ownerEmail || t('admin.albums.ownerId', { id: a.ownerUserId.slice(0, 8) })} · {t(
							'admin.count.simple',
							{
								n: a.items,
								unit: a.items === 1 ? t('admin.unit.item') : t('admin.unit.items')
							}
						)}</small
					>
				</div>
				<div class="actions">
					<form method="POST" action="?/toggleAlbum" use:enhance>
						<input type="hidden" name="albumId" value={a.id} />
						<input type="hidden" name="disabled" value={a.disabled ? '0' : '1'} />
						<button class="pill sm" class:warn={!a.disabled} type="submit"
							>{a.disabled ? t('admin.albums.enable') : t('admin.albums.takeDown')}</button
						>
					</form>
				</div>
			</div>
		{/each}
		{#if !data.albums.length}<div class="empty-note">
				{t('admin.albums.noMatch', { q: data.paging.albumQ })}
			</div>{/if}
	{:else}
		<!-- Settings -->
		<div class="section-label">{t('admin.reg.title')}</div>
		<form method="POST" action="?/registration" use:enhance={keep('reg')} class="card">
			<Segmented
				bind:value={regMode}
				options={[
					{ value: 'open', label: t('admin.reg.open') },
					{ value: 'closed', label: t('admin.reg.closed') },
					{ value: 'allowlist', label: t('admin.reg.allowlist') }
				]}
			/>
			<p class="cardhint">
				{#if regMode === 'open'}{t('admin.reg.hintOpen')}
				{:else if regMode === 'closed'}{t('admin.reg.hintClosed')}
				{:else}{t('admin.reg.hintAllowlist')}{/if}
			</p>
			{#if regMode === 'allowlist'}
				<textarea name="allowlist" rows="3" placeholder="alice@example.com, @myteam.com" bind:value={allowlist}
				></textarea>
			{:else}
				<input type="hidden" name="allowlist" value={allowlist} />
			{/if}
			<input type="hidden" name="mode" value={regMode} />
			<button class="primary save" class:ok={saved === 'reg'} type="submit">
				{#if saved === 'reg'}<Check size={17} /> {t('admin.saved')}{:else}{t('admin.reg.save')}{/if}
			</button>
		</form>

		<div class="section-label">{t('admin.limits.title')}</div>
		<form method="POST" action="?/limits" use:enhance={keep('lim')} class="card">
			<label class="field" for="dq">{t('admin.limits.defaultQuota')}</label>
			<input id="dq" type="number" name="defaultQuotaMb" min="0" bind:value={defaultQuotaMb} />
			<label class="field" for="ma">{t('admin.limits.maxAlbums')}</label>
			<input id="ma" type="number" name="maxAlbumsPerUser" min="0" bind:value={maxAlbumsPerUser} />
			<label class="field" for="mu">{t('admin.limits.maxUpload')}</label>
			<input id="mu" type="number" name="maxUploadMb" min="1" bind:value={maxUploadMb} />
			<label class="field" for="mv">{t('admin.limits.maxVideo')}</label>
			<input id="mv" type="number" name="maxVideoMb" min="1" bind:value={maxVideoMb} />
			<button class="primary save" class:ok={saved === 'lim'} type="submit">
				{#if saved === 'lim'}<Check size={17} /> {t('admin.saved')}{:else}{t('admin.limits.save')}{/if}
			</button>
		</form>

		<div class="section-label">{t('admin.maint.title')}</div>
		<form method="POST" action="?/maintenance" use:enhance={keep('mnt')} class="card">
			<div class="switchrow">
				<div class="rowmeta">
					<b>{t('admin.maint.pauseUploads')}</b><small>{t('admin.maint.pauseUploadsSub')}</small>
				</div>
				<Switch bind:checked={uploadsPaused} />
			</div>
			<div class="switchrow">
				<div class="rowmeta">
					<b>{t('admin.maint.pauseAlbums')}</b><small>{t('admin.maint.pauseAlbumsSub')}</small>
				</div>
				<Switch bind:checked={albumCreationPaused} />
			</div>
			<input type="hidden" name="uploadsPaused" value={uploadsPaused ? '1' : '0'} />
			<input type="hidden" name="albumCreationPaused" value={albumCreationPaused ? '1' : '0'} />
			<button class="primary save" class:ok={saved === 'mnt'} type="submit">
				{#if saved === 'mnt'}<Check size={17} /> {t('admin.saved')}{:else}{t('admin.maint.save')}{/if}
			</button>
		</form>
	{/if}
</div>

{#if quotaUser}
	<Sheet title={t('admin.quota.title')} autofocus onclose={() => (quotaUser = null)}>
		<p class="hint">
			<b>{quotaUser.name ?? quotaUser.email}</b>
			{#if quotaUser.effectiveQuotaMb > 0}{t('admin.quota.usingTail', {
					used: fmtBytes(quotaUser.usedBytes),
					limit: quotaUser.effectiveQuotaMb
				})}{:else}{t('admin.quota.usingTailNoLimit', { used: fmtBytes(quotaUser.usedBytes) })}{/if}
		</p>
		<form
			method="POST"
			action="?/setQuota"
			use:enhance={() =>
				async ({ update, result }) => {
					await update({ reset: false });
					if (result.type === 'success') quotaUser = null;
				}}
		>
			<label class="field" for="qv">{t('admin.quota.limitLabel')}</label>
			<div class="mbfield">
				<input
					id="qv"
					type="number"
					name="quotaMb"
					min="0"
					inputmode="numeric"
					bind:value={quotaVal}
					placeholder={data.settings.defaultQuotaMb
						? t('admin.quota.phDefault', { n: data.settings.defaultQuotaMb })
						: t('admin.quota.phUnlimited')}
				/>
				<span class="mbsuffix">MB</span>
			</div>
			<p class="cardhint">
				{data.settings.defaultQuotaMb
					? t('admin.quota.hintWithDefault', { n: data.settings.defaultQuotaMb })
					: t('admin.quota.hintUnlimited')}
			</p>
			<input type="hidden" name="userId" value={quotaUser.id} />
			<button class="primary" type="submit">{t('admin.quota.save')}</button>
		</form>
		<button class="ghost" onclick={() => (quotaUser = null)}>{t('admin.cancel')}</button>
	</Sheet>
{/if}

{#if deleteAccountRow}
	<Sheet title={t('admin.delete.title')} onclose={() => (deleteAccountRow = null)}>
		<p class="hint">
			{t('admin.delete.confirmPre')}<b>{deleteAccountRow.name ?? deleteAccountRow.email}</b>{t(
				'admin.delete.confirmPost'
			)}
		</p>
		<form
			method="POST"
			action="?/deleteAccount"
			use:enhance={() =>
				async ({ update, result }) => {
					await update();
					if (result.type === 'success') deleteAccountRow = null;
				}}
		>
			<p class="cardhint">{t('admin.delete.alsoAlbumsSub')}</p>
			<p class="cardhint">{t('admin.delete.otherMembershipsSub')}</p>
			<input type="hidden" name="userId" value={deleteAccountRow.id} />
			<button class="primary danger" type="submit">{t('admin.delete.submit')}</button>
		</form>
		<button class="ghost" onclick={() => (deleteAccountRow = null)}>{t('admin.cancel')}</button>
	</Sheet>
{/if}

<style>
	.admin {
		padding: 16px 16px 40px;
	}
	.pager {
		margin-left: 0.6rem;
		white-space: nowrap;
	}
	.pager a {
		padding: 0 0.4rem;
		text-decoration: none;
	}
	/* The 4-tab Segmented gets cramped on narrow phones — shrink it to fit. */
	@media (max-width: 430px) {
		.admin :global(.seg) {
			gap: 2px;
		}
		.admin :global(.seg button) {
			padding: 8px 4px;
			font-size: 11.5px;
			gap: 4px;
			white-space: nowrap;
		}
		.admin :global(.seg button svg) {
			width: 13px;
			height: 13px;
			flex: none;
		}
	}
	.topline {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 14px;
	}
	.topline h2 {
		flex: 1;
		text-align: center;
		margin: 0;
		font-family: var(--font-brand);
		font-weight: 600;
		font-size: 1.15rem;
	}
	.topline .spacer {
		width: 38px;
	}

	/* overview */
	.stats {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
		margin-top: 16px;
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 14px;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--surface);
	}
	.stat.wide {
		grid-column: 1 / -1;
	}
	.stat .n {
		font-family: var(--font-brand);
		font-size: 1.7rem;
		font-weight: 600;
		line-height: 1;
	}
	.stat .l {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		color: var(--muted);
		margin-top: 4px;
	}
	.stat .s {
		font-size: 11px;
		color: var(--muted);
	}

	.searchrow {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 14px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--surface);
		color: var(--muted);
		margin: 16px 0 0;
	}
	.searchrow input {
		flex: 1;
		border: none;
		background: transparent;
		padding: 12px 0;
		font-size: 15px;
		color: var(--ink);
	}
	.searchrow input:focus {
		outline: none;
	}
	.countline {
		font-size: 12px;
		color: var(--muted);
		margin: 10px 2px 12px;
	}

	.iconbtn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 11px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink);
		flex: none;
	}
	.iconbtn:active {
		background: var(--surface-2);
	}
	.iconbtn.danger {
		color: #b3261e;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: 14px;
		margin-bottom: 8px;
		background: var(--surface);
	}
	.row.blocked {
		opacity: 0.62;
	}
	.rowmeta {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.rowmeta b {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 15px;
	}
	.rowmeta small {
		color: var(--muted);
		font-size: 12px;
	}
	.tag {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 0.68rem;
		font-weight: 600;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--muted);
	}
	.tag.admin {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		color: var(--accent-ink);
	}
	.tag.blk {
		background: rgba(179, 38, 30, 0.12);
		color: #b3261e;
	}
	.actions {
		display: flex;
		gap: 6px;
		flex: none;
		align-items: center;
	}
	.you {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.card {
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--surface);
		padding: 14px;
		margin-bottom: 8px;
	}
	.cardhint {
		color: var(--muted);
		font-size: 12px;
		margin: 10px 0 0;
	}
	.card textarea {
		width: 100%;
		margin-top: 10px;
		padding: 10px 12px;
		border-radius: 12px;
		border: 1px solid var(--line);
		background: var(--surface-2);
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		resize: vertical;
	}
	.card input[type='number'] {
		width: 100%;
		padding: 11px 14px;
		border-radius: 12px;
		background: var(--surface-2);
		border: 1px solid var(--line);
		color: var(--ink);
		font-size: 16px;
	}
	.switchrow {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 0;
	}
	.switchrow + .switchrow {
		border-top: 1px solid var(--line);
	}

	.pill {
		flex: none;
		padding: 8px 16px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		font-weight: 700;
		font-size: 13px;
		color: var(--muted);
	}
	.pill.warn {
		color: #b3261e;
		border-color: color-mix(in srgb, #b3261e 35%, var(--line));
	}
	.primary.danger {
		background: #b3261e;
		color: #fff;
	}
	/* Number field with a unit suffix, used in the quota sheet. */
	.mbfield {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 14px;
		border-radius: 12px;
		background: var(--surface-2);
		border: 1px solid var(--line);
	}
	.mbfield input {
		flex: 1;
		min-width: 0;
		border: none;
		background: transparent;
		padding: 13px 0;
		font-size: 16px;
		color: var(--ink);
	}
	.mbfield input:focus {
		outline: none;
	}
	.mbsuffix {
		font-size: 14px;
		font-weight: 600;
		color: var(--muted);
	}

	.save {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		transition:
			background 0.2s ease,
			color 0.2s ease;
	}
	/* On save, the button itself confirms — soft green with a check, then reverts. */
	.save.ok {
		background: color-mix(in srgb, #2e7d32 16%, var(--surface));
		color: #2e7d32;
	}
</style>
