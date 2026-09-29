/** 全局轻量消息提示（不依赖任何第三方库）。 */
import { reactive } from 'vue';
import { apiErrorInfo } from '@/api/errors';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  lines: string[];
}

const state = reactive<{ items: Toast[] }>({ items: [] });
let sequence = 0;

export function pushToast(kind: ToastKind, title: string, lines: string[] = [], timeoutMs = 5000): number {
  sequence += 1;
  const id = sequence;
  state.items.push({ id, kind, title, lines });
  if (timeoutMs > 0) {
    window.setTimeout(() => dismissToast(id), timeoutMs);
  }
  return id;
}

export function dismissToast(id: number): void {
  const index = state.items.findIndex((item) => item.id === id);
  if (index >= 0) state.items.splice(index, 1);
}

export function useToast() {
  return {
    items: state.items,
    success: (title: string, lines: string[] = []) => pushToast('success', title, lines, 4000),
    error: (title: string, lines: string[] = []) => pushToast('error', title, lines, 9000),
    warning: (title: string, lines: string[] = []) => pushToast('warning', title, lines, 7000),
    info: (title: string, lines: string[] = []) => pushToast('info', title, lines, 5000),
    dismiss: dismissToast,
  };
}

/** 统一处理接口错误：按 error.code 显示不同提示，并附上 details 里的可读信息 */
export function reportApiError(error: unknown, fallbackTitle = '操作失败'): void {
  const info = apiErrorInfo(error, fallbackTitle);
  const lines = info.lines.length > 0 ? [info.message, ...info.lines] : [info.message];
  pushToast('error', info.title, lines, 9000);
}
