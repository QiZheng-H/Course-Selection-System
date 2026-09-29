/**
 * 专业课预分配：占正式容量，第一版通过批量导入结果并校验落实，保留可配置调整余量。
 *
 * “余量”（margin）的含义：管理员不希望预分配把教学班塞满，
 * 因此每个教学班实际可用的预分配上限 = 容量 - 毕业预留 - 余量。
 * 超出上限的记录会被标记为 failed，并给出原因，便于管理员调整。
 */
import type { SqliteDb } from '../../db/index.js';
import { nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { EnrollmentService } from '../enrollment/service.js';
import { getSeatUsage } from '../catalog/service.js';
import { config } from '../../config.js';

export interface PreallocationRow {
  id: number;
  studentId: number;
  studentNo: string;
  studentName: string;
  classId: number;
  classCode: string;
  courseId: number;
  courseName: string;
  capacity: number;
  reservedSeats: number;
  margin: number;
  status: 'pending' | 'applied' | 'failed' | 'reverted';
  failureCode: string | null;
  reason: string | null;
}


interface PendingPreallocation {
  id: number;
  studentId: number;
  classId: number;
  margin: number;
  classCode: string;
  courseName: string;
}

function loadPending(db: SqliteDb, batchId: number | null): PendingPreallocation[] {
  const where = batchId ? 'WHERE pr.status = ? AND pr.batch_id = ?' : 'WHERE pr.status = ?';
  const params = batchId ? ['pending', batchId] : ['pending'];
  return db
    .prepare(
      `SELECT pr.id, pr.student_id AS studentId, pr.class_id AS classId, pr.margin,
              tc.class_code AS classCode, c.name AS courseName
       FROM preallocation_results pr
       JOIN teaching_classes tc ON tc.id = pr.class_id
       JOIN courses c ON c.id = tc.course_id ${where} ORDER BY pr.id`,
    )
    .all(...params) as PendingPreallocation[];
}

/**
 * 某个教学班“还能接收多少条预分配”。
 * 口径：容量 - 毕业预留 - 管理员设置的调整余量 - 已被普通申请占用的名额。
 * 校验与落实共用这一个口径，避免“校验说不行、落实却做了”。
 */
export function preallocationCapacity(db: SqliteDb, classId: number, margin: number): number {
  const usage = getSeatUsage(db, classId);
  return Math.max(0, usage.capacity - usage.reservedSeats - margin - (usage.enrolled - usage.usedReserved));
}

export interface ValidationSummary {
  total: number;
  applicable: number;
  wouldFail: Array<{ id: number; studentNo: string; classCode: string; courseName: string; reason: string }>;
  byClass: Array<{ classId: number; classCode: string; courseName: string; limit: number; requested: number }>;
}

export function listPreallocations(
  db: SqliteDb,
  filter: { batchId?: number; status?: string; limit: number; offset: number },
): { items: PreallocationRow[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.batchId) {
    conditions.push('pr.batch_id = ?');
    params.push(filter.batchId);
  }
  if (filter.status) {
    conditions.push('pr.status = ?');
    params.push(filter.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM preallocation_results pr ${where}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT pr.id, pr.student_id AS studentId, s.student_no AS studentNo, s.name AS studentName,
              pr.class_id AS classId, tc.class_code AS classCode, tc.course_id AS courseId, c.name AS courseName,
              tc.capacity, tc.reserved_seats AS reservedSeats, pr.margin, pr.status,
              pr.failure_code AS failureCode, pr.reason
       FROM preallocation_results pr
       JOIN students s ON s.user_id = pr.student_id
       JOIN teaching_classes tc ON tc.id = pr.class_id
       JOIN courses c ON c.id = tc.course_id
       ${where} ORDER BY pr.id LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as PreallocationRow[];
  return { items: rows, total };
}

/** 校验：在不写库的前提下先算出哪些记录可落实、哪些会失败 */
export function validatePreallocations(db: SqliteDb, batchId: number | null): ValidationSummary {
  const rows = loadPending(db, batchId);
  const seatLeft = new Map<number, number>();
  const limitByClass = new Map<number, number>();
  const requestedByClass = new Map<number, number>();
  for (const row of rows) {
    requestedByClass.set(row.classId, (requestedByClass.get(row.classId) ?? 0) + 1);
    if (!seatLeft.has(row.classId)) {
      const limit = preallocationCapacity(db, row.classId, row.margin);
      seatLeft.set(row.classId, limit);
      limitByClass.set(row.classId, limit);
    }
  }

  const wouldFail: ValidationSummary['wouldFail'] = [];
  const applied: number[] = [];
  for (const row of rows) {
    const studentNo = (
      db.prepare('SELECT student_no FROM students WHERE user_id = ?').get(row.studentId) as { student_no: string }
    ).student_no;
    const left = seatLeft.get(row.classId) ?? 0;
    if (left <= 0) {
      wouldFail.push({
        id: row.id,
        studentNo,
        classCode: row.classCode,
        courseName: row.courseName,
        reason: '该教学班可用于预分配的名额已用完（已扣除毕业预留与调整余量）',
      });
      continue;
    }
    seatLeft.set(row.classId, left - 1);
    applied.push(row.id);
  }

  const byClass: ValidationSummary['byClass'] = [];
  for (const [classId, requested] of requestedByClass) {
    const sample = rows.find((r) => r.classId === classId)!;
    byClass.push({
      classId,
      classCode: sample.classCode,
      courseName: sample.courseName,
      limit: limitByClass.get(classId) ?? 0,
      requested,
    });
  }

  return { total: rows.length, applicable: applied.length, wouldFail, byClass };
}

/**
 * 落实预分配：通过正式选课服务占用名额。
 * 一次性提交，失败的行保留失败原因，成功的不回滚（管理员可重复执行补齐失败项）。
 */
export function applyPreallocations(
  db: SqliteDb,
  batchId: number | null,
  actor: AuthUser,
  options: { term?: string } = {},
): { applied: number; failed: number; failures: Array<{ id: number; reason: string }> } {
  const validation = validatePreallocations(db, batchId);
  const service = new EnrollmentService(db);
  const term = options.term ?? (db.prepare('SELECT term FROM teaching_classes ORDER BY id DESC LIMIT 1').get() as { term: string } | undefined)?.term ?? '2026-2027-1';
  const failures: Array<{ id: number; reason: string }> = [];
  let applied = 0;
  const now = nowIso();

  const rows = loadPending(db, batchId);
  // 落实阶段同样要遵守调整余量：先把“教室还能放几条”算清楚，超出的直接记为失败
  const seatLeft = new Map<number, number>();
  for (const row of rows) {
    if (!seatLeft.has(row.classId)) {
      seatLeft.set(row.classId, preallocationCapacity(db, row.classId, row.margin));
    }
  }

  for (const row of rows) {
    const left = seatLeft.get(row.classId) ?? 0;
    if (left <= 0) {
      const reason = '该教学班可用于预分配的名额已用完（已扣除毕业预留与调整余量）';
      failures.push({ id: row.id, reason });
      db.prepare("UPDATE preallocation_results SET status = 'failed', failure_code = 'MARGIN_EXCEEDED', reason = ? WHERE id = ?").run(
        reason,
        row.id,
      );
      continue;
    }
    seatLeft.set(row.classId, left - 1);

    const result = service.allocateTo(row.studentId, row.classId, {
      source: 'preallocation',
      opType: 'preallocate',
      actor,
      reason: '专业课预分配',
      allowReserved: false,
      idempotencyKey: `prealloc:${row.id}`,
    });
    if (result.ok) {
      applied += 1;
      db.prepare("UPDATE preallocation_results SET status = 'applied', applied_at = ?, reason = NULL, failure_code = NULL WHERE id = ?").run(
        now,
        row.id,
      );
    } else {
      failures.push({ id: row.id, reason: result.error?.message ?? '落实失败' });
      db.prepare("UPDATE preallocation_results SET status = 'failed', failure_code = ?, reason = ? WHERE id = ?").run(
        result.error?.code ?? 'FAILED',
        result.error?.message ?? '落实失败',
        row.id,
      );
    }
  }

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'preallocation.apply',
    entityType: 'selection_batch',
    entityId: batchId ?? 0,
    summary: `落实专业课预分配：成功 ${applied}，失败 ${failures.length}（校验阶段预计可落实 ${validation.applicable}）`,
    detail: { failures: failures.slice(0, 20), term },
  });

  return { applied, failed: failures.length, failures };
}

/** 撤销预分配（管理员操作；第一版只支持撤销未被学生后续改动的记录） */
export function revertPreallocation(db: SqliteDb, preallocationId: number, actor: AuthUser): { ok: boolean; message: string } {
  const row = db
    .prepare('SELECT id, student_id, class_id, status FROM preallocation_results WHERE id = ?')
    .get(preallocationId) as { id: number; student_id: number; class_id: number; status: string } | undefined;
  if (!row) return { ok: false, message: '预分配记录不存在' };
  if (row.status !== 'applied') return { ok: false, message: `当前状态为 ${row.status}，无需撤销` };
  const service = new EnrollmentService(db);
  const result = service.drop(row.student_id, row.class_id, {
    actor,
    reason: '管理员撤销预分配',
    allowFrozen: true,
    idempotencyKey: `prealloc-revert:${preallocationId}`,
    skipOperationLog: false,
  });
  if (!result.ok) return { ok: false, message: result.error?.message ?? '撤销失败' };
  db.prepare("UPDATE preallocation_results SET status = 'reverted', reason = ? WHERE id = ?").run('管理员撤销', preallocationId);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'preallocation.revert',
    entityType: 'preallocation_result',
    entityId: preallocationId,
    summary: '撤销一条专业课预分配',
  });
  return { ok: true, message: '已撤销' };
}

export function defaultMargin(): number {
  return config.preallocationMargin;
}
