<script lang="ts">
	// Any Lucide icon component; they all share a single prop signature.
	type IconComponent = typeof import('@lucide/svelte').Heart;
	type Option = { value: string; label: string; icon?: IconComponent };
	let { value = $bindable(), options }: { value: string; options: Option[] } = $props();
</script>

<div class="seg">
	{#each options as o (o.value)}
		<button type="button" class:on={value === o.value} onclick={() => (value = o.value)}>
			{#if o.icon}{@const Icon = o.icon}<Icon size={16} />{/if}{o.label}
		</button>
	{/each}
</div>

<style>
	.seg {
		display: flex;
		gap: 4px;
		padding: 4px;
		background: var(--surface-2);
		border-radius: 12px;
	}
	button {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 9px 10px;
		border-radius: 9px;
		background: transparent;
		border: none;
		font-size: 14px;
		font-weight: 600;
		color: var(--muted);
		cursor: pointer;
		transition: all 0.12s;
	}
	.on {
		background: var(--surface);
		color: var(--ink);
		box-shadow: 0 1px 3px rgba(20, 22, 40, 0.14);
	}
</style>
