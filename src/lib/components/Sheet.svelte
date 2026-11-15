<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { tabStops, wrapTarget } from './focus-trap.js';
	let {
		title,
		label,
		onclose,
		autofocus = false,
		children
	}: {
		title?: string;
		label?: string;
		onclose: () => void;
		/** Focus the first text field on open — for sheets whose whole point is typing. */
		autofocus?: boolean;
		children: Snippet;
	} = $props();

	let sheet = $state<HTMLDivElement>();

	// Move focus into the dialog (keyboard and screen-reader users otherwise stay on the
	// page underneath) and hand it back to whatever opened the sheet when it closes.
	onMount(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const field = autofocus
			? sheet?.querySelector<HTMLElement>('input:not([type="hidden"]):not([type="color"]), textarea')
			: null;
		(field ?? sheet)?.focus({ preventScroll: true });
		// bind:this lets go of the element as it is destroyed; keep it for the check below.
		const dialog = sheet;
		return () => {
			// Only when focus would otherwise be lost. A sheet opened from this one's menu
			// (which closes in the same tick) may already hold it, and the opener may be gone.
			const active = document.activeElement;
			const lost = !active || active === document.body || !!dialog?.contains(active);
			if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
		};
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	// Keep Tab inside the sheet: from the last control it wraps to the first, and back.
	function trapTab(e: KeyboardEvent) {
		if (e.key !== 'Tab' || !sheet) return;
		const target = wrapTarget(tabStops(sheet), document.activeElement, sheet, e.shiftKey);
		if (!target) return;
		e.preventDefault();
		target.focus();
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="scrim" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
	<div
		class="sheet"
		role="dialog"
		aria-modal="true"
		aria-label={label ?? title}
		tabindex="-1"
		bind:this={sheet}
		onkeydown={trapTab}
	>
		<div class="grab"></div>
		{#if title}<h3>{title}</h3>{/if}
		{@render children()}
	</div>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: flex-end;
		justify-content: center;
	}
	.sheet {
		width: 100%;
		max-width: var(--max);
		background: var(--surface);
		border-radius: 22px 22px 0 0;
		padding: 8px 16px calc(20px + env(safe-area-inset-bottom));
		border-top: 1px solid var(--line);
		box-shadow: 0 -10px 30px rgba(20, 22, 40, 0.16);
		animation: up 0.22s ease;
		/* The sheet is bottom-anchored, so without a cap it grows off the TOP of the
		   screen when its content expands (e.g. the create dialog's Options block) and
		   the fields up there become unreachable. Cap it and scroll inside instead.
		   dvh, so a mobile browser's collapsing toolbar doesn't re-hide the top. */
		max-height: 88vh;
		max-height: 88dvh;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.sheet:focus {
		outline: none;
	}
	@keyframes up {
		from {
			transform: translateY(30px);
			opacity: 0.4;
		}
		to {
			transform: none;
			opacity: 1;
		}
	}
	.grab {
		width: 38px;
		height: 4px;
		border-radius: 2px;
		background: var(--line);
		margin: 8px auto 14px;
	}
	h3 {
		margin: 0 0 4px;
		font-size: 18px;
	}
</style>
