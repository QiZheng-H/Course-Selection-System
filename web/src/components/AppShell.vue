<script setup lang="ts">
/**
 * 应用外壳：左侧导航 + 顶栏 + 内容区 + 页脚。
 *
 * 界面采用「左侧导航 + 顶栏」的版式：
 *   - 左侧固定四个（管理端）或两组（学生端）导航，当前项加深；
 *   - 顶栏左侧是「上海理工大学 / 选课服务」面包屑，右侧是学期、当前选课活动与端别；
 *   - 底部是当前用户与一句提示，退出登录放在这里。
 *
 * 页面级子标签（教学资料 / 学生管理 / 记录与设置内部的分页）渲染在顶栏下方，
 * 这样侧边栏可以保持设计稿里的简洁四项。
 */
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { logout, useSession } from '@/stores/session';
import { useToast } from '@/stores/toast';
import { useActivity, loadActivities, selectActivity, resetActivities, isHistorical } from '@/stores/activity';
import { useStage, startStagePolling, stopStagePolling, resetStage } from '@/stores/stage';
import { batchStatusLabel, formatDateTime } from '@/utils/labels';

const route = useRoute();
const router = useRouter();
const session = useSession();
const toast = useToast();
const activity = useActivity();
const { stage } = useStage();

interface NavItem {
  name: string;
  label: string;
  icon: string;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const ICONS: Record<string, string> = {
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  list: 'M4 6h16M4 12h16M4 18h10',
  calendar: 'M4 6h16v14H4zM8 3v4M16 3v4M4 10h16',
  check: 'M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0M9 12l2 2 4-4',
  chart: 'M4 20V9M10 20V4M16 20v-7M22 20H2',
  sparkle: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  book: 'M4 5v14h7a3 3 0 0 1 3 3V8a3 3 0 0 1 3-3H4M20 5v14h-7',
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  users: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M2 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 1 0 0-6M16 20c0-2 1-3 3-3s3 1 3 3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3.6 15H3.4a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10.5 4.1V3.9a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4z',
  // 学士帽：与「大学生选课系统」的名称对应
  cap: 'M2.5 9L12 5l9.5 4-9.5 4zM6.5 11.4V16c0 1.6 2.5 2.8 5.5 2.8s5.5-1.2 5.5-2.8v-4.6M21.5 9v5.5',
  leaf: 'M12 21c0-6 2-10 8-12-1 8-5 12-8 12zM12 21c0-4-1-7-5-9 0 6 2 9 5 9z',
  school: 'M3 10l9-6 9 6-9 6zM6 12.5V19c3 2 9 2 12 0v-6.5',
};

const STUDENT_NAV: NavGroup[] = [
  {
    label: '我的新学期',
    items: [
      { name: 'student-home', label: '我的选课', icon: 'grid' },
      { name: 'student-preferences', label: '选课志愿', icon: 'list' },
      { name: 'student-timetable', label: '我的课表', icon: 'calendar' },
      { name: 'student-results', label: '结果与候补', icon: 'check' },
    ],
  },
  {
    label: '学习与规划',
    items: [
      { name: 'student-program', label: '学业进度', icon: 'chart' },
      { name: 'student-records', label: '修读记录', icon: 'book' },
      { name: 'student-plan', label: '帮我排课', icon: 'sparkle' },
    ],
  },
];

const ADMIN_NAV: NavGroup[] = [
  {
    label: '教务管理',
    items: [
      { name: 'admin-workspace', label: '选课工作台', icon: 'dashboard' },
      { name: 'admin-teaching-courses', label: '教学资料', icon: 'layers' },
      { name: 'admin-students', label: '学生管理', icon: 'users' },
      { name: 'admin-records-exceptions', label: '记录与设置', icon: 'settings' },
    ],
  },
];

/** 一级入口内部的子标签（保持侧边栏只有设计稿里的四项） */
interface SubTab {
  name: string;
  label: string;
}

const ADMIN_TABS: Record<string, SubTab[]> = {
  'admin-workspace': [
    { name: 'admin-workspace', label: '当前阶段与下一步' },
    { name: 'admin-workspace-activities', label: '选课活动管理' },
  ],
  'admin-teaching-courses': [
    { name: 'admin-teaching-courses', label: '资料导入' },
    { name: 'admin-teaching-programs', label: '培养方案' },
    { name: 'admin-teaching-preallocation', label: '专业课预分配' },
  ],
  'admin-students': [
    { name: 'admin-students', label: '学生查询与账号' },
    { name: 'admin-students-guarantee', label: '毕业保护名单' },
  ],
  'admin-records-exceptions': [
    { name: 'admin-records-exceptions', label: '待处理问题' },
    { name: 'admin-records-audit', label: '操作记录' },
    { name: 'admin-records-history', label: '历史活动与版本' },
    { name: 'admin-records-config', label: '基础配置' },
  ],
};

const navGroups = computed<NavGroup[]>(() => (session.isAdmin.value ? ADMIN_NAV : STUDENT_NAV));

const activeNav = computed(() => {
  const all = navGroups.value.flatMap((group) => group.items);
  const exact = all.find((item) => item.name === route.name);
  if (exact) return exact;
  // 子页归属到它的一级入口
  const entry = Object.entries(ADMIN_TABS).find(([, tabs]) => tabs.some((tab) => tab.name === route.name));
  return all.find((item) => item.name === entry?.[0]) ?? null;
});

const subTabs = computed<SubTab[]>(() => {
  if (!session.isAdmin.value) return [];
  const entry = Object.entries(ADMIN_TABS).find(([root, tabs]) =>
    tabs.some((tab) => tab.name === route.name) || root === activeNav.value?.name,
  );
  return entry?.[1] ?? [];
});

const termText = computed(() => {
  if (session.isAdmin.value) {
    const batch = activity.selected.value ?? activity.activeBatch.value;
    return batch ? `${batch.term} · ${batchStatusLabel(batch.status)}` : '尚未创建选课活动';
  }
  return stage.value?.term ? `${stage.value.term} · ${stage.value.stageLabel}` : '—';
});

const stagePill = computed(() => {
  if (session.isAdmin.value || !stage.value) return null;
  const parts = [stage.value.stageLabel];
  if (stage.value.closeAt && (stage.value.stageKey === 'preference_open' || stage.value.stageKey === 'materials')) {
    parts.push(`${formatDateTime(stage.value.closeAt)} 截止`);
  }
  return parts.join(' · ');
});

const userInitial = computed(() => (session.state.user?.displayName ?? session.state.user?.username ?? '?').slice(0, 1));

const userMeta = computed(() => {
  if (session.isAdmin.value) return '教务管理员 · 管理员';
  const student = session.state.user?.student;
  const parts = [student?.major, student?.grade ? `${student.grade} 级` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '学生';
});

const sideHint = computed(() =>
  session.isAdmin.value
    ? { title: '每一步，都清楚', text: '按阶段完成本轮选课，重要操作会先请你确认。' }
    : { title: '选课，不必着急', text: '截止前都可以调整志愿，提交早晚不影响分配顺序。' },
);

function iconPath(name: string): string {
  return ICONS[name] ?? ICONS.grid;
}

async function handleLogout(): Promise<void> {
  await logout();
  resetActivities();
  resetStage();
  toast.info('已退出登录');
  await router.push({ name: 'login' });
}

function onActivityChange(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value);
  selectActivity(Number.isInteger(value) && value > 0 ? value : null);
}

onMounted(() => {
  if (session.isAdmin.value) {
    // 进入管理端时校验一次活动列表，保证“当前活动”指向的是仍然存在的活动
    void loadActivities();
  } else {
    startStagePolling();
  }
});

watch(
  () => session.isAdmin.value,
  (isAdmin) => {
    if (isAdmin) {
      stopStagePolling();
      void loadActivities();
    } else {
      startStagePolling();
    }
  },
);
</script>

<template>
  <div class="shell">
    <aside class="shell__sidebar">
      <div class="shell__brand">
        <span class="shell__brand-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path :d="iconPath('cap')" />
          </svg>
        </span>
        <span class="shell__brand-name shell__brand-name--long">大学生选课系统</span>
      </div>

