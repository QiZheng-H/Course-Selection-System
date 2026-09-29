/**
 * 全局“当前学期／选课活动”选择。
 *
 * 管理员在导航栏选中一次，所有页面共用同一个活动，避免每个页面各自再选一次批次。
 * 选择结果保存在 localStorage，刷新或切换页面后保持。
 */
import { computed, reactive } from 'vue';
import { api } from '@/api/client';
import type { BatchDto } from '@/api/types';

const STORAGE_KEY = 'css.admin.selectedBatchId';

interface ActivityState {
  batches: BatchDto[];
  current: BatchDto | null;
  selectedId: number | null;
  loaded: boolean;
  loading: boolean;
  error: string;
}

const state = reactive<ActivityState>({
  batches: [],
  current: null,
  selectedId: readStoredId(),
  loaded: false,
  loading: false,
  error: '',
});

function readStoredId(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storeId(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // localStorage 不可用时只影响“记住选择”，不影响功能
  }
}

/** 已结束的活动标注为历史，避免与当前活动混淆 */
export function isHistorical(batch: BatchDto | null | undefined): boolean {
  return Boolean(batch && batch.status === 'closed');
}

export function useActivity() {
  const selected = computed<BatchDto | null>(
    () => state.batches.find((item) => item.id === state.selectedId) ?? null,
  );

  /** 当前进行中的活动（有可能是历史活动，因此单独暴露判断） */
  const activeBatch = computed<BatchDto | null>(() => {
    const item = selected.value;
    if (item && !isHistorical(item)) return item;
    return state.current;
  });

  return {
    state,
    batches: computed(() => state.batches),
    selected,
    activeBatch,
    isHistorical,
    selectedId: computed(() => state.selectedId),
  };
}

/** 读取活动列表；只有首次或强制刷新时才请求 */
export async function loadActivities(force = false): Promise<void> {
  if (state.loaded && !force) return;
  if (state.loading) return;
  state.loading = true;
  state.error = '';
  try {
    const data = await api.get<{ batches: BatchDto[]; current: BatchDto | null }>('/admin/batches', undefined, {
      skipAuthRedirect: true,
    });
    state.batches = data.batches;
    state.current = data.current;
    // 选择失效（活动被删除或本地记录指向不存在的活动）时回到当前活动
    const stillExists = state.selectedId !== null && data.batches.some((item) => item.id === state.selectedId);
    if (!stillExists) {
      state.selectedId = data.current?.id ?? data.batches[0]?.id ?? null;
      storeId(state.selectedId);
    }
    state.loaded = true;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
  }
}

export function selectActivity(batchId: number | null): void {
  state.selectedId = batchId;
  storeId(batchId);
}

export function resetActivities(): void {
  state.batches = [];
  state.current = null;
  state.selectedId = null;
  state.loaded = false;
  state.error = '';
  storeId(null);
}
