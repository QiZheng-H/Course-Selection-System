/**
 * 路由与守卫。
 * 使用 hash 模式，避免生产环境静态托管刷新出现 404。
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
    redirect: '/student/dashboard',
    children: [
      { path: 'dashboard', name: 'student-dashboard', component: () => import('@/views/student/Dashboard.vue') },
      { path: 'courses', name: 'student-courses', component: () => import('@/views/student/CourseSearch.vue') },
      { path: 'preferences', name: 'student-preferences', component: () => import('@/views/student/Preferences.vue') },
      { path: 'timetable', name: 'student-timetable', component: () => import('@/views/student/Timetable.vue') },
      { path: 'results', name: 'student-results', component: () => import('@/views/student/Results.vue') },
      { path: 'records', name: 'student-records', component: () => import('@/views/student/Records.vue') },
      { path: 'plan', name: 'student-plan', component: () => import('@/views/student/Plan.vue') },
    ],
  },

  // ---------------- 管理端 ----------------
  {
    path: '/admin',
    redirect: '/admin/home',
    children: [
      { path: 'home', name: 'admin-home', component: () => import('@/views/admin/AdminHome.vue') },
      { path: 'batches', name: 'admin-batches', component: () => import('@/views/admin/Batches.vue') },
      { path: 'materials', name: 'admin-materials', component: () => import('@/views/admin/Materials.vue') },
      { path: 'allocation', name: 'admin-allocation', component: () => import('@/views/admin/Allocation.vue') },
      { path: 'guarantee', name: 'admin-guarantee', component: () => import('@/views/admin/Guarantee.vue') },
      { path: 'exceptions', name: 'admin-exceptions', component: () => import('@/views/admin/Exceptions.vue') },
      { path: 'users', name: 'admin-users', component: () => import('@/views/admin/Users.vue') },
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
      return user.role === 'admin' ? { name: 'admin-home' } : { name: 'student-dashboard' };
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
    return { name: 'admin-home' };
  }

  return true;
});

export default router;
