/**
 * 学生端当前阶段。
 *
 * 学生页面不各自猜测阶段：统一从 /student/active-stage 读取，
 * 并定时刷新。管理员切换阶段（开放/结束/开放退改选）后，
 * 学生已经打开的页面会随之更新提示。
 */
import { computed, reactive } from 'vue';
import { api } from '@/api/client';
import type { StudentStageDto } from '@/api/types';

interface StageState {
  stage: StudentStageDto | null;
  loading: boolean;
  error: string;
  loaded: boolean;
}

const state = reactive<StageState>({ stage: null, loading: false, error: '', loaded: false });

const POLL_INTERVAL_MS = 20_000;
let timer: number | null = null;

export function useStage() {
  return {
    state,
    stage: computed(() => state.stage),
    /** 退改选是否已开放：结果发布后、开放前为 false */
    admissionOpen: computed(() => state.stage?.admissionOpen ?? false),
    canSubmitPreference: computed(() => state.stage?.canSubmitPreference ?? false),
    canUseWaitlist: computed(() => state.stage?.canUseWaitlist ?? false),
  };
}

export async function loadStage(): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  try {
    const data = await api.get<{ stage: StudentStageDto }>('/student/active-stage', undefined, {
      skipAuthRedirect: true,
    });
    state.stage = data.stage;
    state.error = '';
    state.loaded = true;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
  }
}

export function startStagePolling(): void {
  void loadStage();
  if (timer !== null) return;
  timer = window.setInterval(() => {
    void loadStage();
  }, POLL_INTERVAL_MS);
}

export function stopStagePolling(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

export function resetStage(): void {
  stopStagePolling();
  state.stage = null;
  state.loaded = false;
  state.error = '';
}
