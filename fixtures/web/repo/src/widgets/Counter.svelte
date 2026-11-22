<script lang="ts">
  import { onMount } from 'svelte';
  import Badge from './Badge.svelte';
  import { formatName } from '../utils/format';

  export let start = 0;
  let count = start;
  const owner = formatName({ first: 'Svelte', last: 'Counter' });

  onMount(() => {
    count += 1;
  });
</script>

<button on:click={() => (count += 1)}>
  {owner}: <Badge label={String(count)} />
</button>

<style>
  button { font: inherit; }
</style>
