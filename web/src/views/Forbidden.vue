<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="page page--narrow">
    <div class="card">
      <h2>没有访问权限</h2>
      <p class="muted">
        当前登录身份不能访问该页面。学生端与管理端使用不同账号，请退出后使用对应身份的账号登录。
      </p>
      <button class="btn btn--primary" type="button" @click="router.push({ name: 'login' })">返回登录页</button>
    </div>
  </div>
</template>
