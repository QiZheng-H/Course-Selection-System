/**
 * 批次控制：资料准备 → 预览提交 → 截止冻结 → 发布 → 候补退改选 → 结束。
 *
 * 状态含义：
 *   preparing  资料准备中（不开放志愿提交）
 *   preview    预览开放，可以保存草稿并提交
 *   open       正式受理（可以提交、撤回）
 *   frozen     已截止冻结，分配期间禁止改选
 *   published  结果已发布，进入候补与退改选
 *   waitlist   候补调度阶段（与 published 的差别是明确开放公开补选）
 *   closed     批次结束
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../core/errors.js';
import { nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { countSubmissions, pendingConfirmations } from '../preference/service.js';

export type BatchStatus = 'preparing' | 'preview' | 'open' | 'frozen' | 'published' | 'waitlist' | 'closed';

const TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  preparing: ['preview', 'open'],
  preview: ['open', 'frozen'],
  open: ['frozen'],
  frozen: ['preview', 'published', 'open', 'waitlist'],
  published: ['waitlist', 'closed'],
  waitlist: ['closed', 'published'],
  closed: ['published'],
};

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

function toDto(db: SqliteDb, row: BatchRow): BatchDto {
  const snapshot = db.prepare('SELECT content_hash FROM batch_snapshots WHERE batch_id = ?').get(row.id) as
    | { content_hash: string }
    | undefined;
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
  };
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

export function transitionBatch(
  db: SqliteDb,
  batchId: number,
  target: BatchStatus,
  actor: AuthUser,
  options: { force?: boolean; reason?: string } = {},
): BatchDto {
  const row = db.prepare('SELECT * FROM selection_batches WHERE id = ?').get(batchId) as BatchRow | undefined;
  if (!row) throw notFound('批次不存在');
  if (row.status === target) return getBatchDto(db, batchId);
  const allowed = TRANSITIONS[row.status] ?? [];
  if (!allowed.includes(target) && !options.force) {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      `批次状态不能从 ${row.status} 直接变为 ${target}（允许：${allowed.join(', ') || '无'}）`,
      409,
    );
  }

  // 关键校验
  if (target === 'open' || target === 'preview') {
    const issues = checkConfig(db);
    if (issues.length > 0) {
      throw new AppError(ERROR_CODES.BATCH_CONFIG_MISSING, `必需配置缺失，不能开放批次：${issues.join('；')}`, 409, { issues });
    }
  }
  if (target === 'frozen') {
    const pending = pendingConfirmations(db, batchId);
    if (pending.length > 0) {
      throw new AppError(
        ERROR_CODES.MATERIAL_NOT_CONFIRMED,
        `有 ${pending.length} 名已提交志愿的学生尚未确认个人修读记录，冻结前需要先处理`,
        409,
        { students: pending.slice(0, 20) },
      );
    }
  }
  if (target === 'published') {
    // 发布必须由“发布指定的、检查通过的试算结果”完成；这里只确认该事务已经成功执行。
    // 不允许用通用 force 参数绕过必要校验。
    const run = db
      .prepare(
        "SELECT id, status FROM allocation_runs WHERE batch_id = ? AND mode IN ('simulate', 'publish') AND status = 'published' ORDER BY id DESC LIMIT 1",
      )
      .get(batchId) as { id: number; status: string } | undefined;
    if (!run) {
      throw new AppError(
        ERROR_CODES.BATCH_STATE_INVALID,
        '还没有成功发布的分配结果。请先试算、处理保障异常，再发布指定的试算结果',
        409,
      );
    }
  }
  if (target === 'closed') {
    // 结束后停止常规写操作：未完成的候补一律标记结束
    const now = nowIso();
    db.prepare(
      `UPDATE waitlist_entries SET status = 'closed', close_code = 'batch_closed', close_reason = ?, updated_at = ?
       WHERE batch_id = ? AND status IN ('queued', 'suspended')`,
    ).run('批次已结束，候补不再递补', now, batchId);
  }

  const now = nowIso();
  db.prepare('UPDATE selection_batches SET status = ? WHERE id = ?').run(target, batchId);
  if (target === 'published') {
    db.prepare('UPDATE selection_batches SET published_at = ? WHERE id = ?').run(now, batchId);
  }
  if (target === 'closed') {
    db.prepare('UPDATE selection_batches SET closed_at = ? WHERE id = ?').run(now, batchId);
  }

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.transition',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `批次状态 ${row.status} → ${target}`,
    detail: { reason: options.reason ?? null, force: options.force ?? false },
  });
  return getBatchDto(db, batchId);
}

export function updateBatch(
  db: SqliteDb,
  batchId: number,
  patch: Partial<CreateBatchInput>,
  actor: AuthUser,
): BatchDto {
  const row = db.prepare('SELECT * FROM selection_batches WHERE id = ?').get(batchId) as BatchRow | undefined;
  if (!row) throw notFound('批次不存在');
  if (row.status === 'closed') throw conflict('已结束的批次不能再修改');
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
    summary: '修改批次配置',
    detail: patch,
  });
  return getBatchDto(db, batchId);
}

export function batchStateLabel(status: BatchStatus): string {
  const labels: Record<BatchStatus, string> = {
    preparing: '资料准备',
    preview: '预览可提交',
    open: '正式受理',
    frozen: '已截止冻结',
    published: '结果已发布',
    waitlist: '候补与补选',
    closed: '已结束',
  };
  return labels[status];
}

export function canStudentEdit(status: BatchStatus): boolean {
  return status === 'preview' || status === 'open';
}

export function canStudentEnroll(status: BatchStatus): boolean {
  return status === 'published' || status === 'waitlist';
}
