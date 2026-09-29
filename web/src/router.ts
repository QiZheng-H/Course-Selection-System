/**
 * 路由与守卫。
 * 使用 hash 模式，避免生产环境静态托管刷新出现 404。
 *
 * 管理端信息结构已按《管理员页面简化实施计划》重组为四个一级入口：
 *   选课工作台 / 教学资料 / 学生管理 / 记录与设置。
 * 旧页面路由全部保留兼容跳转，避免书签与旧链接 404。
 */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { setUnauthorizedHandler } from '@/api/client';
import { loadCurrentUser, setCurrentUser } from '@/stores/session';
import { pushToast } from '@/stores/toast';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/login' },
  { path: '/login', name: 'login', component: () => import('@/views/Login.vue') },
  { path: '/403', name: 'forbidden', component: () => import('@/views/Forbidden.vue') },

  // ---------------- 学生端 ----------------
  {
    path: '/student',
    redirect: '/student/home',
    children: [
      { path: 'home', name: 'student-home', component: () => import('@/views/student/StudentHome.vue') },
      // 「概览」已合并进「我的选课」；保留旧名称与路径，避免旧链接/书签 404
      { path: 'dashboard', name: 'student-dashboard', redirect: { name: 'student-home' } },
      // 「课程检索」已并入志愿页第 1 步；保留重定向，避免旧链接/书签 404
      { path: 'courses', redirect: { name: 'student-preferences' } },
      { path: 'preferences', name: 'student-preferences', component: () => import('@/views/student/Preferences.vue') },
      { path: 'timetable', name: 'student-timetable', component: () => import('@/views/student/Timetable.vue') },
      { path: 'results', name: 'student-results', component: () => import('@/views/student/Results.vue') },
      { path: 'records', name: 'student-records', component: () => import('@/views/student/Records.vue') },
      { path: 'plan', name: 'student-plan', component: () => import('@/views/student/Plan.vue') },
      { path: 'program', name: 'student-program', component: () => import('@/views/student/Program.vue') },
    ],
  },

  // ---------------- 管理端 ----------------
  {
    path: '/admin',
    redirect: '/admin/workspace',
    children: [
      // ① 选课工作台
      { path: 'workspace', name: 'admin-workspace', component: () => import('@/views/admin/Workbench.vue') },
      {
        path: 'workspace/activities',
        name: 'admin-workspace-activities',
        component: () => import('@/views/admin/Activities.vue'),
      },

      // ② 教学资料
      { path: 'teaching/courses', name: 'admin-teaching-courses', component: () => import('@/views/admin/Materials.vue') },
      { path: 'teaching/programs', name: 'admin-teaching-programs', component: () => import('@/views/admin/Programs.vue') },
      {
        path: 'teaching/preallocation',
        name: 'admin-teaching-preallocation',
        component: () => import('@/views/admin/Preallocation.vue'),
      },

      // ③ 学生管理
      { path: 'students', name: 'admin-students', component: () => import('@/views/admin/Users.vue') },
      {
        path: 'students/guarantee',
        name: 'admin-students-guarantee',
        component: () => import('@/views/admin/Guarantee.vue'),
      },

      // ④ 记录与设置
      {
        path: 'records/exceptions',
        name: 'admin-records-exceptions',
        component: () => import('@/views/admin/Exceptions.vue'),
      },
      { path: 'records/audit', name: 'admin-records-audit', component: () => import('@/views/admin/Audit.vue') },
      { path: 'records/history', name: 'admin-records-history', component: () => import('@/views/admin/History.vue') },
      { path: 'records/config', name: 'admin-records-config', component: () => import('@/views/admin/Config.vue') },

      // ---- 旧路由兼容跳转 ----
      { path: 'home', redirect: { name: 'admin-workspace' } },
      { path: 'batches', redirect: { name: 'admin-workspace-activities' } },
      { path: 'materials', redirect: { name: 'admin-teaching-courses' } },
      { path: 'programs', redirect: { name: 'admin-teaching-programs' } },
      { path: 'allocation', redirect: { name: 'admin-teaching-preallocation' } },
      { path: 'guarantee', redirect: { name: 'admin-students-guarantee' } },
      { path: 'users', redirect: { name: 'admin-students' } },
      { path: 'exceptions', redirect: { name: 'admin-records-exceptions' } },
    ],
  },

  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFound.vue') },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

// 任何请求收到 401：清理本地会话并跳转登录页
setUnauthorizedHandler(() => {
  setCurrentUser(null);
  const current = router.currentRoute.value;
  if (current.name === 'login') return;
  pushToast('warning', '登录状态已失效，请重新登录');
  void router.push({ name: 'login', query: { redirect: current.fullPath } });
});

router.beforeEach(async (to) => {
  const user = await loadCurrentUser();

  if (to.name === 'login') {
    if (user) {
      return user.role === 'admin' ? { name: 'admin-workspace' } : { name: 'student-dashboard' };
    }
    return true;
  }

  if (!user) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  if (to.path.startsWith('/admin') && user.role !== 'admin') {
    pushToast('warning', '当前账号是学生，不能进入管理端', ['请使用管理员账号登录后再访问管理端页面。']);
    return { name: 'student-dashboard' };
  }

  if (to.path.startsWith('/student') && user.role !== 'student') {
    pushToast('warning', '当前账号是管理员，不能进入学生端页面', ['学生端数据属于具体学生，请使用学生账号登录。']);
    return { name: 'admin-workspace' };
  }

  return true;
});

export default router;
