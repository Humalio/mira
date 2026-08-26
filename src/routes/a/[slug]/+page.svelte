<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import { resolveTokens, tokensToStyle, SKIN_LIST, normalizeTheme } from '#lib/theme/skins.js';
	import { allocate, type UiAction } from '#lib/ui/budget.js';
	import {
		ArrowLeft,
		Camera,
		Check,
		ChevronLeft,
		ChevronRight,
		Download,
		Ellipsis,
		Heart,
		Images,
		Link,
		LayoutGrid,
		LoaderCircle,
		Lock,
		LockOpen,
		Mail,
		MapPin,
		MessageCircle,
		MessageSquare,
		Palette,
		Pencil,
		Play,
		Plus,
		Printer,
		RefreshCw,
		Rows3,
		Send,
		Share2,
		SlidersHorizontal,
		Smartphone,
		Trash2,
		User,
		UserPlus,
		X
	} from '@lucide/svelte';
	import Preferences from '#lib/components/Preferences.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import Segmented from '#lib/components/Segmented.svelte';
	import { longpress } from '#lib/longpress.js';
	import { localeTag, translator } from '#lib/i18n/index.js';
	import { formatBytes } from '#lib/format.js';

	let { data } = $props();
	const t = $derived(translator(data.locale));

	type MediaItem = {
		id: string;
		by: string;
		memberId: string;
		favorited: boolean;
		thumb: string;
		full: string;
		download: string;
		downloadCopy: string;
		kind: string;
		likes: number;
		approved: boolean;
		sizeBytes: number;
		copyBytes: number | null;
		reduced: boolean;
		taken: { wall: string } | { at: string } | null;
		addedAt: string;
	};

	let activeMoment = $state(0);
	let filter = $state<{ type: 'all' | 'favs' | 'pending' | 'member'; memberId: string | null }>({
		type: 'all',
		memberId: null
	});
	let filterOpen = $state(false);
	let layout = $state<'grid' | 'feed'>('grid');
	let sort = $state<'timeline' | 'liked'>('timeline');
	let busy = $state(false);
	// Position in the current batch, so a 40-photo upload shows it is moving.
	let batchDone = $state(0);
	let batchTotal = $state(0);
	let toastMsg = $state('');
	// Videos on their way (anyone's): from the page load, then kept fresh by the pulse.
	type Preparing = (typeof data.preparing)[number];
	// Follows each page load; the pulse overwrites it in between.
	let preparing = $derived<Preparing[]>(data.preparing);
	const preparingIn = (momentId: string) =>
		filter.type === 'all' ? preparing.filter((w) => w.momentId === momentId) : [];
	const preparingLabel = (w: Preparing) =>
		w.memberId === data.member.id
			? t('board.preparing.mine')
			: t('board.preparing.other', { name: data.people.find((p) => p.id === w.memberId)?.name ?? w.by });
	const preparingStatus = (w: Preparing) =>
		w.percent === null
			? ''
			: w.phase === 'uploading'
				? t('board.preparing.uploading', { percent: w.percent })
				: t('board.preparing.compressing', { percent: w.percent });
	// Chunked video upload: the original is streamed to the server in <100 MB parts
	// (to clear the proxy body cap); the server reassembles and optimizes it.
	let uploading = $state(false);
	let uploadPct = $state(0);
	// What the overlay is reporting: our own upload, then the server's stages.
	type VideoStage = 'uploading' | 'waiting' | 'assembling' | 'queued' | 'compressing' | 'saving';
	let uploadStage = $state<VideoStage>('uploading');
	// True while a request is being retried after a dropped connection.
	let reconnecting = $state(false);
	// How long an upload keeps retrying through an outage before it gives up.
	const OUTAGE_PATIENCE_MS = 10 * 60_000;
	// One 12 MB piece should never take this long even on a slow phone uplink (it allows
	// about 0.4 Mbit/s); past it the connection is treated as dead and the piece resent.
	const CHUNK_TIMEOUT_MS = 4 * 60_000;
	// The progress poll is a few bytes each way.
	const POLL_TIMEOUT_MS = 60_000;
	// A bar only means something while we can measure: bytes sent, or ffmpeg's progress.
	const measurable = $derived(uploadStage === 'uploading' || uploadStage === 'compressing');
	const stageTitle = $derived(
		uploadStage === 'uploading'
			? t('board.uploadingVideo')
			: uploadStage === 'queued'
				? t('board.video.queued')
				: uploadStage === 'compressing'
					? t('board.video.compressing')
					: uploadStage === 'saving'
						? t('board.video.saving')
						: t('board.video.assembling')
	);
	let uploadAbort: AbortController | null = null;
	let uploadCanceled = false;
	let favoriteOverride = $state<Record<string, boolean>>({});

	let shareOpen = $state(false);
	let shareMomentId = $state('');
	let downloadOpen = $state(false);
	// Which size of video a ZIP should carry: as uploaded, or the small copies.
	let zipVideos = $state<'original' | 'copy'>('original');
	const zipSize = $derived(zipVideos === 'copy' ? '&videos=copy' : '');
	// In the viewer: the two-size choice for the video on screen.
	let sizeChoiceOpen = $state(false);
	$effect(() => {
		void lightboxIndex; // another item, or the viewer closed: put the choice away
		sizeChoiceOpen = false;
	});
	let downloadByPerson = $state(false);
	let editOpen = $state(false);
	let momentOpen = $state(false);
	let renameOpen = $state(false);
	let renameMomentId = $state('');
	let renameMomentName = $state('');
	let inviteOpen = $state(false);
	// "Let someone back in" (owner) and "Move to another device" (guest): pick who, then
	// show the one-time link the server made.
	let returnOpen = $state(false);
	let returnInfo = $state<{ link: string; self: boolean; memberId: string; qr: string } | null>(null);
	const returnable = $derived(data.people.filter((p) => p.guest && p.id !== data.member.id));
	const iAmGuest = $derived(data.people.some((p) => p.id === data.member.id && p.guest));
	const returnName = $derived(data.people.find((p) => p.id === returnInfo?.memberId)?.name ?? '');
	function openReturn() {
		menuOpen = false;
		returnInfo = null;
		returnOpen = true;
	}
	async function copyText(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast(t('board.toast.linkCopied'));
		} catch {
			toast(t('board.toast.copyFailed'));
		}
	}
	function openRenameMoment(m: { id: string; name: string }) {
		renameMomentId = m.id;
		renameMomentName = m.name;
		renameOpen = true;
	}
	let menuOpen = $state(false);
	let lightboxIndex = $state(-1);

	let editSkin = $state(untrack(() => data.skin));
	let editAccent = $state(untrack(() => data.accent ?? SKIN_LIST.find((s) => s.id === data.skin)?.accent ?? '#4f8cff'));

	let camInput = $state<HTMLInputElement>();
	let libInput = $state<HTMLInputElement>();

	const slug = $derived(data.slug);
	const isFavorite = (item: { id: string; favorited: boolean }) => favoriteOverride[item.id] ?? item.favorited;
	const favoriteCount = $derived(
		data.favoriteCount +
			data.moments.reduce(
				(total, moment) =>
					total +
					moment.photos.reduce(
						(delta, item) =>
							delta +
							(favoriteOverride[item.id] === undefined
								? 0
								: Number(favoriteOverride[item.id]) - Number(item.favorited)),
						0
					),
				0
			)
	);
	// Active view filter: all / my favourites / a specific person.
	const matches = (p: MediaItem) => {
		if (filter.type === 'favs') return isFavorite(p);
		if (filter.type === 'pending') return !p.approved;
		if (filter.type === 'member') return p.memberId === filter.memberId;
		return true;
	};
	const filterLabel = $derived(
		filter.type === 'favs'
			? t('board.filterLabel.liked')
			: filter.type === 'pending'
				? t('board.pending')
				: filter.type === 'member'
					? (data.people.find((p) => p.id === filter.memberId)?.name ?? t('board.filterLabel.person'))
					: t('board.filterLabel.all')
	);
	// Optimistic like count: server total adjusted by my pending toggle.
	const likeCount = (p: MediaItem) => p.likes + (isFavorite(p) ? 1 : 0) - (p.favorited ? 1 : 0);
	const sortMedia = (items: MediaItem[]) =>
		sort === 'liked' ? [...items].sort((a, b) => likeCount(b) - likeCount(a)) : items;
	const shownIn = (m: { photos: unknown[] }) => sortMedia((m.photos as MediaItem[]).filter(matches));
	// Flattened, currently-visible photos in render order — powers lightbox prev/next.
	const flat = $derived(data.moments.flatMap((m) => shownIn(m)));
	const lightboxPhoto = $derived(lightboxIndex >= 0 ? (flat[lightboxIndex] ?? null) : null);
	// When it was taken, from the metadata Mira keeps: a photo shows the time on the
	// camera's own clock, a video its recording instant in the viewer's zone. Without
	// either, say when it was added rather than nothing.
	const whenText = (p: MediaItem) => {
		const format = (d: Date) =>
			new Intl.DateTimeFormat(localeTag(data.locale), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
		if (!p.taken) return t('board.lightbox.added', { when: format(new Date(p.addedAt)) });
		if ('at' in p.taken) return format(new Date(p.taken.at));
		const [y, mo, d, h, mi] = p.taken.wall.split(/[-T:]/).map(Number);
		return format(new Date(y, mo - 1, d, h, mi));
	};
	// Where it was taken, read from the original on request (see /place).
	let places = $state<Record<string, { lat: number; lon: number } | null>>({});
	$effect(() => {
		const id = lightboxPhoto?.id;
		if (!id || id in untrack(() => places)) return;
		fetch(`/a/${slug}/place?id=${id}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((out) => (places = { ...places, [id]: out?.place ?? null }))
			.catch(() => {});
	});
	const lightboxPlace = $derived(lightboxPhoto ? (places[lightboxPhoto.id] ?? null) : null);
	const mapUrl = (place: { lat: number; lon: number }) =>
		`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lon}#map=15/${place.lat}/${place.lon}`;
	// What a video's Download gives, said before it is tapped: both sizes when the album
	// plays a small copy, and the plain truth when the original was not kept.
	const videoFacts = (p: MediaItem) => {
		const size = formatBytes(p.sizeBytes, data.locale);
		if (p.reduced) return t('board.video.reduced', { size });
		if (p.copyBytes !== null)
			return t('board.video.both', { original: size, copy: formatBytes(p.copyBytes, data.locale) });
		return t('board.video.originalOnly', { size });
	};

	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	function toast(msg: string) {
		toastMsg = msg;
		clearTimeout(toastTimer);
		// Long enough to read: a sentence about approval needs more than "Deleted".
		toastTimer = setTimeout(() => (toastMsg = ''), Math.max(2200, msg.length * 70));
	}

	/** Reload the album's data without losing the viewer's place. */
	async function refreshAlbum() {
		const open = lightboxPhoto?.id;
		await refreshAll();
		if (open) lightboxIndex = flat.findIndex((item) => item.id === open);
	}

	// Keep an open album current by itself: new items, approvals, and videos on their
	// way appear without a reload. One tiny request every ten seconds (every four while
	// a video is being prepared), and none at all while the tab is hidden.
	onMount(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		const check = async () => {
			try {
				const res = await fetch(`/a/${slug}/pulse`);
				// Gone or no longer a member: stop asking. A rate limit or a blip: ask again later.
				if (res.status === 403 || res.status === 404) stopped = true;
				if (!res.ok) return;
				const pulse = await res.json();
				preparing = pulse.preparing;
				if (pulse.stamp !== data.stamp) await refreshAlbum();
			} catch {
				/* offline: the next round tries again */
			}
		};
		const schedule = () => {
			clearTimeout(timer);
			if (stopped || document.visibilityState !== 'visible') return;
			timer = setTimeout(
				async () => {
					await check();
					schedule();
				},
				preparing.length ? 4_000 : 10_000
			);
		};
		const onVisibility = async () => {
			clearTimeout(timer);
			if (document.visibilityState !== 'visible') return;
			await check(); // back on the tab: catch up at once
			schedule();
		};
		document.addEventListener('visibilitychange', onVisibility);
		schedule();
		return () => {
			stopped = true;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});
	function setFilter(type: 'all' | 'favs' | 'pending') {
		filter = { type, memberId: null };
		filterOpen = false;
	}
	function setFilterMember(id: string) {
		filter = { type: 'member', memberId: id };
		filterOpen = false;
	}

	// Allocate actions to the visible bar vs the overflow menu by screen width.
	let vw = $state(0);
	const budget = $derived(vw === 0 ? 2 : vw < 400 ? 1 : vw < 560 ? 2 : 3);
	const ACTION_ICON: Record<string, typeof Download> = {
		download: Download,
		filter: SlidersHorizontal,
		invite: UserPlus,
		moment: Plus,
		personalize: Palette
	};
	// The word under each icon in the bar (the full label stays in the menu and tooltip).
	const ACTION_SHORT: Record<string, () => string> = {
		invite: () => t('board.action.inviteShort'),
		moment: () => t('board.share.moment'),
		personalize: () => t('board.personalize.skin')
	};
	const actions = $derived([
		{
			id: 'download',
			label: t('board.action.download'),
			value: 7,
			cost: 1,
			available: data.totalItems > 0
		},
		{ id: 'filter', label: t('board.action.view'), value: 6, cost: 1, available: data.totalItems > 0 },
		{
			id: 'invite',
			label: t('board.action.invite'),
			value: 6,
			cost: 1,
			available: true
		},
		{ id: 'moment', label: t('board.action.moment'), value: 4, cost: 1, available: !data.locked },
		{ id: 'personalize', label: t('board.action.personalize'), value: 2, cost: 1, available: data.isOwner }
	] as UiAction[]);
	const alloc = $derived(allocate(actions, budget));
	function runAction(id: string) {
		menuOpen = false;
		if (id === 'download') {
			downloadByPerson = false;
			downloadOpen = true;
		} else if (id === 'filter') filterOpen = true;
		else if (id === 'invite') inviteOpen = true;
		else if (id === 'moment') momentOpen = true;
		else if (id === 'personalize') openEdit();
	}

	// Long-press multi-select for batch download / share.
	let selecting = $state(false);
	const selected = new SvelteSet<string>();
	let canNativeShare = $state(false);

	const allById = $derived(new Map(data.moments.flatMap((m) => (m.photos as MediaItem[]).map((p) => [p.id, p]))));
	const downloadSelectedUrl = $derived(`/a/${slug}/download?scope=ids&ids=${[...selected].join(',')}${zipSize}`);

	// Per-app invite links (share the join URL — work without HTTPS, no Web Share API).
	const inviteMsg = $derived(t('board.invite.msg', { album: data.albumName }));
	const mailSubject = $derived(t('board.invite.mailSubject', { album: data.albumName }));
	const waUrl = $derived(`https://wa.me/?text=${encodeURIComponent(`${inviteMsg} ${data.joinUrl}`)}`);
	const tgUrl = $derived(
		`https://t.me/share/url?url=${encodeURIComponent(data.joinUrl)}&text=${encodeURIComponent(inviteMsg)}`
	);
	const smsUrl = $derived(`sms:?&body=${encodeURIComponent(`${inviteMsg} ${data.joinUrl}`)}`);
	const mailUrl = $derived(
		`mailto:?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(`${inviteMsg}\n\n${data.joinUrl}`)}`
	);

	function enterSelect(p: MediaItem) {
		selecting = true;
		selected.add(p.id);
	}
	function toggleSelect(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
		if (selected.size === 0) selecting = false;
	}
	function tileTap(p: MediaItem) {
		if (selecting) toggleSelect(p.id);
		else openLightbox(p);
	}
	function exitSelect() {
		selecting = false;
		selected.clear();
	}

	// Native share of a set of media files (falls back to the zip download).
	async function shareFiles(photos: MediaItem[]) {
		if (!photos.length) return;
		const fallback = () => (location.href = `/a/${slug}/download?scope=ids&ids=${photos.map((p) => p.id).join(',')}`);
		if (photos.length > 10 || photos.reduce((total, photo) => total + photo.sizeBytes, 0) > 100 * 1024 * 1024) {
			fallback();
			return;
		}
		try {
			const files: File[] = [];
			for (const photo of photos) {
				// The file as uploaded, not a video's playback copy.
				const res = await fetch(photo.download);
				if (!res.ok) throw new Error('media fetch failed');
				const blob = await res.blob();
				files.push(new File([blob], `${photo.id}.${blob.type.split('/')[1] || 'bin'}`, { type: blob.type }));
			}
			if (navigator.canShare?.({ files })) await navigator.share({ files, title: data.albumName });
			else fallback();
		} catch {
			/* user cancelled */
		}
	}
	const shareSelected = () => shareFiles([...selected].map((id) => allById.get(id)).filter(Boolean) as MediaItem[]);

	async function deleteMediaItem(p: MediaItem) {
		if (!confirm(t('board.deletePhotoConfirm'))) return;
		try {
			const res = await fetch(`/a/${slug}/delete`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaItemId: p.id })
			});
			if (!res.ok) throw new Error();
			// Rejecting a pending upload keeps the viewer open on the next one in the queue.
			if (p.approved) lightboxIndex = -1;
			await refreshAll();
			endReviewIfDone();
			toast(t('board.toast.deleted'));
		} catch {
			toast(t('board.toast.couldNotDelete'));
		}
	}

	/** Leave the pending-only view once the queue is empty, instead of an empty screen. */
	function endReviewIfDone() {
		lightboxIndex = Math.min(lightboxIndex, flat.length - 1); // the last item left the list
		if (filter.type === 'pending' && data.pendingCount === 0) {
			lightboxIndex = -1;
			setFilter('all');
		}
	}

	async function approveMediaItem(p: MediaItem) {
		try {
			const res = await fetch(`/a/${slug}/approve`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaItemId: p.id })
			});
			if (!res.ok) throw new Error();
			// Stay in the viewer: while reviewing, the next pending item slides into place.
			await refreshAll();
			endReviewIfDone();
			toast(t('board.toast.approved'));
		} catch {
			toast(t('board.toast.couldNotApprove'));
		}
	}

	function selectMoment(i: number) {
		activeMoment = i;
		document.getElementById(`m${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		history.replaceState(history.state, '', `#m${i}`);
	}

	// Restore the selected moment from the URL hash on refresh.
	onMount(() => {
		// Web Share API needs a secure context (https / localhost).
		canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
		const h = location.hash.match(/^#m(\d+)$/);
		if (h) {
			const i = Number(h[1]);
			activeMoment = i;
			requestAnimationFrame(() => document.getElementById(`m${i}`)?.scrollIntoView({ block: 'start' }));
		}
	});

	// Highlight the moment chip for whatever section is on screen.
	$effect(() => {
		void data.moments.length; // touch to re-run when moments change
		const sections = Array.from(document.querySelectorAll<HTMLElement>('section.moment'));
		const obs = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						const i = Number((e.target as HTMLElement).dataset.i);
						if (!Number.isNaN(i)) activeMoment = i;
					}
				}
			},
			{ rootMargin: '-45% 0px -50% 0px' }
		);
		sections.forEach((s) => obs.observe(s));
		return () => obs.disconnect();
	});

	function openShare() {
		shareMomentId = data.moments[activeMoment]?.id ?? data.moments[0]?.id ?? '';
		shareOpen = true;
	}
	function skipMsg(reason: string, maxMb?: number, maxMegapixels?: number): string {
		if (reason === 'too_large') return t('board.upload.tooLarge', { max: maxMb ?? '?' });
		if (reason === 'too_many_pixels') return t('board.upload.tooManyPixels', { max: maxMegapixels ?? '?' });
		if (reason === 'over_quota') return t('board.upload.overQuota');
		if (reason === 'unsupported') return t('board.upload.unsupported');
		if (reason === 'empty') return t('board.upload.empty');
		return t('board.upload.failed');
	}
	// Transient failures (proxy resets, 429/502/503/504 while the server is busy) are
	// retried with jittered exponential backoff instead of discarding the upload.
	const RETRYABLE = new Set([408, 429, 502, 503, 504]);
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	// `patienceMs` replaces the attempt count with a time budget: keep trying for that
	// long after the first failure. A phone that loses signal in a lift or hops from
	// Wi-Fi to mobile data is offline for far longer than six quick attempts (~15 s),
	// and giving up there threw away a gigabyte that was already on the server.
	async function fetchWithRetry(
		input: string,
		init: () => Parameters<typeof fetch>[1],
		{
			attempts = 6,
			signal,
			patienceMs,
			timeoutMs,
			onTrouble
		}: {
			attempts?: number;
			signal?: AbortSignal;
			patienceMs?: number;
			timeoutMs?: number;
			onTrouble?: (failing: boolean) => void;
		} = {}
	): Promise<Response> {
		let rateWaits = 0;
		let failingSince = 0;
		const spent = (attempt: number) =>
			patienceMs ? Date.now() - (failingSince ||= Date.now()) >= patienceMs : attempt >= attempts;
		// A connection that dies without telling the browser (a phone leaving Wi-Fi, a
		// proxy that vanishes) leaves fetch waiting for good: no error, so no retry, and
		// the progress bar simply stops. `timeoutMs` turns that silence into a failed
		// attempt, which the loop below retries like any other.
		const attemptFetch = async () => {
			if (!timeoutMs) return fetch(input, { ...init(), signal });
			const attemptAbort = new AbortController();
			const cancel = () => attemptAbort.abort();
			signal?.addEventListener('abort', cancel, { once: true });
			const timer = setTimeout(cancel, timeoutMs);
			try {
				return await fetch(input, { ...init(), signal: attemptAbort.signal });
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener('abort', cancel);
			}
		};
		for (let attempt = 1; ; attempt++) {
			try {
				const res = await attemptFetch();
				// A rate limit says exactly when to come back: wait the window out (a few
				// times at most) rather than burning the short backoff budget and failing.
				if (res.status === 429 && rateWaits < 3) {
					const hint = Number(
						(
							await res
								.clone()
								.json()
								.catch(() => null)
						)?.retryAfter
					);
					if (Number.isFinite(hint) && hint > 0) {
						rateWaits++;
						attempt--;
						await sleep((Math.min(hint, 120) + Math.random()) * 1000);
						if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
						continue;
					}
				}
				if (!RETRYABLE.has(res.status) || spent(attempt)) {
					if (failingSince) onTrouble?.(false);
					return res;
				}
			} catch (err) {
				if (signal?.aborted || spent(attempt)) throw err;
			}
			onTrouble?.(true);
			// With a time budget, cap the pause low and wake the moment the device reports
			// it is back online, so the upload resumes without the user doing anything.
			const pause = Math.min(patienceMs ? 8_000 : 30_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random());
			await Promise.race([
				sleep(pause),
				...(patienceMs ? [new Promise((r) => addEventListener('online', r, { once: true }))] : [])
			]);
			if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		}
	}

	const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?)$/i;
	async function onFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		if (!files.length) return;
		shareOpen = false;
		busy = true;
		const problems: string[] = [];
		try {
			// Some browsers report no MIME type for HEIC/AVIF picked from disk; the server
			// sniffs the real format, so go by extension rather than dropping the file.
			const images = files.filter((f) => f.type.startsWith('image/') || (!f.type && IMAGE_EXT.test(f.name)));
			const videos = files.filter((f) => f.type.startsWith('video/'));
			if (images.length + videos.length < files.length) problems.push(t('board.upload.notMedia'));
			let added = 0;
			// How many of them only the uploader and the owner can see until approved.
			let pending = 0;
			batchDone = 0;
			batchTotal = images.length + videos.length;
			for (const image of images) {
				const clientId = crypto.randomUUID(); // idempotency key: a retried upload is not a duplicate
				const res = await fetchWithRetry(`/a/${slug}/upload`, () => {
					const fd = new FormData();
					fd.append('clientId', clientId);
					fd.append('momentId', shareMomentId);
					fd.append('photos', image);
					return { method: 'POST', body: fd };
				});
				const out = await res.json().catch(() => ({}));
				if (res.ok) {
					added += out.added ?? 0;
					pending += out.pending ?? 0;
					for (const s of out.skipped ?? []) problems.push(skipMsg(s.reason, out.maxUploadMb, out.maxMegapixels));
				} else {
					problems.push(out.message || t('board.upload.photoFailed'));
				}
				batchDone++;
			}
			for (const v of videos) {
				try {
					const outcome = await processVideo(v);
					if (outcome !== 'skipped') added++;
					if (outcome === 'pending') pending++;
				} catch (err) {
					problems.push(err instanceof Error ? err.message : t('board.toast.couldNotAdd', { name: v.name }));
				}
				batchDone++;
			}
			// Refreshing the album is a courtesy. On a connection that has gone silent it
			// never returns, and the button would read "Uploading…" until the page is reloaded.
			await Promise.race([refreshAll(), sleep(20_000)]);
			const uniq = [...new Set(problems)];
			if (added && !uniq.length && pending)
				// Say what really happened: it is in, but the group cannot see it yet.
				toast(added > 1 ? t('board.toast.pendingItems', { n: added }) : t('board.toast.pendingItem'));
			else if (added && !uniq.length)
				toast(added > 1 ? t('board.toast.addedItems', { n: added }) : t('board.toast.addedItem', { n: added }));
			else if (added) toast(t('board.toast.addedOne', { n: added, name: uniq[0] }));
			else toast(uniq[0] ?? t('board.toast.nothingAdded'));
		} catch {
			toast(t('board.toast.uploadFailed'));
		} finally {
			busy = false;
		}
	}

	/**
	 * A phone that locks its screen suspends the page and the upload with it. Ask the
	 * browser to keep the screen on while a video is going up (it may refuse, e.g. on
	 * low battery; the retry logic then picks the upload up when the page wakes).
	 */
	async function keepScreenAwake(): Promise<{ release: () => void }> {
		let lock: WakeLockSentinel | null = null;
		let done = false;
		const acquire = async () => {
			if (done || document.visibilityState !== 'visible') return;
			try {
				lock = (await navigator.wakeLock?.request('screen')) ?? null;
			} catch {
				/* not supported or not allowed right now */
			}
		};
		// The browser drops the lock whenever the tab is hidden; take it again on return.
		document.addEventListener('visibilitychange', acquire);
		await acquire();
		return {
			release: () => {
				done = true;
				document.removeEventListener('visibilitychange', acquire);
				void lock?.release().catch(() => {});
			}
		};
	}

	function cancelUpload() {
		uploadCanceled = true;
		uploadAbort?.abort();
	}

	// Upload a video by streaming the ORIGINAL to the server in <100 MB chunks (the proxy
	// caps a single request body at ~100 MB), then asking the server to reassemble +
	// optimize. Returns 'added' | 'pending' (added, awaiting the owner's approval) |
	// 'skipped' (cancel); throws with a message on hard failure.
	async function processVideo(file: File): Promise<'added' | 'pending' | 'skipped'> {
		const initRes = await fetch(`/a/${slug}/video/init`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				momentId: shareMomentId,
				mime: file.type || 'video/mp4',
				totalBytes: file.size,
				name: file.name
			})
		});
		if (!initRes.ok) {
			const e = await initRes.json().catch(() => null);
			throw new Error(e?.message || t('board.upload.couldNotStart'));
		}
		const { uploadId, chunkSize } = await initRes.json();
		const total = Math.max(1, Math.ceil(file.size / chunkSize));

		uploadPct = 0;
		uploadStage = 'uploading';
		reconnecting = false;
		uploadCanceled = false;
		uploadAbort = new AbortController();
		uploading = true;
		const awake = await keepScreenAwake();
		try {
			for (let i = 0; i < total; i++) {
				const blob = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize));
				const r = await fetchWithRetry(
					`/a/${slug}/video/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${i}`,
					() => ({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob }),
					// Chunks are idempotent on the server, so resending one after a dropped
					// connection is always safe; the upload carries on from where it stopped.
					{
						signal: uploadAbort.signal,
						patienceMs: OUTAGE_PATIENCE_MS,
						timeoutMs: CHUNK_TIMEOUT_MS,
						onTrouble: (bad) => (reconnecting = bad)
					}
				);
				if (!r.ok) throw new Error(t('board.upload.chunkFailed'));
				uploadPct = Math.min(99, Math.round(((i + 1) / total) * 100));
			}
			awake.release(); // the server has everything; the phone may sleep again
			// Completion runs server-side in the background: 202 means "still assembling /
			// optimising", so poll until 200 (or a real error) instead of timing out.
			// The server bounds the work itself (queue wait plus a size-based encode limit);
			// this is only a last-resort stop for a tab left open on a dead server.
			const deadline = Date.now() + 4 * 60 * 60_000;
			let cr: Response;
			for (;;) {
				cr = await fetchWithRetry(
					`/a/${slug}/video/complete`,
					() => ({
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ uploadId })
					}),
					{ patienceMs: OUTAGE_PATIENCE_MS, timeoutMs: POLL_TIMEOUT_MS, onTrouble: (bad) => (reconnecting = bad) }
				);
				if (cr.status !== 202) break;
				// Show what the server is doing: without this the bar sat at 99% for the
				// whole compression, which reads as "stuck" on a ten-minute job.
				const info = await cr.json().catch(() => null);
				const phase = info?.status === 'waiting' ? 'waiting' : info?.phase;
				uploadStage = ['waiting', 'queued', 'compressing', 'saving'].includes(phase) ? phase : 'assembling';
				if (uploadStage === 'compressing') uploadPct = Math.max(0, Math.min(100, Number(info?.percent) || 0));
				if (Date.now() > deadline) throw new Error(t('board.upload.finalizeFailed'));
				await sleep(3_000);
			}
			if (!cr.ok) {
				const e = await cr.json().catch(() => null);
				throw new Error(e?.message || t('board.upload.finalizeFailed'));
			}
			uploadPct = 100;
			const { mediaItemId, pending } = await cr.json();
			const poster = await makePoster(file).catch(() => null);
			if (poster && mediaItemId) {
				const fd = new FormData();
				fd.append('mediaItemId', mediaItemId);
				fd.append('poster', poster, 'poster.webp');
				await fetch(`/a/${slug}/poster`, { method: 'POST', body: fd });
			}
			return pending ? 'pending' : 'added';
		} catch (err) {
			// Best-effort: tell the server to drop the staged chunks.
			fetch(`/a/${slug}/video/abort?uploadId=${encodeURIComponent(uploadId)}`, {
				method: 'POST'
			}).catch(() => {});
			if (uploadCanceled) {
				toast(t('board.toast.uploadCanceled'));
				return 'skipped';
			}
			throw err;
		} finally {
			awake.release();
			uploading = false;
			uploadAbort = null;
		}
	}

	// Grab a mid-clip frame client-side as the poster (no server ffmpeg needed).
	function makePoster(file: File): Promise<Blob> {
		return new Promise((resolve, reject) => {
			const url = URL.createObjectURL(file);
			const v = document.createElement('video');
			v.preload = 'metadata';
			v.muted = true;
			v.playsInline = true;
			v.src = url;
			v.onloadedmetadata = () => {
				try {
					v.currentTime = Math.min(1, (v.duration || 2) / 2);
				} catch {
					/* ignore */
				}
			};
			v.onseeked = () => {
				const sourceWidth = v.videoWidth || 640;
				const sourceHeight = v.videoHeight || 640;
				const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
				const w = Math.max(1, Math.round(sourceWidth * scale));
				const h = Math.max(1, Math.round(sourceHeight * scale));
				const c = document.createElement('canvas');
				c.width = w;
				c.height = h;
				const ctx = c.getContext('2d');
				if (!ctx) {
					URL.revokeObjectURL(url);
					reject(new Error('no canvas'));
					return;
				}
				ctx.drawImage(v, 0, 0, w, h);
				c.toBlob(
					(b) => {
						URL.revokeObjectURL(url);
						if (b) resolve(b);
						else reject(new Error('no blob'));
					},
					'image/webp',
					0.7
				);
			};
			v.onerror = () => {
				URL.revokeObjectURL(url);
				reject(new Error('video error'));
			};
		});
	}

	// Optimistically toggle the favourite, then reconcile with the server.
	async function toggleFavorite(p: { id: string; favorited: boolean }) {
		const next = !isFavorite(p);
		favoriteOverride = { ...favoriteOverride, [p.id]: next };
		try {
			const res = await fetch(`/a/${slug}/favorite`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaItemId: p.id, favorited: next })
			});
			// A 429/403/404 body has no `favorited`; treat it as a failure, not a silent revert.
			if (!res.ok) throw new Error('favorite failed');
			const out = await res.json();
			favoriteOverride = { ...favoriteOverride, [p.id]: Boolean(out.favorited) };
		} catch {
			favoriteOverride = { ...favoriteOverride, [p.id]: p.favorited };
			toast(t('board.toast.favFailed'));
		}
	}

	async function shareLink() {
		const url = data.joinUrl;
		const payload = {
			title: t('board.share.nativeTitle', { album: data.albumName }),
			text: t('board.share.nativeText', { album: data.albumName }),
			url
		};
		if (navigator.share) {
			try {
				await navigator.share(payload);
			} catch {
				/* user cancelled */
			}
		} else {
			copyLink();
		}
	}
	async function copyLink() {
		try {
			await navigator.clipboard.writeText(data.joinUrl);
			toast(t('board.toast.linkCopied'));
		} catch {
			toast(t('board.toast.copyFailed'));
		}
	}

	// Live theme preview while the personalize sheet is open.
	function appEl() {
		return document.querySelector('.app') as HTMLElement | null;
	}
	function applyPreview() {
		appEl()?.setAttribute('style', tokensToStyle(resolveTokens(editSkin, editAccent, normalizeTheme(data.theme))));
	}
	function revertPreview() {
		appEl()?.setAttribute('style', data.themeStyle);
	}
	function openEdit() {
		editSkin = data.skin;
		editAccent = data.accent ?? SKIN_LIST.find((s) => s.id === data.skin)?.accent ?? '#4f8cff';
		editOpen = true;
	}
	function closeEdit() {
		editOpen = false;
		revertPreview();
	}
	function pickSkin(id: string) {
		editSkin = id;
		editAccent = SKIN_LIST.find((s) => s.id === id)?.accent ?? editAccent;
		applyPreview();
	}

	function openLightbox(p: MediaItem) {
		const i = flat.findIndex((x) => x.id === p.id);
		lightboxIndex = i >= 0 ? i : 0;
	}
	const lightboxNext = () => (lightboxIndex = Math.min(lightboxIndex + 1, flat.length - 1));
	const lightboxPrev = () => (lightboxIndex = Math.max(lightboxIndex - 1, 0));

	let heartPop = $state(false);
	function likeWithPop() {
		if (!lightboxPhoto) return;
		if (!isFavorite(lightboxPhoto)) {
			heartPop = true;
			setTimeout(() => (heartPop = false), 650);
		}
		toggleFavorite(lightboxPhoto);
	}

	let touchX = 0;
	function onTouchStart(e: TouchEvent) {
		touchX = e.changedTouches[0].clientX;
	}
	function onTouchEnd(e: TouchEvent) {
		const dx = e.changedTouches[0].clientX - touchX;
		if (dx > 45) lightboxPrev();
		else if (dx < -45) lightboxNext();
	}

	function onKey(e: KeyboardEvent) {
		if (lightboxIndex >= 0) {
			if (e.key === 'ArrowRight') lightboxNext();
			else if (e.key === 'ArrowLeft') lightboxPrev();
			else if (e.key === 'Escape') lightboxIndex = -1;
		} else if (e.key === 'Escape' && selecting) {
			// Open sheets close themselves on Escape (see Sheet.svelte).
			exitSelect();
		}
	}
