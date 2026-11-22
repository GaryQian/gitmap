<script lang="ts">
export default { inheritAttrs: false };
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { formatName, type Person } from '@/utils/format';
// import Counter from '../widgets/Counter.svelte';

const props = defineProps<{ user: Person }>();
const label = computed(() => formatName(props.user));
</script>

<template>
  <article class="user-card">{{ label }}</article>
</template>

<style scoped>
.user-card {
  background: url('@/assets/logo.svg') no-repeat;
}
</style>
