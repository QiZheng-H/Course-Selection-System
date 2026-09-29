/**
 * 有明确含义的业务动作。
 *
 * 管理员不再选择 open / frozen / published 这些内部状态，也不再使用“强制执行”，
 * 而是按业务顺序点击：开放预选 → 结束提交并检查 → 生成分配方案 → 发布选课结果
 * → 开放退改选 → 结束本次选课；未发布结果前还可以“重新开放志愿提交”。
 *
 * 每个动作都在服务端完成必要校验并写审计日志，前端只负责确认与展示，
 * 因此直接调用接口也无法绕过阶段限制。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../core/errors.js';
import { nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import {
  batchStateLabel,
  checkConfig,
  closeBatchWaitlistEntries,
  getBatchDto,
  getBatchRow,
  transitionBatch,
  type BatchDto,
} from './service.js';
import { freezeBatch, publishRun } from '../allocation/service.js';
import { startAllocationTask } from '../tasks/service.js';
import { pendingConfirmations } from '../preference/service.js';
import { config } from '../../config.js';

function assertFuture(value: string | null | undefined, field: string): string {
  if (!value) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `请填写${field}`, 422);
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${field}格式不正确`, 422);
  if (time <= Date.now()) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${field}必须晚于当前时间`, 422);
  return new Date(time).toISOString();
}

/**
 * 检查并开放预选。
 * 检查课程/教学班资料与学分上限等必需配置，满足条件后开放学生提交志愿。
 */
export function openPreference(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  input: { closeAt?: string | null; reason?: string } = {},
): BatchDto {
  const row = getBatchRow(db, batchId);
  if (row.status !== 'preparing' && row.status !== 'preview') {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      `当前阶段是「${batchStateLabel(row.status)}」，不能重复开放预选`,
      409,
    );
  }
  const issues = checkConfig(db);
  if (issues.length > 0) {
    throw new AppError(ERROR_CODES.BATCH_CONFIG_MISSING, `资料或配置尚未齐全：${issues.join('；')}`, 409, { issues });
  }
  const closeAt = input.closeAt ? assertFuture(input.closeAt, '截止时间') : row.close_at;
  const now = nowIso();
  db.prepare("UPDATE selection_batches SET status = 'open', open_at = COALESCE(open_at, ?), close_at = ? WHERE id = ?").run(
    now,
    closeAt,
    batchId,
  );
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.open_preference',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `开放预选（${row.name}）`,
    detail: { closeAt, reason: input.reason ?? null },
  });
  return getBatchDto(db, batchId);
}

/**
 * 结束提交并检查：停止提交与撤回，生成本轮冻结快照，供生成分配方案使用。
 */
export function closeSubmissions(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  input: { reason?: string } = {},
): { batch: BatchDto; snapshotHash: string; students: number; classes: number } {
  const row = getBatchRow(db, batchId);
  if (row.status === 'preparing') {
    throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '资料准备阶段尚未开放志愿提交，不能结束提交', 409);
  }
  if (row.status !== 'preview' && row.status !== 'open') {
    throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, `当前阶段是「${batchStateLabel(row.status)}」，不能结束提交`, 409);
  }
  const pending = pendingConfirmations(db, batchId);
  if (pending.length > 0) {
    throw new AppError(
      ERROR_CODES.MATERIAL_NOT_CONFIRMED,
      `有 ${pending.length} 名已提交志愿的学生尚未确认个人修读记录，请先让他们确认后再结束提交`,
      409,
      { students: pending.slice(0, 20) },
    );
  }
  const frozen = freezeBatch(db, batchId, actor);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.close_submission',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `结束志愿提交并生成冻结快照（${frozen.summary.students} 名学生、${frozen.summary.classes} 个教学班）`,
    detail: { reason: input.reason ?? null, contentHash: frozen.contentHash },
  });
  return {
    batch: getBatchDto(db, batchId),
    snapshotHash: frozen.contentHash,
    students: frozen.summary.students,
    classes: frozen.summary.classes,
  };
}

/**
 * 开放退改选：与“发布结果”完全独立的管理员动作。
 * 在此之前学生只能查看结果，不能选退换，候补也不会自动递补。
 */
export function openChangeStage(db: SqliteDb, batchId: number, actor: AuthUser, input: { reason?: string } = {}): BatchDto {
  const row = getBatchRow(db, batchId);
  if (row.status === 'waitlist') return getBatchDto(db, batchId);
  if (row.status !== 'published') {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      row.status === 'preparing' || row.status === 'preview' || row.status === 'open'
        ? '还没有发布首轮结果，不能开放退改选'
        : '必须先发布首轮结果，才能开放退改选',
      409,
    );
  }
  const published = db
    .prepare("SELECT COUNT(*) AS c FROM allocation_runs WHERE batch_id = ? AND status = 'published'")
    .get(batchId) as { c: number };
  if (published.c === 0) {
    throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '还没有正式发布的结果，不能开放退改选', 409);
  }
  const updated = transitionBatch(db, batchId, 'waitlist', actor, { reason: input.reason });
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.open_change',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: '开放退改选：学生可以选退换课，候补开始自动递补',
    detail: { reason: input.reason ?? null },
  });
  return updated;
}

