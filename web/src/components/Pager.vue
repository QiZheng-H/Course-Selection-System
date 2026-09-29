<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  page: number;
  pageSize: number;
  total: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{ (event: 'change', page: number): void }>();

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize))));
const canPrev = computed(() => props.page > 1 && !props.disabled);
const canNext = computed(() => props.page < pageCount.value && !props.disabled);

function go(target: number): void {
  if (props.disabled) return;
  const clamped = Math.min(Math.max(1, target), pageCount.value);
  if (clamped !== props.page) emit('change', clamped);
}
</script>

<template>
  <div class="pager">
    <span class="pager__info">共 {{ total }} 条 · 第 {{ page }} / {{ pageCount }} 页</span>
    <div class="pager__buttons">
      <button class="btn btn--ghost btn--sm" type="button" :disabled="!canPrev" @click="go(page - 1)">上一页</button>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="!canNext" @click="go(page + 1)">下一页</button>
    </div>
  </div>
</template>
