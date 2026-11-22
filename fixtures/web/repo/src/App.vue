<script setup lang="ts">
import { ref } from 'vue';
import UserCard from './components/UserCard.vue';
import { formatName } from './utils/format';

const users = ref([{ first: 'Ada', last: 'Lovelace' }]);
const title = formatName({ first: 'Fixture', last: 'App' });

function addUser(first: string, last: string) {
  users.value.push({ first, last });
}
</script>

<template>
  <main class="app">
    <h1>{{ title }}</h1>
    <UserCard v-for="user in users" :key="user.last" :user="user" />
    <button @click="addUser('Grace', 'Hopper')">Add</button>
  </main>
</template>

<style lang="scss">
@use './styles/theme';
@import '~bootstrap/scss/bootstrap';

.app {
  color: theme.$ink; // a line comment: @use './styles/vars';
}
</style>
