/** 当前用户会话状态（通过 GET /api/auth/me 获取，cookie 由浏览器携带）。 */
import { computed, reactive } from 'vue';
import { api } from '@/api/client';
import type { AuthUser } from '@/api/types';

interface SessionState {
  user: AuthUser | null;
  loaded: boolean;
  loading: boolean;
}

const state = reactive<SessionState>({ user: null, loaded: false, loading: false });

/** 读取当前用户；已加载过则直接返回缓存（force 可强制刷新） */
export async function loadCurrentUser(force = false): Promise<AuthUser | null> {
  if (state.loaded && !force) return state.user;
  if (state.loading) return state.user;
  state.loading = true;
  try {
    const data = await api.get<{ user: AuthUser }>('/auth/me', undefined, { skipAuthRedirect: true });
    state.user = data.user;
  } catch {
    state.user = null;
  } finally {
    state.loading = false;
    state.loaded = true;
  }
  return state.user;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const data = await api.post<{ user: AuthUser; expiresAt: string }>(
    '/auth/login',
    { username, password },
    { skipAuthRedirect: true },
  );
  state.user = data.user;
  state.loaded = true;
  return data.user;
}

export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout', {}, { skipAuthRedirect: true });
  } catch {
    // 忽略登出失败：本地状态照常清理
  }
  state.user = null;
  state.loaded = true;
}

export function setCurrentUser(user: AuthUser | null): void {
  state.user = user;
  state.loaded = true;
}

export function useSession() {
  return {
    state,
    user: computed(() => state.user),
    isStudent: computed(() => state.user?.role === 'student'),
    isAdmin: computed(() => state.user?.role === 'admin'),
  };
}
