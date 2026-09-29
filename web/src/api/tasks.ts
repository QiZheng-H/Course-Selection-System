/**
 * 后台任务轮询。
 *
 * 分配与规划属于耗时计算，后端立即返回任务标识，由本模块负责轮询到终态，
 * 页面据此展示“处理中 / 成功 / 失败 / 超时”与进度。
 */
import { api } from './client';
import type { BackgroundTask } from './types';

const ACTIVE: BackgroundTask['status'][] = ['queued', 'running'];

export function isTaskActive(task: BackgroundTask | null): boolean {
  return task !== null && ACTIVE.includes(task.status);
}

export async function fetchTask(taskId: number): Promise<BackgroundTask> {
  const data = await api.get<{ task: BackgroundTask }>(`/admin/tasks/${taskId}`);
  return data.task;
}

export interface WaitForTaskOptions {
  /** 轮询间隔（毫秒） */
  intervalMs?: number;
  /** 最长等待时间（毫秒） */
  timeoutMs?: number;
  onUpdate?: (task: BackgroundTask) => void;
  shouldStop?: () => boolean;
}

export async function waitForTask(taskId: number, options: WaitForTaskOptions = {}): Promise<BackgroundTask> {
  const interval = options.intervalMs ?? 500;
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  for (;;) {
    const task = await fetchTask(taskId);
    options.onUpdate?.(task);
    if (!ACTIVE.includes(task.status)) return task;
    if (options.shouldStop?.()) return task;
    if (Date.now() > deadline) return task;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