/** 结束本次选课：停止常规选退课与候补递补，保留历史 */
export function closeActivity(db: SqliteDb, batchId: number, actor: AuthUser, input: { reason?: string } = {}): BatchDto {
  const row = getBatchRow(db, batchId);
  if (row.status === 'closed') return getBatchDto(db, batchId);
  if (row.status !== 'waitlist' && row.status !== 'published') {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      `当前阶段是「${batchStateLabel(row.status)}」，还没有到可以结束的环节`,
      409,
    );
  }
  closeBatchWaitlistEntries(db, batchId);
  const now = nowIso();
  db.prepare("UPDATE selection_batches SET status = 'closed', closed_at = ? WHERE id = ?").run(now, batchId);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.close_activity',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: '结束本次选课，未完成的候补不再递补',
    detail: { reason: input.reason ?? null },
  });
  return getBatchDto(db, batchId);
}

export interface ReopenResult {
  batch: BatchDto;
  invalidatedSnapshots: number;
  invalidatedRuns: number;
  cancelledTasks: number;
  /** 保留的固定随机键数量（用于向管理员说明“固定随机信息已保留”） */
  keptRandomKeys: number;
}

/**
 * 重新开放志愿提交（仅在尚未发布结果时可用）。
 *
 * 这是一致的受控恢复，不是简单改状态：
 *   1. 保留已有志愿与学生固定随机键（不重新抽签）；
 *   2. 旧冻结快照与旧试算结果全部标记失效；
 *   3. 正在运行的任务标记取消，晚到的计算结果也不能发布；
 *   4. 阶段版本 +1，重新截止后按新的有效版本生成快照与方案；
 *   5. 记录操作者、原因与影响范围。
 */
export function reopenSubmissions(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  input: { closeAt?: string | null; reason?: string },
): ReopenResult {
  const row = getBatchRow(db, batchId);
  const published = db
    .prepare("SELECT COUNT(*) AS c FROM allocation_runs WHERE batch_id = ? AND status = 'published'")
    .get(batchId) as { c: number };
  if (row.status === 'published' || row.status === 'waitlist' || row.status === 'closed' || published.c > 0) {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      '结果已落实，当前版本不支持撤销整轮发布。可以创建下一次选课活动，已有的正式课程仍会保留。',
      409,
    );
  }
  if (row.status === 'preparing') {
    throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '还没有开放过志愿提交，请直接使用“检查并开放预选”', 409);
  }
  const closeAt = assertFuture(input.closeAt, '新的截止时间');
  const reason = input.reason?.trim() || '管理员重新开放志愿提交';
  const now = nowIso();

  const result = db.transaction((): Omit<ReopenResult, 'batch' | 'keptRandomKeys'> => {
    const cancelledTasks = db
      .prepare(
        `UPDATE background_tasks SET status = 'cancelled', error_code = 'STAGE_REOPENED', error_message = ?,
           finished_at = ? WHERE batch_id = ? AND kind = 'allocation' AND status IN ('queued', 'running')`,
      )
      .run('选课活动已重新开放志愿提交，本次计算不再有效', now, batchId).changes;

    const runningRuns = db
      .prepare(
        `UPDATE allocation_runs SET status = 'failed', failure_code = 'STAGE_REOPENED', failure_reason = ?,
           invalidated_at = ?, invalidated_reason = ?, finished_at = COALESCE(finished_at, ?)
         WHERE batch_id = ? AND status IN ('pending', 'running')`,
      )
      .run('选课活动已重新开放志愿提交，本次计算不再有效', now, reason, now, batchId).changes;

    const finishedRuns = db
      .prepare(
        `UPDATE allocation_runs SET invalidated_at = ?, invalidated_reason = ?
         WHERE batch_id = ? AND invalidated_at IS NULL AND status IN ('succeeded', 'rolled_back')`,
      )
      .run(now, reason, batchId).changes;

    const invalidatedSnapshots = db
      .prepare('UPDATE batch_snapshots SET invalidated_at = ?, invalidated_reason = ? WHERE batch_id = ? AND invalidated_at IS NULL')
      .run(now, reason, batchId).changes;

    db.prepare(
      `UPDATE selection_batches SET status = 'open', close_at = ?, open_at = COALESCE(open_at, ?),
         stage_revision = stage_revision + 1, reopen_count = reopen_count + 1,
         last_reopened_at = ?, last_reopen_reason = ? WHERE id = ?`,
    ).run(closeAt, now, now, reason, batchId);

    return {
      invalidatedSnapshots,
      invalidatedRuns: runningRuns + finishedRuns,
      cancelledTasks,
    };
  })();

  const keptRandomKeys = (
    db.prepare('SELECT COUNT(*) AS c FROM student_course_random_keys WHERE term = ?').get(row.term) as { c: number }
  ).c;

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.reopen_submission',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `重新开放志愿提交（保留已有志愿，作废 ${result.invalidatedRuns} 个旧方案、${result.invalidatedSnapshots} 份旧快照）`,
    detail: {
      reason,
      closeAt,
      newStageRevision: row.stage_revision + 1,
      invalidatedRuns: result.invalidatedRuns,
      invalidatedSnapshots: result.invalidatedSnapshots,
      cancelledTasks: result.cancelledTasks,
    },
  });

  return { batch: getBatchDto(db, batchId), ...result, keptRandomKeys };
}

