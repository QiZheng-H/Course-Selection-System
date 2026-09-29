<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import TopNav from '@/components/TopNav.vue';
import ToastHost from '@/components/ToastHost.vue';
import ConfirmHost from '@/components/ConfirmHost.vue';
import { useSession } from '@/stores/session';

const route = useRoute();
const session = useSession();

const showNav = computed(() => Boolean(session.state.user) && route.name !== 'login');
</script>

<template>
  <TopNav v-if="showNav" />
  <main class="app-main">
    <router-view />
  </main>
  <ToastHost />
  <ConfirmHost />
</template>
