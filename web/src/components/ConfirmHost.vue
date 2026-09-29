<script setup lang="ts">
/**
 * 二次确认对话框。
 *
 * 重要操作（开放阶段、发布结果、重新开放提交、结束活动等）保留一次明确确认；
 * 确认框只说明影响哪些人、会发生什么、是否可以恢复。
 *
 * 键盘可用性：打开后焦点自动落到确认按钮，Esc 取消，Enter 触发当前聚焦按钮。
 */
import { nextTick, onUnmounted, ref, watch } from 'vue';
import { resolveConfirm, useConfirmState } from '@/stores/confirm';

const state = useConfirmState();
const confirmButton = ref<HTMLButtonElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (!state.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    resolveConfirm(false);
  }
}

watch(
  () => state.open,
  async (open) => {
    if (open) {
      window.addEventListener('keydown', onKeydown);
      await nextTick();
      confirmButton.value?.focus();
    } else {
      window.removeEventListener('keydown', onKeydown);
    }
  },
);

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div v-if="state.open" class="modal-backdrop" @click.self="resolveConfirm(false)">
    <div class="modal" role="dialog" aria-modal="true" :aria-label="state.title">
      <h3 class="modal__title">{{ state.title }}</h3>
      <p v-if="state.message" class="modal__message">{{ state.message }}</p>
      <ul v-if="state.details && state.details.length > 0" class="modal__details">
        <li v-for="(line, index) in state.details" :key="index">{{ line }}</li>
      </ul>
      <div class="modal__actions">
        <button class="btn btn--ghost" type="button" @click="resolveConfirm(false)">{{ state.cancelText }}</button>
        <button
          ref="confirmButton"
          class="btn"
          :class="state.danger ? 'btn--danger' : 'btn--primary'"
          type="button"
          @click="resolveConfirm(true)"
        >
          {{ state.confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>
