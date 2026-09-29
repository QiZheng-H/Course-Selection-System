/**
 * 选课活动（内部仍称“批次”）控制：资料准备 → 开放预选 → 截止冻结 → 生成方案 → 发布结果 → 开放退改选 → 结束。
 *
 * 状态含义（对管理员显示的业务名称见 batchStateLabel）：
 *   preparing  资料准备中（不开放志愿提交）
 *   preview    预览开放，可以保存草稿并提交
 *   open       预选进行中（正式受理：可以提交、撤回）
 *   frozen     已结束提交，等待生成/发布分配方案
 *   published  结果已公布，学生只能查看；**尚未开放退改选**
 *   waitlist   退改选进行中（管理员主动开放后学生才能选退换、候补才会递补）
 *   closed     本次选课已结束
 *
 * 关键约定：published 与 waitlist 是两个不同阶段。
 * 发布结果不等于开放退改选，学生端与后端写接口都必须按阶段判断。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../core/errors.js';
import { nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { countSubmissions, pendingConfirmations } from '../preference/service.js';

export type BatchStatus = 'preparing' | 'preview' | 'open' | 'frozen' | 'published' | 'waitlist' | 'closed';

/**
 * 允许的通用状态流转（不含“强制执行”）。
 *
 * 设计原则：所有会改变学生可用权限、或会作废已生成结果的推进，
 * 都必须走有明确业务含义的动作（开放预选 / 结束提交 / 生成方案 / 发布结果 /
 * 开放退改选 / 结束活动 / 重新开放提交），不能靠改状态绕过：
 *   - frozen 与 closed 不再允许直接改到其它状态；
 *   - published 只能由“发布结果”事务写入，退回首轮没有普通入口；
 *   - closed → published 这种“重开本轮”的路径已移除。
 */
const TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  preparing: ['preview', 'open'],
  preview: ['open', 'frozen'],
  open: ['frozen'],
  frozen: [],
  published: ['waitlist', 'closed'],
  waitlist: ['closed'],
  closed: [],
};

/**
 * 结束提交需要生成冻结快照，而快照逻辑在分配模块。
 * 为避免模块循环依赖，这里用注册回调的方式调用（与候补提升的注册方式一致）。
 */
type FreezeHandler = (db: SqliteDb, batchId: number, actor: AuthUser, options?: { force?: boolean }) => unknown;
let freezeHandler: FreezeHandler | null = null;

/** 由分配模块在启动时注册，使“结束提交并检查”始终生成快照 */
export function registerFreezeHandler(handler: FreezeHandler): void {
  freezeHandler = handler;
}

export interface BatchRow {
  id: number;
  term: string;
  name: string;
  status: BatchStatus;
  credit_limit: number;
  open_at: string | null;
  close_at: string | null;
  published_at: string | null;
  closed_at: string | null;
  config_version_id: number | null;
  note: string | null;
  created_at: string;
  stage_revision: number;
  reopen_count: number;
  last_reopened_at: string | null;
  last_reopen_reason: string | null;
}

export interface BatchDto {
  id: number;
  term: string;
  name: string;
  status: BatchStatus;
  creditLimit: number;
  openAt: string | null;
  closeAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  note: string | null;
  createdAt: string;
  submissions: { submitted: number; withdrawn: number; students: number };
  snapshotHash: string | null;
  /** 关键配置是否齐全：缺失时不开放批次 */
  configReady: boolean;
  configIssues: string[];
  /** 阶段版本：重新开放志愿提交会 +1，用于判断旧试算是否失效 */
  stageRevision: number;
  reopenCount: number;
  lastReopenedAt: string | null;
  lastReopenReason: string | null;
  /** 是否存在未失效的冻结快照 */
  hasActiveSnapshot: boolean;
  /** 是否已经发布过正式结果 */
  publishedRunId: number | null;
}

export function listBatches(db: SqliteDb): BatchDto[] {
  const rows = db.prepare('SELECT * FROM selection_batches ORDER BY id DESC').all() as BatchRow[];
  return rows.map((row) => toDto(db, row));
}

export function getBatchDto(db: SqliteDb, batchId: number): BatchDto {
  const row = db.prepare('SELECT * FROM selection_batches WHERE id = ?').get(batchId) as BatchRow | undefined;
  if (!row) throw notFound('批次不存在');
  return toDto(db, row);
}

export function getCurrentBatch(db: SqliteDb, term?: string): BatchDto | null {
  const row = term
    ? (db.prepare('SELECT * FROM selection_batches WHERE term = ? ORDER BY id DESC LIMIT 1').get(term) as BatchRow | undefined)
    : (db
        .prepare("SELECT * FROM selection_batches WHERE status NOT IN ('closed') ORDER BY id DESC LIMIT 1")
        .get() as BatchRow | undefined);
  return row ? toDto(db, row) : null;
}

/** 取指定活动；没有传 id 时退回“当前活动”，两者都没有则返回 null */
export function resolveBatch(db: SqliteDb, batchId?: number | null): BatchDto | null {
  if (batchId) return getBatchDto(db, batchId);
  return getCurrentBatch(db);
}