/** 调整截止时间：只改时间，不影响已生成的方案与阶段版本 */
export function adjustDeadline(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  input: { closeAt?: string | null; reason?: string },
): BatchDto {
  const row = getBatchRow(db, batchId);
  if (row.status === 'frozen' || row.status === 'published' || row.status === 'waitlist' || row.status === 'closed') {
    throw notFoundOrConflict(row);
  }
  const closeAt = assertFuture(input.closeAt, '截止时间');
  db.prepare('UPDATE selection_batches SET close_at = ? WHERE id = ?').run(closeAt, batchId);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.adjust_deadline',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `调整志愿提交截止时间为 ${closeAt}`,
    detail: { reason: input.reason ?? null, closeAt },
  });
  return getBatchDto(db, batchId);
}

function notFoundOrConflict(row: { status: string }): AppError {
  return new AppError(
    ERROR_CODES.BATCH_STATE_INVALID,
    `当前阶段是「${batchStateLabel(row.status as never)}」，不能直接调整截止时间。如需重新允许提交，请使用“重新开放志愿提交”。`,
    409,
  );
}

/**
 * 生成分配方案（后台任务）。
 * 已经有排队/运行中的任务时直接复用，因此重复点击不会重复启动计算；
 * 刷新页面后可以通过工作台接口继续看到同一个任务的进度。
 */
export function generatePlan(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
): { taskId: number; reused: boolean } {
  const row = getBatchRow(db, batchId);
  if (row.status !== 'frozen') {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      `当前阶段是「${batchStateLabel(row.status)}」，需要先“结束提交并检查”才能生成分配方案`,
      409,
    );
  }
  const running = db
    .prepare(
      "SELECT id FROM background_tasks WHERE batch_id = ? AND kind = 'allocation' AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1",
    )
    .get(batchId) as { id: number } | undefined;
  if (running) return { taskId: running.id, reused: true };
  return startAllocationTask(db, batchId, actor, { mode: 'simulate', timeoutMs: config.taskTimeoutMs });
}

/**
 * 发布选课结果。发布的是“已经生成并检查通过的方案”，
 * 常规流程不提供“跳过审查的一键试算并发布”。
 * 发布后学生只能查看结果；开放退改选是另一个独立动作。
 */
export function publishResult(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  input: { runId?: number | null } = {},
): { runId: number; status: 'published'; report: unknown; idempotentReplay: boolean; alreadyPublished: boolean } {
  const row = getBatchRow(db, batchId);
  if (row.status !== 'frozen' && row.status !== 'published') {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      `当前阶段是「${batchStateLabel(row.status)}」，没有可发布的方案`,
      409,
    );
  }
  const runId =
    input.runId ??
    (
      db
        .prepare(
          "SELECT id FROM allocation_runs WHERE batch_id = ? AND status = 'succeeded' AND invalidated_at IS NULL ORDER BY id DESC LIMIT 1",
        )
        .get(batchId) as { id: number } | undefined
    )?.id;
  if (!runId) throw notFound('还没有检查通过的分配方案，请先生成分配方案');
  const result = publishRun(db, runId, actor);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'allocation.publish',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `发布选课结果（方案 #${runId}）`,
    detail: { report: result.report },
  });
  return {
    runId: result.runId,
    status: 'published',
    report: result.report,
    idempotentReplay: result.idempotentReplay,
    alreadyPublished: result.alreadyPublished,
  };
}

/** 供路由使用：按动作 key 分发 */
export function runNamedAction(
  db: SqliteDb,
  batchId: number,
  action: string,
  actor: AuthUser,
  body: Record<string, unknown>,
): unknown {
  const closeAt = typeof body.closeAt === 'string' ? body.closeAt : undefined;
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  switch (action) {
    case 'open-preference':
      return openPreference(db, batchId, actor, { closeAt, reason });
    case 'close-submission':
      return closeSubmissions(db, batchId, actor, { reason });
    case 'generate-plan':
      return generatePlan(db, batchId, actor);
    case 'publish-result':
      return publishResult(db, batchId, actor, { runId: typeof body.runId === 'number' ? body.runId : null });
    case 'open-change':
      return openChangeStage(db, batchId, actor, { reason });
    case 'close-activity':
      return closeActivity(db, batchId, actor, { reason });
    case 'reopen-submission':
      return reopenSubmissions(db, batchId, actor, { closeAt, reason });
    case 'adjust-deadline':
      return adjustDeadline(db, batchId, actor, { closeAt, reason });
    default:
      throw conflict(`未知的业务动作：${action}`);
  }
}

export { assertFuture };
