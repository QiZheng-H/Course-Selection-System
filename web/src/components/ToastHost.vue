<script setup lang="ts">
import { useToast } from '@/stores/toast';

const toast = useToast();
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <div v-for="item in toast.items" :key="item.id" class="toast" :class="`toast--${item.kind}`">
      <div class="toast__body">
        <div class="toast__title">{{ item.title }}</div>
        <p v-for="(line, index) in item.lines" :key="index" class="toast__line">{{ line }}</p>
      </div>
      <button class="toast__close" type="button" aria-label="关闭提示" @click="toast.dismiss(item.id)">×</button>
    </div>
  </div>
</template>
