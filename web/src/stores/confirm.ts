/** 二次确认对话框状态（危险操作必须确认）。 */
import { reactive } from 'vue';

export interface ConfirmOptions {
  title: string;
  message?: string;
  details?: string[];
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve: ((value: boolean) => void) | null;
}

const state = reactive<ConfirmState>({
  open: false,
  title: '',
  message: '',
  details: [],
  confirmText: '确认',
  cancelText: '取消',
  danger: false,
  resolve: null,
});

export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  // 同一时间只保留一个确认框：先关掉上一个（视为取消）
  if (state.resolve) {
    state.resolve(false);
    state.resolve = null;
  }
  state.open = true;
  state.title = options.title;
  state.message = options.message ?? '';
  state.details = options.details ?? [];
  state.confirmText = options.confirmText ?? '确认';
  state.cancelText = options.cancelText ?? '取消';
  state.danger = options.danger ?? true;
  return new Promise<boolean>((resolve) => {
    state.resolve = resolve;
  });
}

export function resolveConfirm(value: boolean): void {
  const resolve = state.resolve;
  state.open = false;
  state.resolve = null;
  if (resolve) resolve(value);
}

export function useConfirmState(): ConfirmState {
  return state;
}
