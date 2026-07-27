/**
 * Svelte action: fire `onpress` after a press-and-hold, and swallow the click
 * that follows so it doesn't also trigger the element's normal tap action.
 * Cancels if the pointer moves (scroll) or `enabled` returns false.
 *
 *   <button use:longpress={{ onpress: () => select(p), enabled: () => !selecting }} onclick={tap}>
 */
export function longpress(node: HTMLElement, opts: { onpress: () => void; enabled?: () => boolean; ms?: number }) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let startX = 0;
	let startY = 0;
	let fired = false;

	const clear = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
	const down = (e: PointerEvent) => {
		if (opts.enabled && !opts.enabled()) return;
		startX = e.clientX;
		startY = e.clientY;
		fired = false;
		timer = setTimeout(() => {
			timer = null;
			fired = true;
			opts.onpress();
		}, opts.ms ?? 450);
	};
	const move = (e: PointerEvent) => {
		if (timer && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) clear();
	};
	const click = (e: MouseEvent) => {
		if (fired) {
			e.preventDefault();
			e.stopPropagation();
			fired = false;
		}
	};

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', clear);
	node.addEventListener('pointerleave', clear);
	node.addEventListener('click', click, true);

	return {
		destroy() {
			clear();
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', clear);
			node.removeEventListener('pointerleave', clear);
			node.removeEventListener('click', click, true);
		}
	};
}
