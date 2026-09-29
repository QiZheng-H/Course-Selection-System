<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { logout, useSession } from '@/stores/session';
import { useToast } from '@/stores/toast';

const router = useRouter();
const route = useRoute();
const session = useSession();
const toast = useToast();

/**
 * 学生端菜单顺序 = 学生的实际操作顺序：
 *   ① 先了解（概览 → 培养方案 → 修读记录：我该修什么、已经修了什么）
 *   ② 再动手（课程检索 → 志愿：有什么课可选、我要按什么顺序申请）
 *   ③ 后看结果（我的课表 → 结果与候补：落实了什么、竞争结果与候补顺位）
 *   ④ 辅助规划（偏好与规划：属于软性参考，放最后不影响主流程）
 *
 * 注意「我的课表」必须在「结果与候补」之后：课表只反映已经落实的课，
 * 首轮结果发布前它是空的，排在前面会让学生以为出了错。
 */
const studentLinks = [
  { name: 'student-dashboard', label: '概览' },
  { name: 'student-program', label: '培养方案' },
  { name: 'student-records', label: '修读记录' },
  { name: 'student-courses', label: '课程检索' },
  { name: 'student-preferences', label: '志愿' },
  { name: 'student-timetable', label: '我的课表' },
  { name: 'student-results', label: '结果与候补' },
  { name: 'student-plan', label: '偏好与规划' },
];

const adminLinks = [
  { name: 'admin-home', label: '总览' },
  { name: 'admin-batches', label: '批次控制' },
  { name: 'admin-materials', label: '资料核对' },
  { name: 'admin-programs', label: '培养方案' },
  { name: 'admin-allocation', label: '预分配与分配' },
  { name: 'admin-guarantee', label: '毕业保障' },
  { name: 'admin-exceptions', label: '异常与记录' },
  { name: 'admin-users', label: '账号管理' },
];

const links = computed(() => (session.isAdmin.value ? adminLinks : studentLinks));

const roleLabel = computed(() => (session.isAdmin.value ? '管理员' : '学生'));

async function handleLogout(): Promise<void> {
  await logout();
  toast.info('已退出登录');
  await router.push({ name: 'login' });
}

function isActive(name: string): boolean {
  return route.name === name;
}
</script>

<template>
  <header class="topnav">
    <div class="topnav__inner">
      <div class="topnav__brand">
        <span class="topnav__logo">选</span>
        <span class="topnav__title">大学选课系统</span>
      </div>
      <nav class="topnav__links">
        <router-link
          v-for="link in links"
          :key="link.name"
          :to="{ name: link.name }"
          class="topnav__link"
          :class="{ 'topnav__link--active': isActive(link.name) }"
        >
          {{ link.label }}
        </router-link>
      </nav>
      <div class="topnav__user">
        <span class="topnav__name">
          {{ session.state.user?.displayName ?? session.state.user?.username }}
          <span class="topnav__role">{{ roleLabel }}</span>
        </span>
        <button class="btn btn--ghost btn--sm" type="button" @click="handleLogout">退出</button>
      </div>
    </div>
  </header>
</template>