function toDto(db: SqliteDb, row: BatchRow): BatchDto {
  const snapshot = db
    .prepare('SELECT content_hash FROM batch_snapshots WHERE batch_id = ? AND invalidated_at IS NULL')
    .get(row.id) as { content_hash: string } | undefined;
  const publishedRun = db
    .prepare("SELECT id FROM allocation_runs WHERE batch_id = ? AND status = 'published' ORDER BY id DESC LIMIT 1")
    .get(row.id) as { id: number } | undefined;
  const configIssues = checkConfig(db);
  return {
    id: row.id,
    term: row.term,
    name: row.name,
    status: row.status,
    creditLimit: row.credit_limit,
    openAt: row.open_at,
    closeAt: row.close_at,
    publishedAt: row.published_at,
    closedAt: row.closed_at,
    note: row.note,
    createdAt: row.created_at,
    submissions: countSubmissions(db, row.id),
    snapshotHash: snapshot?.content_hash ?? null,
    configReady: configIssues.length === 0,
    configIssues,
    stageRevision: row.stage_revision ?? 1,
    reopenCount: row.reopen_count ?? 0,
    lastReopenedAt: row.last_reopened_at ?? null,
    lastReopenReason: row.last_reopen_reason ?? null,
    hasActiveSnapshot: Boolean(snapshot),
    publishedRunId: publishedRun?.id ?? null,
  };
}

/** 取原始批次行（需要判断当前阶段版本时使用） */
export function getBatchRow(db: SqliteDb, batchId: number): BatchRow {
  const row = db.prepare('SELECT * FROM selection_batches WHERE id = ?').get(batchId) as BatchRow | undefined;
  if (!row) throw notFound('选课活动不存在');
  return row;
}

/**
 * 必需配置检查：学分上限、开放时间等由管理员配置；
 * 必需配置缺失时不开放批次（需求明确要求）。
 */
export function checkConfig(db: SqliteDb): string[] {
  const issues: string[] = [];
  const creditLimit = db.prepare("SELECT value FROM app_configs WHERE key = 'credit_limit_default'").get() as
    | { value: string }
    | undefined;
  if (!creditLimit || !(Number.parseFloat(creditLimit.value) > 0)) {
    issues.push('缺少学分上限配置（credit_limit_default）');
  }
  const hasClass = (db.prepare('SELECT COUNT(*) AS c FROM teaching_classes').get() as { c: number }).c > 0;
  if (!hasClass) {
    issues.push('教学班资料为空，请先导入或核对教学班数据');
  }
  return issues;
}

export interface CreateBatchInput {
  term: string;
  name: string;
  creditLimit?: number;
  openAt?: string | null;
  closeAt?: string | null;
  note?: string | null;
}

export function createBatch(db: SqliteDb, input: CreateBatchInput, actor: AuthUser): BatchDto {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO selection_batches (term, name, status, credit_limit, open_at, close_at, note, created_by, created_at)
       VALUES (?, ?, 'preparing', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.term,
      input.name,
      input.creditLimit ?? 30,
      input.openAt ?? null,
      input.closeAt ?? null,
      input.note ?? null,
      actor.id,
      now,
    );
  const batchId = Number(info.lastInsertRowid);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.create',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `创建选课批次「${input.name}」（${input.term}）`,
  });
  return getBatchDto(db, batchId);
}

/**
 * 通用状态流转（兼容旧调用方）。
 *
 * 注意：这里**故意不再支持 force 绕过**。旧的“强制执行 + 任意目标状态下拉框”
 * 既跳过了必需配置/资料确认等保护性校验，也让管理员可以不理解业务就改状态。
 * 现在请改用有明确含义的动作：
 *   开放预选 openPreference / 结束提交并检查 closeSubmissions /
 *   发布结果 publishRun / 开放退改选 openChangeStage /
 *   结束本次选课 closeActivity / 重新开放志愿提交 reopenSubmissions。
 */
