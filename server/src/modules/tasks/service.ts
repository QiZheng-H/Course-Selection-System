/**
 * 后台任务：把耗时的分配与规划计算放到可跟踪的任务里执行。
 *
 * 为什么需要它：
 *   - better-sqlite3 是同步 API，一次几十万次比较的分配/规划会占满事件循环；
 *   - 直接放在 HTTP 请求里会让健康检查和其它接口全部卡住；
 *   - 任务需要“处理中 / 成功 / 失败 / 超时”的可跟踪状态，并且重试或程序重启不重复落位。
 *
 * 实现方式：计算阶段（computeAllocation）只依赖冻结快照、不写正式数据，
 * 并周期性让出事件循环；正式落位（publishRun）仍是单个同步事务，保证原子性。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, notFound } from '../../core/errors.js';
import { nowIso, stableStringify, contentHash } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { runAllocation, type RunAllocationOptions } from '../allocation/service.js';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';

export interface TaskDto {
  id: number;
  kind: 'allocation' | 'planning';
  batchId: number | null;
  runId: number | null;
  status: TaskStatus;
  progress: number;
  total: number;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 用于前端展示的进度百分比 */
  percent: number;
  /** 失败/超时是否可重试 */
  retryable: boolean;
}

interface TaskRow {
  id: number;
  kind: 'allocation' | 'planning';
  batch_id: number | null;
  run_id: number | null;
  status: TaskStatus;
  progress: number;
  total: number;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toDto(row: TaskRow): TaskDto {
  const percent = row.total > 0 ? Math.min(100, Math.round((row.progress / row.total) * 100)) : row.status === 'succeeded' ? 100 : 0;
  return {
    id: row.id,
    kind: row.kind,
    batchId: row.batch_id,
    runId: row.run_id,
    status: row.status,
    progress: row.progress,
    total: row.total,
    result: row.result ? (JSON.parse(row.result) as Record<string, unknown>) : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    percent,
    retryable: row.status === 'failed' || row.status === 'timeout',
  };
}

export function getTask(db: SqliteDb, taskId: number): TaskDto {
  const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
  if (!row) throw notFound('后台任务不存在');
  return toDto(row);
}

export function listTasks(db: SqliteDb, filter: { batchId?: number; kind?: string; limit: number; offset: number }): {
  items: TaskDto[];
  total: number;
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.batchId) {
    conditions.push('batch_id = ?');
    params.push(filter.batchId);
  }
  if (filter.kind) {
    conditions.push('kind = ?');
    params.push(filter.kind);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM background_tasks ${where}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(`SELECT * FROM background_tasks ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, filter.limit, filter.offset) as TaskRow[];
  return { items: rows.map(toDto), total };
}

function createTask(
  db: SqliteDb,
  input: { kind: 'allocation' | 'planning'; batchId: number | null; createdBy: number; idempotencyKey?: string | null },
): number {
  const info = db
    .prepare(
      `INSERT INTO background_tasks (kind, batch_id, status, progress, total, idempotency_key, created_by, created_at)
       VALUES (?, ?, 'queued', 0, 0, ?, ?, ?)`,
    )
    .run(input.kind, input.batchId, input.idempotencyKey ?? null, input.createdBy, nowIso());
  return Number(info.lastInsertRowid);
}

function markRunning(db: SqliteDb, taskId: number): void {
  db.prepare("UPDATE background_tasks SET status = 'running', started_at = ? WHERE id = ?").run(nowIso(), taskId);
}

function markFinished(
  db: SqliteDb,
  taskId: number,
  status: Exclude<TaskStatus, 'queued' | 'running'>,
  patch: { runId?: number | null; result?: unknown; errorCode?: string | null; errorMessage?: string | null; progress?: number; total?: number },
): void {
  db.prepare(
    `UPDATE background_tasks SET status = ?, run_id = COALESCE(?, run_id), result = ?, error_code = ?, error_message = ?,
       progress = COALESCE(?, progress), total = COALESCE(?, total), finished_at = ? WHERE id = ?`,
  ).run(
    status,
    patch.runId ?? null,
    patch.result === undefined ? null : stableStringify(patch.result),
    patch.errorCode ?? null,
    patch.errorMessage ?? null,
    patch.progress ?? null,
    patch.total ?? null,
    nowIso(),
    taskId,
  );
}

export interface StartTaskOptions extends RunAllocationOptions {
  /** 同一个幂等键重复请求时复用已有任务 */
  taskIdempotencyKey?: string;
}

/** 启动后台分配任务，立即返回任务标识（不阻塞 HTTP 主线程） */
export function startAllocationTask(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  options: StartTaskOptions = {},
): { taskId: number; reused: boolean } {
  const key = options.taskIdempotencyKey ?? null;
  const requestHash = contentHash({ batchId, mode: options.mode ?? 'simulate', timeoutMs: options.timeoutMs ?? null });
  if (key) {
    const existing = db
      .prepare(
        `SELECT id, batch_id, status, request_hash FROM background_tasks
         WHERE kind = 'allocation' AND idempotency_key = ?`,
      )
      .get(key) as { id: number; batch_id: number | null; status: TaskStatus; request_hash: string | null } | undefined;
    if (existing) {
      // 同一个幂等键用于不同批次或不同请求内容时必须拒绝，而不是错误地复用别人的结果
      if (existing.batch_id !== batchId || (existing.request_hash && existing.request_hash !== requestHash)) {
        throw new AppError(
          ERROR_CODES.IDEMPOTENCY_MISMATCH,
          '该幂等键已用于不同的批次或请求内容，请更换幂等键后重试',
          409,
        );
      }
      return { taskId: existing.id, reused: true };
    }
  }
  const taskId = createTask(db, { kind: 'allocation', batchId, createdBy: actor.id, idempotencyKey: key });
  db.prepare('UPDATE background_tasks SET request_hash = ? WHERE id = ?').run(requestHash, taskId);

  // 用 setImmediate 让出当前调用栈：HTTP 响应先返回任务标识，计算随后在事件循环里执行
  setImmediate(() => {
    void executeAllocationTask(db, taskId, batchId, actor, options);
  });
  return { taskId, reused: false };
}

async function executeAllocationTask(
  db: SqliteDb,
  taskId: number,
  batchId: number,
  actor: AuthUser,
  options: StartTaskOptions,
): Promise<void> {
  markRunning(db, taskId);
  try {
    const result = await runAllocation(db, batchId, actor, {
      ...options,
      onProgress: (progress, total) => {
        db.prepare('UPDATE background_tasks SET progress = ?, total = ? WHERE id = ?').run(progress, total, taskId);
      },
    });
    if (result.status === 'failed') {
      const timedOut = result.failure?.code === 'TASK_TIMEOUT';
      markFinished(db, taskId, timedOut ? 'timeout' : 'failed', {
        runId: result.runId,
        result: { runId: result.runId, status: result.status, failure: result.failure },
        errorCode: result.failure?.code ?? 'INTERNAL',
        errorMessage: result.failure?.reason ?? '分配任务失败',
      });
      return;
    }
    markFinished(db, taskId, 'succeeded', {
      runId: result.runId,
      progress: 1,
      total: 1,
      result: {
        runId: result.runId,
        status: result.status,
        report: result.report,
        idempotentReplay: result.idempotentReplay,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && error.name === 'TaskTimeoutError' ? 'TASK_TIMEOUT' : 'INTERNAL';
    markFinished(db, taskId, code === 'TASK_TIMEOUT' ? 'timeout' : 'failed', {
      errorCode: code,
      errorMessage: message,
    });
    writeAudit(db, {
      actorId: actor.id,
      actorName: actor.username,
      action: 'task.failed',
      entityType: 'background_task',
      entityId: taskId,
      summary: `后台任务失败：${message}`,
    });
  }
}

/**
 * 程序重启后收尾：把上次进程遗留的 queued/running 任务标记为失败。
 * 未完成的正式落位不会发生，也不会重复落位。
 */
export function failInterruptedTasks(db: SqliteDb): number {
  const now = nowIso();
  const tasks = db
    .prepare("UPDATE background_tasks SET status = 'failed', error_code = 'TASK_INTERRUPTED', error_message = ?, finished_at = ? WHERE status IN ('queued', 'running')")
    .run('程序重启，未完成的任务已终止；正式落位未发生，可重新发起', now);
  const runs = db
    .prepare(
      `UPDATE allocation_runs SET status = 'failed', failure_code = 'TASK_INTERRUPTED', failure_reason = ?, finished_at = ?
       WHERE status = 'running'`,
    )
    .run('程序重启，计算中断', now);
  return tasks.changes + runs.changes;
}
