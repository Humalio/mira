<script lang="ts">
	let {
		checked = $bindable(false),
		label,
		onchange
	}: { checked?: boolean; label?: string; onchange?: (v: boolean) => void } = $props();
	function toggle() {
		checked = !checked;
		onchange?.(checked);
	}
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	class="switch"
	class:on={checked}
	onclick={toggle}
>
	<span class="knob"></span>
</button>

<style>
	.switch {
		flex: none;
		width: 46px;
		height: 28px;
		border-radius: 999px;
		background: var(--surface-2);
		border: 1px solid var(--line);
		position: relative;
		transition: background 0.15s;
		cursor: pointer;
	}
	.knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
		transition: transform 0.15s;
	}
	.on {
		background: var(--accent);
		border-color: var(--accent);
	}
	.on .knob {
		transform: translateX(18px);
	}
</style>
