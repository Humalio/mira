<script lang="ts">
	let { data, children } = $props();
</script>

<!-- The skin tokens are applied here so the whole album subtree is themed (SSR, no flash). -->
<div class="app with-bar" style={data.themeStyle}>
	{@render children()}
</div>
