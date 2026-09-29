<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="page page--narrow">
    <div class="card">
      <h2>页面不存在</h2>
      <p class="muted">你访问的地址没有对应的页面。</p>
      <button class="btn btn--primary" type="button" @click="router.push({ name: 'login' })">返回登录页</button>
    </div>
  </div>
</template>
