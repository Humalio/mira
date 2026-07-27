<script lang="ts">
	import '@fontsource-variable/plus-jakarta-sans';
	import '@fontsource-variable/fraunces';
	import '../app.css';
	let { children } = $props();

	// Suppress the long-press callout on touch (it fights the app's own long-press
	// gestures) outside text fields and copyable links. A mouse right-click is a
	// deliberate desktop action (open in new tab, save image), so leave it alone.
	function blockContextMenu(e: MouseEvent) {
		if ((e as PointerEvent).pointerType === 'mouse') return;
		const t = e.target as HTMLElement | null;
		if (t?.closest('input, textarea, [contenteditable="true"], .linkbox')) return;
		e.preventDefault();
	}
</script>

<svelte:document oncontextmenu={blockContextMenu} />

{@render children()}
