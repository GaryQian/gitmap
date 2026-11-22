<script context="module" lang="ts">
  export const MAX_LABEL = 12;
</script>

<script lang="ts">
  export let label: string;
</script>

<span class="badge">{label.slice(0, MAX_LABEL)}</span>
