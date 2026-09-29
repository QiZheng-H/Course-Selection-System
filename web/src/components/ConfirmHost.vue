<script setup lang="ts">
import { resolveConfirm, useConfirmState } from '@/stores/confirm';

const state = useConfirmState();
</script>

<template>
  <div v-if="state.open" class="modal-backdrop" @click.self="resolveConfirm(false)">
    <div class="modal" role="dialog" aria-modal="true">
      <h3 class="modal__title">{{ state.title }}</h3>
      <p v-if="state.message" class="modal__message">{{ state.message }}</p>
      <ul v-if="state.details && state.details.length > 0" class="modal__details">
        <li v-for="(line, index) in state.details" :key="index">{{ line }}</li>
      </ul>
      <div class="modal__actions">
        <button class="btn btn--ghost" type="button" @click="resolveConfirm(false)">{{ state.cancelText }}</button>
        <button class="btn" :class="state.danger ? 'btn--danger' : 'btn--primary'" type="button" @click="resolveConfirm(true)">
          {{ state.confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>
