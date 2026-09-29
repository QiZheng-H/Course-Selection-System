<script setup lang="ts">
/**
 * 应用入口：登录页之外统一使用「课间」外壳（左侧导航 + 顶栏 + 页脚）。
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from '@/components/AppShell.vue';
import ToastHost from '@/components/ToastHost.vue';
import ConfirmHost from '@/components/ConfirmHost.vue';
import { useSession } from '@/stores/session';

const route = useRoute();
const session = useSession();

const showShell = computed(() => Boolean(session.state.user) && route.name !== 'login');
</script>

<template>
  <AppShell v-if="showShell">
    <router-view />
  </AppShell>
  <router-view v-else />
  <ToastHost />
  <ConfirmHost />
</template>