export function transitionBatch(
  db: SqliteDb,
  batchId: number,
  target: BatchStatus,
  actor: AuthUser,
  options: { reason?: string } = {},
): BatchDto {
  const row = getBatchRow(db, batchId);
  if (row.status === target) return getBatchDto(db, batchId);
  const allowed = TRANSITIONS[row.status] ?? [];
  if (!allowed.includes(target)) {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      `当前阶段是「${batchStateLabel(row.status)}」，不能直接切换到「${batchStateLabel(target)}」。请使用页面上的下一步操作。`,
      409,
      { allowed, current: row.status, target },
    );
  }

  // 关键校验
  if (target === 'open' || target === 'preview') {
    const issues = checkConfig(db);
    if (issues.length > 0) {
      throw new AppError(ERROR_CODES.BATCH_CONFIG_MISSING, `必需配置缺失，不能开放批次：${issues.join('；')}`, 409, { issues });
    }
    // 已有冻结快照时不允许用通用流转回到提交阶段：必须走“重新开放志愿提交”，
    // 否则旧快照与旧试算不会被标记失效，可能出现“用过期输入生成的结果”。
    const snapshot = db
      .prepare('SELECT id FROM batch_snapshots WHERE batch_id = ? AND invalidated_at IS NULL')
      .get(batchId);
    if (snapshot) {
      throw new AppError(
        ERROR_CODES.BATCH_STATE_INVALID,
        '该选课活动已经生成过冻结快照。请使用“重新开放志愿提交”，系统会保留已有志愿并作废旧方案。',
        409,
      );
    }
  }
  if (target === 'frozen') {
    const pending = pendingConfirmations(db, batchId);
    if (pending.length > 0) {
      throw new AppError(
        ERROR_CODES.MATERIAL_NOT_CONFIRMED,
        `有 ${pending.length} 名已提交志愿的学生尚未确认个人修读记录，结束提交前需要先处理`,
        409,
        { students: pending.slice(0, 20) },
      );
    }
    // 结束提交必须同时生成冻结快照，否则后续“生成分配方案”将缺少输入
    if (freezeHandler) {
      freezeHandler(db, batchId, actor);
      writeAudit(db, {
        actorId: actor.id,
        actorName: actor.username,
        action: 'batch.transition',
        entityType: 'selection_batch',
        entityId: batchId,
        summary: `批次状态 ${row.status} → ${target}`,
        detail: { reason: options.reason ?? null },
      });
      return getBatchDto(db, batchId);
    }
  }

  const now = nowIso();
  db.prepare('UPDATE selection_batches SET status = ? WHERE id = ?').run(target, batchId);
  if (target === 'published') {
    db.prepare('UPDATE selection_batches SET published_at = ? WHERE id = ?').run(now, batchId);
  }
  if (target === 'closed') {
    closeBatchWaitlistEntries(db, batchId);
    db.prepare('UPDATE selection_batches SET closed_at = ? WHERE id = ?').run(now, batchId);
  }

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.transition',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `批次状态 ${row.status} → ${target}`,
    detail: { reason: options.reason ?? null },
  });
  return getBatchDto(db, batchId);
}

/** 结束活动时停止递补：未完成的候补一律标记结束 */
export function closeBatchWaitlistEntries(db: SqliteDb, batchId: number): void {
  db.prepare(
    `UPDATE waitlist_entries SET status = 'closed', close_code = 'batch_closed', close_reason = ?, updated_at = ?
     WHERE batch_id = ? AND status IN ('queued', 'suspended')`,
  ).run('本次选课已结束，候补不再递补', nowIso(), batchId);
}

export function updateBatch(
  db: SqliteDb,
  batchId: number,
  patch: Partial<CreateBatchInput>,
  actor: AuthUser,
): BatchDto {
  const row = getBatchRow(db, batchId);
  // 只有“还没结束志愿提交”的阶段才允许直接改配置。
  // 结束提交之后要改截止时间，必须走“重新开放志愿提交”，
  // 否则会出现“改了截止时间但快照/方案没跟着失效”的不一致。
  if (row.status === 'frozen' || row.status === 'published' || row.status === 'waitlist' || row.status === 'closed') {
    throw conflict(
      `当前阶段是「${batchStateLabel(row.status)}」，不能直接修改配置。如需重新允许提交志愿，请使用“重新开放志愿提交”。`,
    );
  }
  db.prepare(
    `UPDATE selection_batches SET name = COALESCE(?, name), credit_limit = COALESCE(?, credit_limit),
       open_at = COALESCE(?, open_at), close_at = COALESCE(?, close_at), note = COALESCE(?, note) WHERE id = ?`,
  ).run(
    patch.name ?? null,
    patch.creditLimit ?? null,
    patch.openAt === undefined ? null : patch.openAt,
    patch.closeAt === undefined ? null : patch.closeAt,
    patch.note === undefined ? null : patch.note,
    batchId,
  );
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.update',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: '修改选课活动设置',
    detail: patch,
  });
  return getBatchDto(db, batchId);
}

/** 面向管理员与学生的业务名称（不是内部状态名） */
export function batchStateLabel(status: BatchStatus): string {
  const labels: Record<BatchStatus, string> = {
    preparing: '资料准备',
    preview: '预选进行中',
    open: '预选进行中',
    frozen: '已结束提交，待生成方案',
    published: '结果已公布（退改选未开放）',
    waitlist: '退改选进行中',
    closed: '已结束',
  };
  return labels[status];
}

/** 学生是否可以提交/撤回志愿 */
export function canStudentEdit(status: BatchStatus): boolean {
  return status === 'preview' || status === 'open';
}

/**
 * 学生是否可以正式选退换课。
 * 只有管理员主动“开放退改选”（waitlist 阶段）后才可以；
 * 首轮结果刚发布（published）时学生只能查看结果。
 */
export function canStudentEnroll(status: BatchStatus): boolean {
  return status === 'waitlist';
}

/** 候补是否允许编辑与递补：与正式选退课保持一致 */
export function canWaitlistOperate(status: BatchStatus): boolean {
  return status === 'waitlist';
}