      <nav class="shell__nav">
        <template v-for="group in navGroups" :key="group.label ?? 'main'">
          <div v-if="group.label" class="shell__group-label">{{ group.label }}</div>
          <router-link
            v-for="item in group.items"
            :key="item.name"
            :to="{ name: item.name }"
            class="shell__item"
            :class="{ 'shell__item--active': activeNav?.name === item.name }"
          >
            <span class="shell__icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path :d="iconPath(item.icon)" />
              </svg>
            </span>
            {{ item.label }}
          </router-link>
        </template>
      </nav>

      <div class="shell__side-card">
        <div class="shell__side-card-title">{{ sideHint.title }}</div>
        <p class="shell__side-card-text">{{ sideHint.text }}</p>
      </div>

      <div class="shell__user">
        <span class="shell__avatar">{{ userInitial }}</span>
        <span>
          <span class="shell__user-name">{{ session.state.user?.displayName ?? session.state.user?.username }}</span>
          <span class="shell__user-meta">{{ userMeta }}</span>
        </span>
        <button class="shell__logout" type="button" title="退出登录" @click="handleLogout">退出</button>
      </div>
    </aside>

    <div class="shell__body">
      <header class="topbar">
        <div class="topbar__crumb">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path :d="iconPath('school')" />
          </svg>
          <span>上海理工大学</span>
          <span class="topbar__crumb-sep">/</span>
          <strong>选课服务</strong>
        </div>
        <div class="topbar__right">
          <span v-if="stagePill" class="topbar__stage">
            <span class="topbar__stage-dot"></span>{{ stagePill }}
          </span>
          <span class="topbar__term">{{ termText }}</span>
          <label v-if="session.isAdmin.value" class="shell__activity">
            <select class="select select--sm" :value="activity.selectedId.value ?? ''" @change="onActivityChange">
              <option v-if="activity.batches.value.length === 0" value="">尚无选课活动</option>
              <option v-for="batch in activity.batches.value" :key="batch.id" :value="batch.id">
                {{ isHistorical(batch) ? '[历史] ' : '' }}{{ batch.name }}（{{ batch.term }}）
              </option>
            </select>
          </label>
          <span class="topbar__mode">{{ session.isAdmin.value ? '管理端' : '学生端' }}</span>
        </div>
      </header>

      <nav v-if="subTabs.length > 1" class="topbar__tabs">
        <router-link
          v-for="tab in subTabs"
          :key="tab.name"
          :to="{ name: tab.name }"
          class="topbar__tab"
          :class="{ 'topbar__tab--active': route.name === tab.name }"
        >
          {{ tab.label }}
        </router-link>
      </nav>

      <main class="shell__content">
        <slot />
      </main>

      <footer class="page-foot">
        <span>大学生选课系统 · 让每个新学期，都从容一点。</span>
        <span>{{ termText }}</span>
      </footer>
    </div>
  </div>
</template>
