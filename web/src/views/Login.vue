<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { login } from '@/stores/session';
import { useToast } from '@/stores/toast';
import { apiErrorInfo } from '@/api/errors';

const router = useRouter();
const route = useRoute();
const toast = useToast();

const username = ref('');
const password = ref('');
const submitting = ref(false);
const errorTitle = ref('');
const errorLines = ref<string[]>([]);

async function submit(): Promise<void> {
  if (submitting.value) return;
  errorTitle.value = '';
  errorLines.value = [];
  if (!username.value.trim() || !password.value) {
    errorTitle.value = '请输入用户名与密码';
    return;
  }
  submitting.value = true;
  try {
    const user = await login(username.value.trim(), password.value);
    toast.success(`欢迎，${user.displayName}`, [user.role === 'admin' ? '已进入管理端' : '已进入学生端']);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '';
    if (redirect) {
      await router.push(redirect);
    } else {
      await router.push(user.role === 'admin' ? { name: 'admin-home' } : { name: 'student-dashboard' });
    }
  } catch (error) {
    const info = apiErrorInfo(error, '登录失败');
    errorTitle.value = `${info.title}：${info.message}`;
    errorLines.value = info.lines;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login">
    <form class="login__card" @submit.prevent="submit">
      <h1 class="login__title">大学选课系统</h1>
      <p class="login__subtitle">学生与管理员使用同一个入口，用用户名登录。</p>

      <label class="field">
        <span class="field__label">用户名 / 学号</span>
        <input v-model="username" class="input" type="text" autocomplete="username" placeholder="例如 admin 或 20241001" />
      </label>
      <label class="field">
        <span class="field__label">密码</span>
        <input v-model="password" class="input" type="password" autocomplete="current-password" placeholder="请输入密码" />
      </label>

      <p v-if="errorTitle" class="alert alert--error">
        {{ errorTitle }}
        <span v-for="(line, index) in errorLines" :key="index" class="alert__line">{{ line }}</span>
      </p>

      <button class="btn btn--primary btn--block" type="submit" :disabled="submitting">
        {{ submitting ? '登录中…' : '登录' }}
      </button>

      <p class="login__hint">
        会话使用 httpOnly Cookie 保存在浏览器中；登录状态失效时系统会自动返回本页，本页不会保存任何口令。
      </p>
    </form>
  </div>
</template>