</script>

<svelte:head><title>{data.albumName} · Mira</title></svelte:head>
<svelte:window onkeydown={onKey} bind:innerWidth={vw} />

<nav class="topnav" aria-label={t('board.nav.album')}>
	<!-- The album's name leads the page: a guest arriving from a link must see where
	     they are, not just "Moment 1". -->
	<div class="toprow">
		{#if data.isUser}
			<a class="iconbtn" href="/" aria-label={t('board.nav.myAlbums')} title={t('board.nav.myAlbums')}
				><ArrowLeft size={18} /></a
			>
		{/if}
		<h1 class="albumtitle">{data.albumName}</h1>
		<button class="iconbtn" aria-label={t('board.nav.menu')} onclick={() => (menuOpen = true)}
			><Ellipsis size={18} /></button
		>
	</div>
	<div class="crumbs">
		{#each data.moments as m, i (m.id)}
			<button
				class="chip {i === activeMoment ? 'active' : ''}"
				onclick={() => selectMoment(i)}
				use:longpress={{ onpress: () => openRenameMoment(m), enabled: () => data.isOwner }}
			>
				{m.name}<span class="n">{m.count}</span>
			</button>
			{#if data.isOwner && i === activeMoment}
				<!-- Long-press on the chip still works, but nothing hints at it: give the
				     owner a visible way to rename the selected moment. -->
				<button
					class="chipedit"
					aria-label={t('board.rename.title')}
					title={t('board.rename.title')}
					onclick={() => openRenameMoment(m)}><Pencil size={14} /></button
				>
			{/if}
		{/each}
	</div>
</nav>
{#if data.isOwner && data.pendingCount > 0 && filter.type === 'all'}
	<!-- Pending uploads sort into the timeline like everything else, so without this the
	     owner has to scroll the whole album hunting for "Pending" badges. -->
	<div class="filterbar">
		<span><b>{t('board.pendingBanner', { n: data.pendingCount })}</b></span>
		<button onclick={() => setFilter('pending')}>{t('board.pendingReview')}</button>
	</div>
{/if}
{#if data.locked}
	<div class="filterbar" role="status">
		<span><Lock size={13} /> {t('board.closed.banner')}</span>
	</div>
{/if}
{#if !data.isOwner && data.pendingCount > 0 && filter.type === 'all'}
	<!-- A guest's own upload is in, but nobody else sees it yet. Say so, or they will
	     ask the person next to them why it is not there. -->
	<div class="filterbar" role="status">
		<span
			>{data.pendingCount === 1 ? t('board.myPending.one') : t('board.myPending.many', { n: data.pendingCount })}</span
		>
	</div>
{/if}
{#if filter.type !== 'all'}
	<div class="filterbar">
		<span>{t('board.filter.showing')} <b>{filterLabel}</b></span>
		<button onclick={() => setFilter('all')}>{t('board.filter.clear')}</button>
	</div>
{/if}

<main>
	{#if data.totalItems === 0 && !preparing.length}
		<div class="hero">
			<div class="big"><Images size={46} strokeWidth={1.5} /></div>
			<h3>{t('board.empty.title')}</h3>
			<p>{t('board.empty.body')}</p>
			<!-- An album is only worth something once other people are in it. -->
			<button class="primary primary-icon heroinvite" onclick={() => (inviteOpen = true)}
				><UserPlus size={18} /> {t('board.action.invite')}</button
			>
		</div>
	{:else}
		{#each data.moments as m, i (m.id)}
			{@const shown = shownIn(m)}
			{@const waiting = preparingIn(m.id)}
			{#if shown.length || waiting.length}
				<section class="moment" id={`m${i}`} data-i={i}>
					<div class={layout === 'feed' ? 'feed' : 'grid'}>
						{#each shown as p (p.id)}
							{#if layout === 'feed'}
								<article class="feedcard {selecting && selected.has(p.id) ? 'sel' : ''} {!p.approved ? 'pending' : ''}">
									<button
										class="feedimg"
										aria-label={p.kind === 'video'
											? t('board.openVideoBy', { by: p.by })
											: t('board.openPhotoBy', { by: p.by })}
										use:longpress={{ onpress: () => enterSelect(p), enabled: () => !selecting }}
										onclick={() => tileTap(p)}
									>
										<img src={p.thumb} alt={t('board.by', { by: p.by })} loading="lazy" decoding="async" />
										{#if p.kind === 'video'}<span class="playbadge" aria-hidden="true"
												><Play size={16} fill="currentColor" /></span
											>{/if}{#if !p.approved}<span class="pendingbadge">{t('board.pending')}</span
											>{/if}{#if selecting}<span class="selmark {selected.has(p.id) ? 'on' : ''}"
												>{#if selected.has(p.id)}<Check size={15} />{/if}</span
											>{/if}
									</button>
									<div class="feedmeta">
										<span class="feedby">{p.by}</span>
										<button
											class="like {isFavorite(p) ? 'on' : ''}"
											aria-pressed={isFavorite(p)}
											aria-label={isFavorite(p) ? t('board.unlike') : t('board.like')}
											onclick={() => toggleFavorite(p)}
										>
											<span class="hicon"><Heart size={16} fill={isFavorite(p) ? 'currentColor' : 'none'} /></span>
											{#if likeCount(p) > 0}<span class="hcount">{likeCount(p)}</span>{/if}
										</button>
									</div>
								</article>
							{:else}
								<div class="tile {selecting && selected.has(p.id) ? 'sel' : ''} {!p.approved ? 'pending' : ''}">
									<button
										class="tile-open"
										aria-label={p.kind === 'video'
											? t('board.openVideoBy', { by: p.by })
											: t('board.openPhotoBy', { by: p.by })}
										use:longpress={{ onpress: () => enterSelect(p), enabled: () => !selecting }}
										onclick={() => tileTap(p)}
									>
										<img
											src={p.thumb}
											alt={t('board.by', { by: p.by })}
											loading="lazy"
											decoding="async"
											width="200"
											height="200"
										/>
									</button>
									{#if p.kind === 'video'}<span class="playbadge" aria-hidden="true"
											><Play size={16} fill="currentColor" /></span
										>{/if}{#if !p.approved}<span class="pendingbadge">{t('board.pending')}</span
										>{/if}{#if selecting}<span class="selmark {selected.has(p.id) ? 'on' : ''}"
											>{#if selected.has(p.id)}<Check size={15} />{/if}</span
										>{/if}
									<span class="by">{p.by}</span>
									<button
										class="like tilelike {isFavorite(p) ? 'on' : ''}"
										aria-pressed={isFavorite(p)}
										aria-label={isFavorite(p) ? t('board.unlike') : t('board.like')}
										onclick={() => toggleFavorite(p)}
									>
										<span class="hicon"><Heart size={16} fill={isFavorite(p) ? 'currentColor' : 'none'} /></span>
										{#if likeCount(p) > 0}<span class="hcount">{likeCount(p)}</span>{/if}
									</button>
								</div>
							{/if}
						{/each}
						{#each waiting as w (w.id)}
							<!-- A video still uploading or being compressed: everyone sees it is coming. -->
							<div class="tile preparing" role="status">
								<span class="prepspin" aria-hidden="true"><LoaderCircle size={22} /></span>
								<span class="preptext">{preparingLabel(w)}</span>
								{#if preparingStatus(w)}<span class="prepstatus">{preparingStatus(w)}</span>{/if}
							</div>
						{/each}
					</div>
				</section>
			{/if}
		{/each}
		{#if data.hasPreviousPage || data.hasNextPage}
			<nav class="pagination" aria-label={t('board.pagination.label')}>
				{#if data.hasPreviousPage}
					<a href={`/a/${data.slug}?page=${data.mediaPage - 1}`}>{t('board.pagination.previous')}</a>
				{/if}
				<span>{t('board.pagination.page', { n: data.mediaPage })}</span>
				{#if data.hasNextPage}
					<a href={`/a/${data.slug}?page=${data.mediaPage + 1}`}>{t('board.pagination.next')}</a>
				{/if}
			</nav>
		{/if}
		{#if filter.type !== 'all' && !flat.length}
			<div class="empty" style="margin: 28px 16px;">{t('board.nothingHere')}</div>
		{/if}
	{/if}
</main>

<div class="bar">
	{#if selecting}
		<button class="side" aria-label={t('board.select.cancel')} onclick={exitSelect}><X size={20} /></button>
		<span class="selinfo">{t('board.select.count', { n: selected.size })}</span>
		{#if canNativeShare}
			<button class="side" aria-label={t('board.select.share')} onclick={shareSelected} disabled={selected.size === 0}
				><Share2 size={20} /></button
			>
		{/if}
		<a
			class="side {selected.size === 0 ? 'disabled' : ''}"
			aria-label={t('board.select.download')}
			href={downloadSelectedUrl}
			download><Download size={20} /></a
		>
	{:else}
		{#if data.locked}
			<!-- A closed album takes nothing new; say so where "+ Share" used to be. -->
			<div class="share closednote"><Lock size={18} /> {t('board.closed.short')}</div>
		{:else}
			<button class="share" onclick={openShare} disabled={busy}>
				{#if busy}{batchTotal > 1
						? t('board.uploadingCount', { done: Math.min(batchDone + 1, batchTotal), total: batchTotal })
						: t('board.uploading')}{:else}<Plus size={20} /> {t('board.share')}{/if}
			</button>
		{/if}
		{#each alloc.visible as a (a.id)}
			{@const Icon = ACTION_ICON[a.id]}
			<!-- Icon plus a word: three bare icons beside Share were a guessing game. -->
			<button class="side labelled" aria-label={a.label} title={a.label} onclick={() => runAction(a.id)}
				><Icon size={19} /><span class="sidelabel">{ACTION_SHORT[a.id]?.() ?? a.label}</span></button
			>
		{/each}
	{/if}
</div>

<!-- hidden capture inputs -->
<input bind:this={camInput} type="file" accept="image/*" capture="environment" hidden onchange={onFiles} />
<input bind:this={libInput} type="file" accept="image/*,video/*" multiple hidden onchange={onFiles} />

{#if uploading}
	<div class="opt-overlay" role="status" aria-live="polite">
		<div class="opt-card">
			<div class="opt-title">{reconnecting ? t('board.video.reconnecting') : stageTitle}</div>
			<div class="opt-bar">
				<div class="opt-fill {measurable ? '' : 'busy'}" style={measurable ? `width:${uploadPct}%` : ''}></div>
			</div>
			<div class="opt-pct">{measurable ? `${uploadPct}%` : ' '}</div>
			<!-- Once the server has the whole file it finishes on its own, also while it
			     waits for a free slot, unless more files in this batch still have to go up. -->
			<p class="opt-note">
				{uploadStage === 'uploading' || batchDone + 1 < batchTotal
					? t('board.video.keepOpen')
					: t('board.video.canLeave')}
			</p>
			{#if uploadStage === 'uploading'}
				<div class="opt-actions">
					<button class="ghost" onclick={cancelUpload}>{t('board.cancelUpload')}</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<div class="toast {toastMsg ? 'show' : ''}" role="status" aria-live="polite">{toastMsg}</div>

{#if menuOpen}
	<Sheet title={data.albumName} label={t('board.menu.label')} onclose={() => (menuOpen = false)}>
		{#each alloc.overflow as a (a.id)}
			{@const Icon = ACTION_ICON[a.id]}
			<button class="row" onclick={() => runAction(a.id)}>
				<span class="ic"><Icon size={20} /></span><span class="m">{a.label}</span>
			</button>
		{/each}
		{#if data.isOwner && data.moments[activeMoment]}
			{@const current = data.moments[activeMoment]}
			<button
				class="row"
				onclick={() => {
					menuOpen = false;
					openRenameMoment(current);
				}}
			>
				<span class="ic"><Pencil size={20} /></span><span class="m"
					>{t('board.rename.title')}<small>{current.name}</small></span
				>
			</button>
		{/if}
		{#if data.isOwner}
			<form
				method="POST"
				action="?/setLocked"
				use:enhance={() =>
					async ({ update, result }) => {
						await update({ reset: false });
						if (result.type === 'success') {
							menuOpen = false;
							toast(data.locked ? t('board.toast.closed') : t('board.toast.reopened'));
						}
					}}
			>
				<input type="hidden" name="locked" value={data.locked ? '0' : '1'} />
				<button class="row" type="submit">
					{#if data.locked}
						<span class="ic"><LockOpen size={20} /></span><span class="m"
							>{t('board.menu.reopen')}<small>{t('board.menu.reopenSub')}</small></span
						>
					{:else}
						<span class="ic"><Lock size={20} /></span><span class="m"
							>{t('board.menu.close')}<small>{t('board.menu.closeSub')}</small></span
						>
					{/if}
				</button>
			</form>
			<button class="row" onclick={openReturn}>
				<span class="ic"><Smartphone size={20} /></span><span class="m"
					>{t('board.menu.letBackIn')}<small>{t('board.menu.letBackInSub')}</small></span
				>
			</button>
		{:else if iAmGuest}
			<button class="row" onclick={openReturn}>
				<span class="ic"><Smartphone size={20} /></span><span class="m"
					>{t('board.menu.moveDevice')}<small>{t('board.menu.moveDeviceSub')}</small></span
				>
			</button>
		{/if}
		{#if data.isUser}
			<a class="row" href="/" onclick={() => (menuOpen = false)}>
				<span class="ic"><Images size={20} /></span><span class="m"
					>{t('board.nav.myAlbums')}<small>{t('board.nav.myAlbumsSub')}</small></span
				>
			</a>
		{/if}
		<div class="menulang"><Preferences /></div>
		<button class="ghost" onclick={() => (menuOpen = false)}>{t('board.close')}</button>
	</Sheet>
{/if}

{#if inviteOpen}
	<Sheet title={t('board.invite.title')} onclose={() => (inviteOpen = false)}>
		<p class="hint">{t('board.invite.hint')}</p>
		{#if canNativeShare}
			<button class="primary primary-icon" onclick={shareLink}
				><Share2 size={18} /> {t('board.invite.shareLink')}</button
			>
		{/if}
		<div class="intents">
			<a class="intent" href={waUrl} target="_blank" rel="noopener"><MessageCircle size={17} /> WhatsApp</a>
			<a class="intent" href={tgUrl} target="_blank" rel="noopener"><Send size={17} /> Telegram</a>
			<a class="intent" href={smsUrl}><MessageSquare size={17} /> SMS</a>
			<a class="intent" href={mailUrl}><Mail size={17} /> {t('board.invite.email')}</a>
		</div>
		<button class="row" onclick={copyLink}>
			<span class="ic"><Link size={20} /></span>
			<span class="m">{t('board.invite.copyLink')}<small class="linkbox">{data.joinUrl}</small></span>
		</button>
		<img class="qr" src={data.qr} alt={t('board.invite.qrAlt')} width="200" height="200" />
		<p class="hint" style="text-align:center">{t('board.invite.scan')}</p>
		<a class="row" href={`/a/${slug}/card`}>
			<span class="ic"><Printer size={20} /></span><span class="m"
				>{t('board.invite.printCard')}<small>{t('board.invite.printCardSub')}</small></span
			>
		</a>
		{#if data.isOwner}
			<form
				method="POST"
				action="?/resetInvite"
				use:enhance={({ cancel }) => {
					if (!confirm(t('board.invite.resetConfirm'))) cancel();
					return async ({ update, result }) => {
						await update({ reset: false });
						if (result.type === 'success') toast(t('board.toast.linkReset'));
					};
				}}
			>
				<button class="row" type="submit">
					<span class="ic"><RefreshCw size={20} /></span><span class="m"
						>{t('board.invite.reset')}<small>{t('board.invite.resetSub')}</small></span
					>
				</button>
			</form>
		{/if}
		<button class="ghost" onclick={() => (inviteOpen = false)}>{t('board.done')}</button>
	</Sheet>
{/if}

{#if returnOpen}
	<Sheet
		title={data.isOwner ? t('board.menu.letBackIn') : t('board.menu.moveDevice')}
		onclose={() => (returnOpen = false)}
	>
		{#if returnInfo}
			<p class="hint">
				{returnInfo.self ? t('board.return.readySelf') : t('board.return.ready', { name: returnName })}
			</p>
			{#if returnInfo.self}
				<img class="qr" src={returnInfo.qr} alt="" width="200" height="200" />
			{/if}
			<button class="row" onclick={() => returnInfo && copyText(returnInfo.link)}>
				<span class="ic"><Link size={20} /></span>
				<span class="m">{t('board.invite.copyLink')}<small class="linkbox">{returnInfo.link}</small></span>
			</button>
		{:else}
			{#if data.isOwner}
				<p class="hint">{returnable.length ? t('board.return.pick') : t('board.return.none')}</p>
			{/if}
			<form
				method="POST"
				action="?/returnLink"
				use:enhance={() =>
					async ({ result }) => {
						if (result.type === 'success' && result.data?.returnLink) {
							returnInfo = result.data.returnLink as typeof returnInfo;
						} else toast(t('board.toast.copyFailed'));
					}}
			>
				{#if data.isOwner}
					{#each returnable as person (person.id)}
						<button class="row" type="submit" name="memberId" value={person.id}>
							<span class="ic"><User size={20} /></span><span class="m">{person.name}</span>
						</button>
					{/each}
				{:else}
					<p class="hint">{t('board.menu.moveDeviceSub')}</p>
					<button class="primary" type="submit" name="memberId" value={data.member.id}
						>{t('board.menu.moveDevice')}</button
					>
				{/if}
			</form>
		{/if}
		<button class="ghost" onclick={() => (returnOpen = false)}>{t('board.done')}</button>
	</Sheet>
{/if}

{#if filterOpen}
	<Sheet title={t('board.view.title')} label={t('board.view.label')} onclose={() => (filterOpen = false)}>
		<p class="hint">{t('board.view.layout')}</p>
		<Segmented
			bind:value={layout}
			options={[
				{ value: 'grid', label: t('board.view.grid'), icon: LayoutGrid },
				{ value: 'feed', label: t('board.view.feed'), icon: Rows3 }
			]}
		/>

		<p class="hint" style="margin-top: 14px;">{t('board.view.sort')}</p>
		<Segmented
			bind:value={sort}
			options={[
				{ value: 'timeline', label: t('board.view.timeline') },
				{ value: 'liked', label: t('board.view.mostLiked'), icon: Heart }
			]}
		/>

		<p class="hint" style="margin-top: 14px;">{t('board.view.show')}</p>
		<button class="row" onclick={() => setFilter('all')}>
			<span class="ic"><Images size={20} /></span><span class="m"
				>{t('board.view.all')}<small>{data.totalItems}</small></span
			>
		</button>
		<button class="row" onclick={() => setFilter('favs')}>
			<span class="ic"><Heart size={20} /></span><span class="m"
				>{t('board.view.likedByMe')}<small>{favoriteCount}</small></span
			>
		</button>
		{#if data.people.length > 1}
			{#each data.people as person (person.id)}
				<button class="row" onclick={() => setFilterMember(person.id)}>
					<span class="ic"><User size={20} /></span><span class="m">{person.name}<small>{person.count}</small></span>
				</button>
			{/each}
		{/if}
		<button class="ghost" onclick={() => (filterOpen = false)}>{t('board.done')}</button>
	</Sheet>
{/if}

{#if shareOpen}
	<Sheet title={t('board.share.title')} onclose={() => (shareOpen = false)}>
		<label class="field" for="momentsel">{t('board.share.moment')}</label>
		<select
			id="momentsel"
			value={shareMomentId}
			onchange={(e) => (shareMomentId = (e.target as HTMLSelectElement).value)}
		>
			{#each data.moments as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
		</select>
		<div style="height: 12px;"></div>
		<button class="row" onclick={() => camInput?.click()}>
			<span class="ic"><Camera size={20} /></span><span class="m"
				>{t('board.share.takePhoto')}<small>{t('board.share.takePhotoSub')}</small></span
			>
		</button>
		<button class="row" onclick={() => libInput?.click()}>
			<span class="ic"><Images size={20} /></span><span class="m"
				>{t('board.share.pick')}<small>{t('board.share.pickSub')}</small></span
			>
		</button>
		{#if data.videosReduced}<p class="hint">{t('board.share.videosReduced')}</p>{/if}
		<button class="ghost" onclick={() => (shareOpen = false)}>{t('board.cancel')}</button>
	</Sheet>
{/if}

{#if downloadOpen}
	<Sheet title={t('board.download.title')} onclose={() => (downloadOpen = false)}>
		<p class="hint">{t('board.download.hint')}</p>
		{#if data.videosInTwoSizes}
			<!-- The album holds videos in two sizes; the person downloading picks. -->
			<p class="hint" style="margin-top: 10px;">{t('board.download.videos')}</p>
			<Segmented
				bind:value={zipVideos}
				options={[
					{ value: 'original', label: t('board.download.videosOriginal') },
					{ value: 'copy', label: t('board.download.videosCopy') }
				]}
			/>
			<p class="hint">{t('board.download.videosHint')}</p>
		{/if}
		{#if !downloadByPerson}
			<a class="row" href={`/a/${slug}/download?scope=album${zipSize}`} onclick={() => (downloadOpen = false)}>
				<span class="ic"><Images size={20} /></span><span class="m"
					>{t('board.download.whole')}<small>{t('board.download.items', { n: data.totalItems })}</small></span
				>
			</a>
			<a class="row" href={`/a/${slug}/download?scope=favs${zipSize}`} onclick={() => (downloadOpen = false)}>
				<span class="ic"><Heart size={20} /></span><span class="m"
					>{t('board.download.myFavs')}<small>{t('board.download.items', { n: favoriteCount })}</small></span
				>
			</a>
			<button class="row" onclick={() => (downloadByPerson = true)}>
				<span class="ic"><User size={20} /></span><span class="m"
					>{t('board.download.byPerson')}<small>{t('board.download.friends', { n: data.people.length })}</small></span
				>
			</button>
		{:else}
			{#each data.people as person (person.id)}
				<a
					class="row"
					href={`/a/${slug}/download?scope=member&id=${person.id}${zipSize}`}
					onclick={() => (downloadOpen = false)}
				>
					<span class="ic"><User size={20} /></span><span class="m"
						>{person.name}<small>{t('board.download.items', { n: person.count })}</small></span
					>
				</a>
			{/each}
			<button class="ghost" onclick={() => (downloadByPerson = false)}>{t('board.back')}</button>
		{/if}
		<button class="ghost" onclick={() => (downloadOpen = false)}>{t('board.cancel')}</button>
	</Sheet>
{/if}

{#if renameOpen}
	<Sheet title={t('board.rename.title')} autofocus onclose={() => (renameOpen = false)}>
		<p class="hint">{t('board.rename.hint')}</p>
		<form
			method="POST"
			action="?/renameMoment"
			use:enhance={() =>
				async ({ update, result }) => {
					await update({ reset: false });
					if (result.type === 'success') {
						renameOpen = false;
						toast(t('board.toast.renamed'));
					}
				}}
		>
			<input type="hidden" name="momentId" value={renameMomentId} />
			<label class="field" for="momrename">{t('board.name')}</label>
			<input id="momrename" type="text" name="name" maxlength="120" bind:value={renameMomentName} required />
			<button class="primary" type="submit">{t('board.rename.save')}</button>
		</form>
		<button class="ghost" onclick={() => (renameOpen = false)}>{t('board.cancel')}</button>
	</Sheet>
{/if}

{#if momentOpen}
	<Sheet title={t('board.moment.title')} autofocus onclose={() => (momentOpen = false)}>
		<p class="hint">{t('board.moment.hint')}</p>
		<form
			method="POST"
			action="?/createMoment"
			use:enhance={() =>
				async ({ update, result }) => {
					await update();
					if (result.type === 'success') {
						momentOpen = false;
						toast(t('board.toast.momentAdded'));
					}
				}}
		>
			<label class="field" for="momname">{t('board.name')}</label>
			<input
				id="momname"
				type="text"
				name="name"
				maxlength="120"
				placeholder={t('board.moment.placeholder')}
				required
			/>
			<button class="primary" type="submit">{t('board.moment.add')}</button>
		</form>
		<button class="ghost" onclick={() => (momentOpen = false)}>{t('board.cancel')}</button>
	</Sheet>
{/if}

{#if editOpen}
	<Sheet title={t('board.personalize.title')} onclose={closeEdit}>
		<p class="hint">{t('board.personalize.hint')}</p>
		<form
			method="POST"
			action="?/personalize"
			use:enhance={() =>
				async ({ update, result }) => {
					await update({ reset: false });
					if (result.type === 'success') {
						editOpen = false;
						toast(t('board.toast.saved'));
					}
				}}
		>
			<label class="field" for="albname">{t('board.personalize.albumName')}</label>
			<input id="albname" type="text" name="name" maxlength="120" value={data.albumName} />

			<div class="field">{t('board.personalize.skin')}</div>
			<div class="skins">
				{#each SKIN_LIST as s (s.id)}
					<button type="button" class="skin {editSkin === s.id ? 'on' : ''}" onclick={() => pickSkin(s.id)}>
						<span class="chipimg" style={`background:${s.bg}`}>
							<span class="dotacc" style={`background:${s.accent}`}></span>
						</span>
						{s.name}
					</button>
				{/each}
			</div>

			<label class="field" for="acc">{t('board.personalize.accent')}</label>
			<input
				id="acc"
				type="color"
				name="accent"
				value={editAccent}
				oninput={(e) => {
					editAccent = (e.target as HTMLInputElement).value;
					applyPreview();
				}}
				style="width: 48px; height: 38px; border: none; background: none;"
			/>

			<input type="hidden" name="skin" value={editSkin} />
			<button class="primary" type="submit">{t('board.save')}</button>
		</form>
		<button class="ghost" onclick={closeEdit}>{t('board.cancel')}</button>
	</Sheet>
{/if}

{#if lightboxPhoto}
	<div class="lb" role="dialog" aria-modal="true" aria-label={t('board.lightbox.label')}>
		<div class="top">
			<span
				>{t('board.by', { by: lightboxPhoto.by })} · <span class="count">{lightboxIndex + 1}/{flat.length}</span></span
			>
			<button style="color:#fff" aria-label={t('board.lightbox.close')} onclick={() => (lightboxIndex = -1)}
				><X size={22} /></button
			>
		</div>
		{#if lightboxIndex > 0}
			<button class="nav prev" aria-label={t('board.lightbox.prev')} onclick={lightboxPrev}
				><ChevronLeft size={26} /></button
			>
		{/if}
		{#if lightboxIndex < flat.length - 1}
			<button class="nav next" aria-label={t('board.lightbox.next')} onclick={lightboxNext}
				><ChevronRight size={26} /></button
			>
		{/if}
		{#if lightboxPhoto.kind === 'video'}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				class="lbvideo"
				src={lightboxPhoto.full}
				poster={lightboxPhoto.thumb}
				controls
				playsinline
				preload="metadata"
				ontouchstart={onTouchStart}
				ontouchend={onTouchEnd}
			></video>
		{:else}
			<!-- Originals can be tens of MB: paint the already-cached thumbnail underneath so
			     the viewer is never an empty black screen while the full file downloads. -->
			<img
				src={lightboxPhoto.full}
				style={`background: url("${lightboxPhoto.thumb}") center / contain no-repeat`}
				alt={t('board.by', { by: lightboxPhoto.by })}
				ondblclick={likeWithPop}
				ontouchstart={onTouchStart}
				ontouchend={onTouchEnd}
			/>
		{/if}
		{#if heartPop}<div class="heartpop" aria-hidden="true"><Heart size={120} fill="currentColor" /></div>{/if}
		<p class="lbfacts">
			<span>{whenText(lightboxPhoto)}</span>
			{#if lightboxPlace}
				<span aria-hidden="true">·</span>
				<a
					class="lbplace"
					href={mapUrl(lightboxPlace)}
					target="_blank"
					rel="noopener noreferrer"
					title={t('board.lightbox.openMap')}
					aria-label={t('board.lightbox.openMap')}
					><MapPin size={13} /> {lightboxPlace.lat.toFixed(4)}, {lightboxPlace.lon.toFixed(4)}</a
				>{/if}
		</p>
		{#if !lightboxPhoto.approved}
			<p class="lbfacts">
				{data.isOwner ? t('board.pendingOwner', { by: lightboxPhoto.by }) : t('board.pendingMine')}
			</p>
		{/if}
		{#if lightboxPhoto.kind === 'video'}<p class="lbfacts">{videoFacts(lightboxPhoto)}</p>{/if}
		{#if sizeChoiceOpen && lightboxPhoto.copyBytes !== null}
			<div class="lbsizes">
				<a href={lightboxPhoto.download} download onclick={() => (sizeChoiceOpen = false)}>
					<b>{t('board.lightbox.sizeOriginal')}</b>
					<small>{formatBytes(lightboxPhoto.sizeBytes, data.locale)}</small>
				</a>
				<a href={lightboxPhoto.downloadCopy} download onclick={() => (sizeChoiceOpen = false)}>
					<b>{t('board.lightbox.sizeCopy')}</b>
					<small>{formatBytes(lightboxPhoto.copyBytes, data.locale)}</small>
				</a>
			</div>
		{/if}
		<div class="acts">
			{#if data.isOwner && !lightboxPhoto.approved}
				<button onclick={() => lightboxPhoto && approveMediaItem(lightboxPhoto)}>
					<span class="ico"><Check size={24} /></span>{t('board.lightbox.approve')}
				</button>
				<button onclick={() => lightboxPhoto && deleteMediaItem(lightboxPhoto)}>
					<span class="ico"><Trash2 size={22} /></span>{t('board.lightbox.reject')}
				</button>
			{:else}
				<button onclick={() => lightboxPhoto && toggleFavorite(lightboxPhoto)}>
					<span class="ico {isFavorite(lightboxPhoto) ? 'on' : ''}"
						><Heart size={24} fill={isFavorite(lightboxPhoto) ? 'currentColor' : 'none'} /></span
					>
					{isFavorite(lightboxPhoto) ? t('board.liked') : t('board.like')}{#if likeCount(lightboxPhoto) > 0}
						· {likeCount(lightboxPhoto)}{/if}
				</button>
				{#if canNativeShare}
					<button onclick={() => lightboxPhoto && shareFiles([lightboxPhoto])}>
						<span class="ico"><Share2 size={22} /></span>{t('board.share')}
					</button>
				{/if}
				{#if lightboxPhoto.copyBytes !== null}
					<!-- Two sizes exist: ask which, rather than decide for them. -->
					<button aria-expanded={sizeChoiceOpen} onclick={() => (sizeChoiceOpen = !sizeChoiceOpen)}>
						<span class="ico"><Download size={22} /></span>{t('board.action.download')}
					</button>
				{:else}
					<a class="lbdl" href={lightboxPhoto.download} download>
						<span class="ico"><Download size={22} /></span>{t('board.action.download')}
					</a>
				{/if}
				{#if lightboxPhoto.memberId === data.member.id || data.isOwner}
					<button onclick={() => lightboxPhoto && deleteMediaItem(lightboxPhoto)}>
						<span class="ico"><Trash2 size={22} /></span>{t('board.lightbox.delete')}
					</button>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	.closednote {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		background: var(--surface-2);
		color: var(--muted);
		box-shadow: none;
	}
	.heroinvite {
		width: auto;
		margin: 4px auto 0;
		padding: 13px 22px;
	}
	.lbfacts > * + * {
		margin-left: 0.35em;
	}
	/* the two sizes of a video, side by side, when Download is tapped */
	.lbsizes {
		display: flex;
		justify-content: center;
		gap: 10px;
		padding: 12px 16px 0;
	}
	.lbsizes a {
		flex: 1;
		max-width: 190px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 12px;
		border-radius: 12px;
		border: 1px solid rgba(255, 255, 255, 0.35);
		color: #fff;
		text-align: center;
		font-size: 13.5px;
	}
	.lbsizes small {
		font-size: 12px;
		opacity: 0.8;
	}
	.lbplace {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	/* a video on its way: a quiet tile that says whose it is and how far along */
	.tile.preparing {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 8px;
		text-align: center;
		color: var(--muted);
		background: color-mix(in srgb, var(--accent) 7%, var(--surface-2));
	}
	.feed .tile.preparing {
		aspect-ratio: 16 / 9;
	}
	.prepspin {
		display: grid;
		animation: prep-turn 1.1s linear infinite;
	}
	.preptext {
		font-size: 11.5px;
		font-weight: 600;
		line-height: 1.25;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.prepstatus {
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	@keyframes prep-turn {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.prepspin {
			animation: none;
		}
	}
	.menulang {
		display: flex;
		justify-content: center;
		margin: 14px 0 4px;
	}
	.pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 18px;
		margin: 24px 16px 96px;
	}
	.pagination a {
		color: var(--accent-text);
		font-weight: 700;
		text-decoration: none;
	}
	/* Full-screen upload progress, with a cancel action. */
	.opt-overlay {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: center;
		background: color-mix(in srgb, var(--bg, #000) 70%, transparent);
		backdrop-filter: blur(3px);
	}
	.opt-card {
		width: min(320px, 84vw);
		background: var(--surface, #fff);
		color: var(--ink, #111);
		border-radius: 16px;
		padding: 22px 20px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
		text-align: center;
	}
	.opt-title {
		font-weight: 600;
		margin-bottom: 14px;
	}
	.opt-bar {
		height: 8px;
		border-radius: 99px;
		background: var(--line, #e5e5e5);
		overflow: hidden;
	}
	.opt-fill {
		height: 100%;
		background: var(--accent, #6b7cff);
		transition: width 0.2s ease;
	}
	/* no measurable progress (assembling, queued): a sliding block instead of a frozen bar */
	.opt-fill.busy {
		width: 35%;
		animation: opt-slide 1.4s ease-in-out infinite alternate;
	}
	@keyframes opt-slide {
		from {
			transform: translateX(0);
		}
		to {
			transform: translateX(186%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.opt-fill.busy {
			width: 100%;
			opacity: 0.5;
			animation: none;
		}
	}
	.opt-note {
		margin: 10px 0 0;
		font-size: 12.5px;
		line-height: 1.4;
		color: var(--muted, #888);
	}
	.opt-pct {
		min-height: 1.2em;
		margin-top: 8px;
		font-size: 13px;
		color: var(--muted, #888);
		font-variant-numeric: tabular-nums;
	}
	.opt-actions {
		margin-top: 14px;
	}
	.opt-actions .ghost {
		margin-top: 6px;
	}
</style>
