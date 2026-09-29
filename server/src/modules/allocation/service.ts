/**
 * 统一分配与毕业保障。
 *
 * 分配使用的输入全部来自“冻结快照”：冻结之后即使有人修改资料、重新提交或新增选课，
 * 都不会影响本轮结果（这是验收要求“提交先后不影响首轮结果”的前提）。
 *
 * 排序规则（与业务基线一致）：
 *   竞争单位是“具体课程申请”（一名学生的一门课程），而不是学生。
 *   比较顺序：培养需求等级（D2 > D1 > D0） → 该课程在该学生志愿中的全局排名 → 固定随机键。
 *   因此不会出现“某门课需求高，就把该学生所有申请都提前处理”的情况。
 *
 * 需求等级是动态的：每次成功落实后，用“已有安排 + 本轮已落实结果”重算剩余需求，
 * 未落实的志愿不参与抵扣。
 *
 * 流程：
 *   ① 在冻结快照上按优先级逐项尝试普通竞争；
 *   ② 普通竞争结束后处理尚未落实的毕业兜底（需要学生兜底授权，先普通名额后预留）；
 *   ③ 生成预留释放计划（正式状态只在发布事务里改写）；
 *   ④ 发布时用一个事务完成落位、保护状态、预留释放、候补生成与批次发布。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../core/errors.js';
import { contentHash, Deadline, nowIso, randomToken, stableStringify, unique } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { classSessions } from '../catalog/seat-utils.js';
import {
  buildDemandContext,
  checkGraduationFeasibility,
  computeDemandLevels,
  keysIntersect,
  occupancyKeys,
  type DemandAssessment,
  type DemandContext,
  type DemandLevel,
} from '../rules/service.js';
import { EnrollmentService, type OperationResult } from '../enrollment/service.js';
import { loadSubmissionPayload } from '../preference/service.js';
import { getSeatUsage } from '../catalog/service.js';
import { enqueueRejectedFromAllocation } from '../waitlist/service.js';

export interface SnapshotSession {
  day_of_week: number;
  period_start: number;
  period_end: number;
  week_start: number;
  week_end: number;
  week_parity: string;
}

export interface SnapshotClass {
  classId: number;
  courseId: number;
  classCode: string;
  courseName: string;
  credits: number;
  capacity: number;
  reservedSeats: number;
  status: string;
  sessions: SnapshotSession[];
}

export interface SnapshotPreference {
  preferenceId: number | null;
  courseId: number;
  courseName: string;
  credits: number;
  globalRank: number;
  groupCode: string | null;
  classIds: number[];
}

export interface SnapshotStudent {
  studentId: number;
  studentNo: string;
  name: string;
  submissionId: number;
  versionNo: number;
  preferences: SnapshotPreference[];
  /** 冻结时已经正式选上的教学班（预分配 / 已选），不可为了本志愿退课 */
  existingClasses: Array<{ classId: number; courseId: number; credits: number }>;
  /** 培养需求计算上下文（已通过 / 在修 / 已选，不含未落实志愿） */
  demandContext: DemandContext;
  randomKeys: Record<string, string>;
}

export interface SnapshotReservation {
  courseId: number;
  courseName: string;
  studentIds: number[];
}

/** 毕业兜底授权（与课程替换授权分开建模） */
export interface SnapshotGuaranteeAuthorization {
  studentId: number;
  courseId: number;
  classIds: number[];
  expiresAt: string | null;
}

export interface SnapshotPayload {
  batchId: number;
  term: string;
  frozenAt: string;
  creditLimit: number;
  classes: SnapshotClass[];
  students: SnapshotStudent[];
  reservations: SnapshotReservation[];
  guaranteeAuthorizations: SnapshotGuaranteeAuthorization[];
  /** 冻结时每门课程普通名额的使用情况（分配时的起点；预分配已经计入其中） */
  seatUsage: Array<{ classId: number; capacity: number; reservedSeats: number; enrolled: number; usedReserved: number }>;
}

export interface AllocationDecision {
  studentId: number;
  courseId: number;
  courseName: string;
  preferenceId: number | null;
  classId: number | null;
  classCode: string | null;
  groupId: number | null;
  groupCode: string | null;
  demandLevel: DemandLevel;
  globalRank: number;
  randomKey: string;
  decision: 'allocated' | 'rejected' | 'waitlisted' | 'error';
  reasonCode: string;
  reason: string;
  scoreTrace: Record<string, unknown>;
  /** 是否为“毕业保障兜底”的结论（发布时据此决定是否允许使用预留名额） */
  guarantee?: boolean;
}

export interface AllocationReport {
  batchId: number;
  snapshotHash: string;
  totalStudents: number;
  totalPreferences: number;
  allocated: number;
  rejected: number;
  guaranteeAttempted: number;
  guaranteeFulfilled: number;
  releasedReservedSeats: number;
  exceptions: Array<{
    kind: string;
    severity: 'info' | 'warning' | 'critical';
    studentId: number | null;
    courseId: number | null;
    detail: Record<string, unknown>;
  }>;
  conflictsSample: Array<Record<string, unknown>>;
  durationMs: number;
}

export const RESERVATION_KINDS = {
  noSolution: 'guarantee_no_solution',
  noAuthorization: 'guarantee_no_authorization',
  rejectedAll: 'guarantee_rejected_all',
  notSubmitted: 'guarantee_not_submitted',
  timeout: 'allocation_timeout',
  classCancelled: 'class_cancelled',
  inconsistent: 'data_inconsistent',
} as const;

/** 冻结批次：把本轮分配需要的一切输入写成快照，并固定随机信息 */
export function freezeBatch(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  options: { force?: boolean } = {},
): { snapshotId: number; contentHash: string; summary: Record<string, number> } {
  const batch = db.prepare('SELECT id, term, status FROM selection_batches WHERE id = ?').get(batchId) as
    | { id: number; term: string; status: string }
    | undefined;
  if (!batch) throw notFound('批次不存在');
  if (batch.status === 'frozen' || batch.status === 'published') {
    throw conflict('该批次已经冻结，如需重新计算请在试算/发布时新建一次执行记录');
  }
  if (batch.status === 'preparing') {
    throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '资料准备阶段尚未开放志愿，不能冻结', 409);
  }
  const existing = db.prepare('SELECT id FROM batch_snapshots WHERE batch_id = ?').get(batchId);
  if (existing && !options.force) {
    throw conflict('该批次已有冻结快照；如需重新冻结请显式确认（会导致旧结果作废）');
  }

  const build = (): SnapshotPayload => {
    const classes = db
      .prepare(
        `SELECT tc.id AS classId, tc.course_id AS courseId, tc.class_code AS classCode, c.name AS courseName,
                c.credits, tc.capacity, tc.reserved_seats AS reservedSeats, tc.status
         FROM teaching_classes tc JOIN courses c ON c.id = tc.course_id
         WHERE tc.term = ? ORDER BY tc.id`,
      )
      .all(batch.term) as Array<{
      classId: number;
      courseId: number;
      classCode: string;
      courseName: string;
      credits: number;
      capacity: number;
      reservedSeats: number;
      status: string;
    }>;
    const sessionMap = classSessions(
      db,
      classes.map((c) => c.classId),
    );

    const submissionRows = db
      .prepare(
        `SELECT ps.id, ps.student_id, ps.version_no, s.student_no, s.name
         FROM preference_submissions ps JOIN students s ON s.user_id = ps.student_id
         WHERE ps.batch_id = ? AND ps.status = 'submitted' ORDER BY ps.student_id`,
      )
      .all(batchId) as Array<{ id: number; student_id: number; version_no: number; student_no: string; name: string }>;

    const students: SnapshotStudent[] = [];
    for (const row of submissionRows) {
      const payload = loadSubmissionPayload(db, row.id);
      const courseIds = payload.preferences.map((p) => p.courseId);
      const courseNameById = new Map(
        (
          db
            .prepare(
              `SELECT id, name, credits FROM courses WHERE id IN (${courseIds.map(() => '?').join(',') || 'NULL'})`,
            )
            .all(...courseIds) as Array<{ id: number; name: string; credits: number }>
        ).map((c) => [c.id, c]),
      );
      // 需求基线只统计“已有安排”（已通过 / 在修 / 已选），
      // 绝不把本轮志愿当作已落实学分，否则未落实申请会抵扣培养缺口。
      const demandContext = buildDemandContext(db, row.student_id, { term: batch.term });

      const randomKeys: Record<string, string> = {};
      const keyRows = db
        .prepare(
          `SELECT course_id, random_key FROM student_course_random_keys
           WHERE student_id = ? AND term = ? AND course_id IN (${courseIds.map(() => '?').join(',') || 'NULL'})`,
        )
        .all(row.student_id, batch.term, ...courseIds) as Array<{ course_id: number; random_key: string }>;
      for (const key of keyRows) randomKeys[String(key.course_id)] = key.random_key;

      const existing = db
        .prepare(
          `SELECT e.class_id, e.course_id, c.credits
           FROM enrollments e JOIN courses c ON c.id = e.course_id
           WHERE e.student_id = ? AND e.status = 'enrolled' ORDER BY e.id`,
        )
        .all(row.student_id) as Array<{ class_id: number; course_id: number; credits: number }>;

      const preferenceIdRows = db
        .prepare('SELECT id, course_id FROM preferences WHERE submission_id = ?')
        .all(row.id) as Array<{ id: number; course_id: number }>;
      const preferenceIdByCourse = new Map(preferenceIdRows.map((p) => [p.course_id, p.id]));

      students.push({
        studentId: row.student_id,
        studentNo: row.student_no,
        name: row.name,
        submissionId: row.id,
        versionNo: row.version_no,
        preferences: payload.preferences
          .map((pref) => ({
            preferenceId: preferenceIdByCourse.get(pref.courseId) ?? null,
            courseId: pref.courseId,
            courseName: courseNameById.get(pref.courseId)?.name ?? String(pref.courseId),
            credits: courseNameById.get(pref.courseId)?.credits ?? 0,
            globalRank: pref.globalRank,
            groupCode: pref.groupCode ?? null,
            classIds: pref.classIds ?? [],
          }))
          .sort((a, b) => a.globalRank - b.globalRank),
        existingClasses: existing.map((e) => ({ classId: e.class_id, courseId: e.course_id, credits: e.credits })),
        demandContext,
        randomKeys,
      });
    }

    const reservationRows = db
      .prepare(
        `SELECT gr.course_id, c.name AS course_name, gr.student_id
         FROM graduation_reservations gr JOIN courses c ON c.id = gr.course_id
         WHERE gr.batch_id = ? AND gr.status = 'active' ORDER BY gr.course_id, gr.student_id`,
      )
      .all(batchId) as Array<{ course_id: number; course_name: string; student_id: number }>;
    const reservationMap = new Map<number, { courseName: string; studentIds: number[] }>();
    for (const row of reservationRows) {
      const entry = reservationMap.get(row.course_id) ?? { courseName: row.course_name, studentIds: [] };
      entry.studentIds.push(row.student_id);
      reservationMap.set(row.course_id, entry);
    }

    const authorizationRows = db
      .prepare(
        `SELECT student_id, course_id, class_ids, expires_at FROM guarantee_authorizations
         WHERE batch_id = ? AND status = 'active' ORDER BY student_id, course_id`,
      )
      .all(batchId) as Array<{ student_id: number; course_id: number; class_ids: string; expires_at: string | null }>;
    const guaranteeAuthorizations: SnapshotGuaranteeAuthorization[] = authorizationRows.map((row) => ({
      studentId: row.student_id,
      courseId: row.course_id,
      classIds: safeParseNumberArray(row.class_ids),
      expiresAt: row.expires_at,
    }));

    const seatUsage = classes.map((cls) => {
      const usage = getSeatUsage(db, cls.classId);
      return {
        classId: cls.classId,
        capacity: usage.capacity,
        reservedSeats: usage.reservedSeats,
        enrolled: usage.enrolled,
        usedReserved: usage.usedReserved,
      };
    });

    return {
      batchId,
      term: batch.term,
      frozenAt: nowIso(),
      creditLimit: readCreditLimit(db),
      classes: classes.map((cls) => ({
        ...cls,
        sessions: (sessionMap.get(cls.classId) ?? []).map((s) => ({
          day_of_week: s.day_of_week,
          period_start: s.period_start,
          period_end: s.period_end,
          week_start: s.week_start,
          week_end: s.week_end,
          week_parity: s.week_parity,
        })),
      })),
      students,
      reservations: Array.from(reservationMap.entries()).map(([courseId, entry]) => ({
        courseId,
        courseName: entry.courseName,
        studentIds: entry.studentIds,
      })),
      guaranteeAuthorizations,
      seatUsage,
    };
  };

  const payload = build();
  const hash = contentHash(payload);
  const snapshotId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO batch_snapshots (batch_id, content_hash, payload, rng_seed, frozen_by, frozen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (batch_id) DO UPDATE SET content_hash = excluded.content_hash, payload = excluded.payload,
           rng_seed = excluded.rng_seed, frozen_by = excluded.frozen_by, frozen_at = excluded.frozen_at`,
      )
      .run(batchId, hash, stableStringify(payload), randomToken(16), actor.id, payload.frozenAt);
    db.prepare("UPDATE selection_batches SET status = 'frozen' WHERE id = ?").run(batchId);
    return (
      Number(info.lastInsertRowid) ||
      (db.prepare('SELECT id FROM batch_snapshots WHERE batch_id = ?').get(batchId) as { id: number }).id
    );
  })();

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'batch.freeze',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `冻结批次：${payload.students.length} 名学生、${payload.classes.length} 个教学班`,
    detail: { snapshotHash: hash },
  });

  return {
    snapshotId,
    contentHash: hash,
    summary: {
      students: payload.students.length,
      classes: payload.classes.length,
      reservations: payload.reservations.reduce((sum, r) => sum + r.studentIds.length, 0),
    },
  };
}

function safeParseNumberArray(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => Number(v)).filter((v) => Number.isInteger(v));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 分配执行
// ---------------------------------------------------------------------------

interface WorkingStudent {
  studentId: number;
  preferences: SnapshotPreference[];
  demandContext: DemandContext;
  randomKeys: Record<string, string>;
  /** 已有安排 + 本轮已落实的课程 */
  arrangement: Set<number>;
  assignedClasses: Map<number, number>;
  occupancy: Set<string>;
  credits: number;
  demandLevels: Map<number, DemandAssessment>;
}

export interface RunAllocationOptions {
  mode?: 'simulate' | 'publish';
  timeoutMs?: number;
  idempotencyKey?: string;
  /** 发布指定的试算结果（runId）；不传时本次计算同时发布 */
  sourceRunId?: number;
  onProgress?: (progress: number, total: number) => void;
}

export interface RunResult {
  runId: number;
  status: 'succeeded' | 'failed' | 'published';
  report: AllocationReport | null;
  failure?: { code: string; reason: string };
  idempotentReplay: boolean;
}


async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function runAllocation(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  options: RunAllocationOptions = {},
): Promise<RunResult> {
  const mode = options.mode ?? 'simulate';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const snapshot = db.prepare('SELECT id, content_hash, payload FROM batch_snapshots WHERE batch_id = ?').get(batchId) as
    | { id: number; content_hash: string; payload: string }
    | undefined;
  if (!snapshot) {
    throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '请先冻结批次生成快照，再进行试算或发布', 409);
  }

  // 发布指定的、检查通过的试算结果（不重新计算）
  if (mode === 'publish' && options.sourceRunId) {
    const published = publishRun(db, options.sourceRunId, actor);
    return {
      runId: published.runId,
      status: 'published',
      report: published.report,
      idempotentReplay: published.idempotentReplay,
    };
  }

  const requestHash = contentHash({
    batchId,
    mode,
    timeoutMs,
    sourceRunId: options.sourceRunId ?? null,
  });

  if (options.idempotencyKey) {
    const existing = db
      .prepare(
        `SELECT id, batch_id, mode, status, result_summary, report, snapshot_hash, request_hash
         FROM allocation_runs WHERE idempotency_key = ?`,
      )
      .get(options.idempotencyKey) as
      | {
          id: number;
          batch_id: number;
          mode: string;
          status: string;
          result_summary: string | null;
          report: string | null;
          snapshot_hash: string | null;
          request_hash: string | null;
        }
      | undefined;
    if (existing) {
      // 同一个幂等键用于不同批次、模式或请求内容时必须拒绝，避免“重放成另一次操作”
      if (existing.batch_id !== batchId || existing.mode !== mode || (existing.request_hash && existing.request_hash !== requestHash)) {
        throw new AppError(
          ERROR_CODES.IDEMPOTENCY_MISMATCH,
          '该幂等键已用于不同的批次、模式或请求内容，请更换幂等键后重试',
          409,
        );
      }
      if (existing.snapshot_hash && existing.snapshot_hash !== snapshot.content_hash) {
        throw conflict('批次快照已变化，之前用同一幂等键生成的结果已失效，请重新执行分配');
      }
      return {
        runId: existing.id,
        status: existing.status as RunResult['status'],
        report: existing.report ? (JSON.parse(existing.report) as AllocationReport) : null,
        idempotentReplay: true,
      };
    }
  }

  const attempt =
    (
      db.prepare('SELECT COALESCE(MAX(attempt), 0) AS a FROM allocation_runs WHERE batch_id = ?').get(batchId) as {
        a: number;
      }
    ).a + 1;
  const createdAt = nowIso();
  const info = db
    .prepare(
      `INSERT INTO allocation_runs
       (batch_id, attempt, mode, status, snapshot_hash, idempotency_key, request_hash, started_at, timeout_ms, created_by, created_at, source_run_id)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      batchId,
      attempt,
      mode,
      snapshot.content_hash,
      options.idempotencyKey ?? null,
      requestHash,
      createdAt,
      timeoutMs,
      actor.id,
      createdAt,
      options.sourceRunId ?? null,
    );
  const runId = Number(info.lastInsertRowid);
  const startedAt = Date.now();

  try {
    const payload = JSON.parse(snapshot.payload) as SnapshotPayload;
    const deadline = new Deadline(timeoutMs);
    const outcome = await computeAllocation(payload, deadline, options.onProgress);
    persistDecisions(db, runId, batchId, outcome.decisions);
    persistExceptions(db, batchId, runId, outcome.exceptions);

    const report: AllocationReport = {
      batchId,
      snapshotHash: snapshot.content_hash,
      totalStudents: payload.students.length,
      totalPreferences: payload.students.reduce((sum, s) => sum + s.preferences.length, 0),
      allocated: outcome.decisions.filter((d) => d.decision === 'allocated').length,
      rejected: outcome.decisions.filter((d) => d.decision !== 'allocated').length,
      guaranteeAttempted: outcome.guaranteeAttempted,
      guaranteeFulfilled: outcome.guaranteeFulfilled,
      releasedReservedSeats: outcome.releasePlan.reduce((sum, r) => sum + r.seats, 0),
      exceptions: outcome.exceptions,
      conflictsSample: outcome.conflictsSample,
      durationMs: Date.now() - startedAt,
    };

    db.prepare(
      `UPDATE allocation_runs SET status = 'succeeded', finished_at = ?, duration_ms = ?, result_summary = ?, report = ? WHERE id = ?`,
    ).run(
      nowIso(),
      report.durationMs,
      stableStringify({
        allocated: report.allocated,
        rejected: report.rejected,
        guaranteeFulfilled: report.guaranteeFulfilled,
        releasedReservedSeats: report.releasedReservedSeats,
      }),
      stableStringify(report),
      runId,
    );

    writeAudit(db, {
      actorId: actor.id,
      actorName: actor.username,
      action: 'allocation.simulate',
      entityType: 'allocation_run',
      entityId: runId,
      summary: `试算分配：落实 ${report.allocated} 项，保障处理 ${report.guaranteeFulfilled} 人`,
      detail: { snapshotHash: snapshot.content_hash, durationMs: report.durationMs, exceptions: report.exceptions.length },
    });

    if (mode === 'publish') {
      const published = publishRun(db, runId, actor);
      return { runId, status: 'published', report: published.report, idempotentReplay: false };
    }
    return { runId, status: 'succeeded', report, idempotentReplay: false };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TaskTimeoutError';
    const code = isTimeout ? ERROR_CODES.TASK_TIMEOUT : ERROR_CODES.INTERNAL;
    const reason = error instanceof Error ? error.message : String(error);
    db.prepare(
      `UPDATE allocation_runs SET status = 'failed', finished_at = ?, duration_ms = ?, failure_code = ?, failure_reason = ?, report = ? WHERE id = ?`,
    ).run(
      nowIso(),
      Date.now() - startedAt,
      code,
      reason,
      stableStringify({ exceptions: [{ kind: RESERVATION_KINDS.timeout, severity: 'critical', detail: { reason } }] }),
      runId,
    );
    db.prepare(
      `INSERT INTO exceptions (batch_id, run_id, kind, severity, status, detail, created_at)
       VALUES (?, ?, ?, 'critical', 'open', ?, ?)`,
    ).run(
      batchId,
      runId,
      isTimeout ? RESERVATION_KINDS.timeout : RESERVATION_KINDS.inconsistent,
      stableStringify({ reason }),
      nowIso(),
    );
    writeAudit(db, {
      actorId: actor.id,
      actorName: actor.username,
      action: 'allocation.failed',
      entityType: 'allocation_run',
      entityId: runId,
      summary: `分配任务失败：${reason}`,
    });
    return { runId, status: 'failed', report: null, failure: { code, reason }, idempotentReplay: false };
  }
}

export interface AllocationException {
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  studentId: number | null;
  courseId: number | null;
  detail: Record<string, unknown>;
}

export interface ReservationOutcome {
  studentId: number;
  courseId: number;
  status: 'fulfilled' | 'abnormal' | 'active';
  detail?: Record<string, unknown>;
}

export interface ReleasePlanEntry {
  classId: number;
  courseId: number;
  seats: number;
}

export interface ComputeResult {
  decisions: AllocationDecision[];
  guaranteeAttempted: number;
  guaranteeFulfilled: number;
  exceptions: AllocationException[];
  conflictsSample: Array<Record<string, unknown>>;
  reservationOutcomes: ReservationOutcome[];
  releasePlan: ReleasePlanEntry[];
  yieldCount: number;
}

interface SeatState {
  capacity: number;
  reservedSeats: number;
  generalUsed: number;
  reservedUsed: number;
}

/**
 * 纯计算阶段：只依赖冻结快照，不读写正式选课、保障状态或预留数量。
 * 期间周期性让出事件循环，避免 CPU 密集计算阻塞 HTTP 主线程。
 */
export async function computeAllocation(
  payload: SnapshotPayload,
  deadline: Deadline,
  onProgress?: (progress: number, total: number) => void,
): Promise<ComputeResult> {
  const decisions: AllocationDecision[] = [];
  const decisionIndex = new Map<string, AllocationDecision>();
  const exceptions: AllocationException[] = [];
  const conflictsSample: Array<Record<string, unknown>> = [];
  const reservationOutcomes: ReservationOutcome[] = [];
  const releasePlan: ReleasePlanEntry[] = [];
  let yieldCount = 0;
  let sinceYield = 0;

  const setDecision = (decision: AllocationDecision): void => {
    const key = `${decision.studentId}:${decision.courseId}`;
    const existing = decisionIndex.get(key);
    if (existing) {
      const index = decisions.indexOf(existing);
      if (index >= 0) decisions[index] = decision;
      decisionIndex.set(key, decision);
      return;
    }
    decisions.push(decision);
    decisionIndex.set(key, decision);
  };

  const classesById = new Map(payload.classes.map((c) => [c.classId, c]));
  const classesByCourse = new Map<number, SnapshotClass[]>();
  for (const cls of payload.classes) {
    const list = classesByCourse.get(cls.courseId) ?? [];
    list.push(cls);
    classesByCourse.set(cls.courseId, list);
  }
  for (const list of classesByCourse.values()) list.sort((a, b) => a.classId - b.classId);

  // 座位状态的唯一起点是冻结时的真实占用（预分配已经计入 enrolled / usedReserved）。
  // 这里绝不能再按学生逐条累加，否则同一份占用会被计算两次。
  const seats = new Map<number, SeatState>();
  for (const usage of payload.seatUsage) {
    seats.set(usage.classId, {
      capacity: usage.capacity,
      reservedSeats: usage.reservedSeats,
      generalUsed: usage.enrolled - usage.usedReserved,
      reservedUsed: usage.usedReserved,
    });
  }
  const classOccupancy = new Map<number, Set<string>>();
  for (const cls of payload.classes) {
    classOccupancy.set(cls.classId, occupancyKeys(cls.sessions));
  }

  const reservationsByCourse = new Map<number, Set<number>>();
  for (const entry of payload.reservations) {
    reservationsByCourse.set(entry.courseId, new Set(entry.studentIds));
  }
  const authorizations = new Map<string, SnapshotGuaranteeAuthorization>();
  for (const auth of payload.guaranteeAuthorizations) {
    authorizations.set(`${auth.studentId}:${auth.courseId}`, auth);
  }

  const working = new Map<number, WorkingStudent>();
  for (const student of payload.students) {
    const ws: WorkingStudent = {
      studentId: student.studentId,
      preferences: student.preferences,
      demandContext: student.demandContext,
      randomKeys: student.randomKeys,
      arrangement: new Set<number>(),
      assignedClasses: new Map(),
      occupancy: new Set(),
      credits: 0,
      demandLevels: new Map(),
    };
    // 冻结时已经落实的课程视为既成事实：占用座位、课表与学分，但不再重复加名额
    for (const existing of student.existingClasses) {
      ws.assignedClasses.set(existing.courseId, existing.classId);
      ws.arrangement.add(existing.courseId);
      ws.credits += existing.credits;
      const keys = classOccupancy.get(existing.classId);
      if (keys) for (const key of keys) ws.occupancy.add(key);
    }
    // 已通过 / 在修的记录也算“已有安排”，避免重复落实同一门课
    for (const courseId of student.demandContext.baseArrangedCourseIds) ws.arrangement.add(courseId);
    ws.demandLevels = computeDemandLevels(ws.demandContext, ws.arrangement);
    working.set(student.studentId, ws);
  }

  const demandWeight: Record<DemandLevel, number> = { D2: 0, D1: 1, D0: 2 };
  const demandOf = (ws: WorkingStudent, courseId: number): DemandLevel =>
    ws.demandLevels.get(courseId)?.demandLevel ?? 'D0';

  const groupCoursesOf = (ws: WorkingStudent, groupCode: string): number[] =>
    ws.preferences.filter((p) => p.groupCode === groupCode).map((p) => p.courseId);

  const groupFulfilled = (ws: WorkingStudent, groupCode: string | null, excludeCourseId: number): boolean => {
    if (!groupCode) return false;
    return groupCoursesOf(ws, groupCode).some((id) => id !== excludeCourseId && ws.arrangement.has(id));
  };

  const refreshDemand = (ws: WorkingStudent): void => {
    ws.demandLevels = computeDemandLevels(ws.demandContext, ws.arrangement);
  };

  const seatLeft = (classId: number) => {
    const seat = seats.get(classId);
    if (!seat) return { generalLeft: 0, totalLeft: 0, reservedLeft: 0 };
    return {
      generalLeft: seat.capacity - seat.reservedSeats - seat.generalUsed,
      totalLeft: seat.capacity - seat.generalUsed - seat.reservedUsed,
      reservedLeft: seat.reservedSeats - seat.reservedUsed,
    };
  };

  const claimSeat = (
    ws: WorkingStudent,
    classId: number,
    opts: { allowReserved: boolean; reservedFor: Set<number> | null },
  ): { ok: true; usesReserved: boolean } | { ok: false; code: string; message: string } => {
    const cls = classesById.get(classId);
    if (!cls) return { ok: false, code: ERROR_CODES.CLASS_NOT_FOUND, message: '教学班不存在' };
    if (cls.status === 'cancelled') return { ok: false, code: ERROR_CODES.CLASS_CANCELLED, message: '教学班已取消' };
    if (cls.status !== 'open') return { ok: false, code: ERROR_CODES.CLASS_CLOSED, message: '教学班已关闭' };
    const seat = seats.get(classId);
    if (!seat) return { ok: false, code: ERROR_CODES.CLASS_NOT_FOUND, message: '教学班座位状态缺失' };
    const { generalLeft, totalLeft, reservedLeft } = seatLeft(classId);
    if (totalLeft <= 0) return { ok: false, code: ERROR_CODES.NO_CAPACITY, message: '教学班名额已满' };

    // 先用可用普通名额，再用毕业预留（预留只给本课程受保护学生）
    if (generalLeft > 0) {
      seat.generalUsed += 1;
      return { ok: true, usesReserved: false };
    }
    if (!opts.allowReserved) {
      return { ok: false, code: ERROR_CODES.RESERVED_CAPACITY_ONLY, message: '只剩毕业保障预留名额，普通申请不能占用' };
    }
    if (!opts.reservedFor || !opts.reservedFor.has(ws.studentId)) {
      return { ok: false, code: ERROR_CODES.RESERVED_CAPACITY_ONLY, message: '该预留名额不属于当前学生' };
    }
    if (reservedLeft > 0) {
      seat.reservedUsed += 1;
      return { ok: true, usesReserved: true };
    }
    return { ok: false, code: ERROR_CODES.NO_CAPACITY, message: '教学班名额已满' };
  };

  const releaseSeat = (classId: number, usesReserved: boolean): void => {
    const seat = seats.get(classId);
    if (!seat) return;
    if (usesReserved) seat.reservedUsed = Math.max(0, seat.reservedUsed - 1);
    else seat.generalUsed = Math.max(0, seat.generalUsed - 1);
  };

  /** 剩余毕业必要课程在“落实当前候选之后”的联合可行性 */
  const graduationFeasible = (
    ws: WorkingStudent,
    extraOccupancy: Set<string>,
    extraCourseId: number,
    opts: { allowReserved: boolean; reservedFor: Set<number> | null },
  ): boolean => {
    const remaining = ws.preferences.filter(
      (p) =>
        p.courseId !== extraCourseId &&
        !ws.arrangement.has(p.courseId) &&
        demandOf(ws, p.courseId) === 'D2' &&
        !groupFulfilled(ws, p.groupCode, p.courseId),
    );
    if (remaining.length === 0) return true;

    const fixedOccupancy = new Set<string>(ws.occupancy);
    for (const key of extraOccupancy) fixedOccupancy.add(key);

    const courseOptions = remaining.map((pref) => {
      const classes = classesByCourse.get(pref.courseId) ?? [];
      const classIds = classes
        .filter((cls) => {
          if (cls.status !== 'open') return false;
          const { generalLeft, totalLeft, reservedLeft } = seatLeft(cls.classId);
          if (totalLeft <= 0) return false;
          if (opts.allowReserved && opts.reservedFor?.has(ws.studentId) && reservationsByCourse.get(cls.courseId)?.has(ws.studentId)) {
            return generalLeft > 0 || reservedLeft > 0;
          }
          return generalLeft > 0;
        })
        .map((cls) => cls.classId);
      return { courseId: pref.courseId, courseName: pref.courseName, classIds };
    });
    if (courseOptions.some((o) => o.classIds.length === 0)) return false;

    const feasibility = checkGraduationFeasibility(null, {
      courseOptions,
      occupancyOf: (classId) => classOccupancy.get(classId),
      fixedOccupancy,
      classCodeOf: (classId) => classesById.get(classId)?.classCode,
    });
    return feasibility.feasible;
  };

  const attempt = (
    ws: WorkingStudent,
    pref: SnapshotPreference,
    opts: {
      allowReserved: boolean;
      reservedFor: Set<number> | null;
      candidateClassIds?: number[];
      reasonPrefix?: string;
      guarantee?: boolean;
    },
  ): AllocationDecision => {
    const demandLevel = demandOf(ws, pref.courseId);
    const randomKey = ws.randomKeys[String(pref.courseId)] ?? '';
    const allCourseClasses = classesByCourse.get(pref.courseId) ?? [];
    const base: Omit<AllocationDecision, 'decision' | 'reasonCode' | 'reason' | 'classId' | 'classCode'> = {
      studentId: ws.studentId,
      courseId: pref.courseId,
      courseName: pref.courseName,
      preferenceId: pref.preferenceId,
      groupId: null,
      groupCode: pref.groupCode,
      demandLevel,
      globalRank: pref.globalRank,
      randomKey,
      scoreTrace: {
        demandLevel,
        globalRank: pref.globalRank,
        randomKey,
        reasons: ws.demandLevels.get(pref.courseId)?.reasons ?? [],
        candidateClasses:
          opts.candidateClassIds && opts.candidateClassIds.length > 0
            ? opts.candidateClassIds
            : allCourseClasses.map((c) => c.classId),
      },
    };

    if (ws.arrangement.has(pref.courseId)) {
      return {
        ...base,
        classId: null,
        classCode: null,
        decision: 'rejected',
        reasonCode: 'ALREADY_FULFILLED',
        reason: '已有该课程的有效记录，不重复落实',
        guarantee: opts.guarantee,
      };
    }
    if (groupFulfilled(ws, pref.groupCode, pref.courseId)) {
      return {
        ...base,
        classId: null,
        classCode: null,
        decision: 'rejected',
        reasonCode: 'GROUP_FULFILLED',
        reason: `替代组「${pref.groupCode}」已落实一门课程，组内不再重复落实`,
        guarantee: opts.guarantee,
      };
    }

    // 教学班顺序：优先学生填写的教学班偏好，再按班号
    const candidates = unique([
      ...(opts.candidateClassIds ?? pref.classIds).filter((id) => classesById.has(id)),
      ...allCourseClasses.map((c) => c.classId),
    ]).filter((id) => (opts.candidateClassIds ? opts.candidateClassIds.includes(id) : true));

    let lastCode: string = ERROR_CODES.NO_CAPACITY;
    let lastMessage = '所有候选教学班均不可用';
    for (const classId of candidates) {
      deadline.assert('统一分配超时');
      const cls = classesById.get(classId);
      if (!cls) continue;
      const occupancy = classOccupancy.get(classId);
      if (!occupancy) continue;
      if (keysIntersect(ws.occupancy, occupancy)) {
        lastCode = ERROR_CODES.TIME_CONFLICT;
        lastMessage = `与已落实课表时间冲突（教学班 ${cls.classCode}）`;
        if (conflictsSample.length < 20) {
          conflictsSample.push({ studentId: ws.studentId, courseId: pref.courseId, classId, kind: 'time_conflict' });
        }
        continue;
      }
      if (ws.credits + cls.credits > payload.creditLimit) {
        lastCode = ERROR_CODES.CREDIT_LIMIT_EXCEEDED;
        lastMessage = `落实后学分 ${ws.credits + cls.credits} 超过上限 ${payload.creditLimit}`;
        continue;
      }
      const claimed = claimSeat(ws, classId, opts);
      if (!claimed.ok) {
        lastCode = claimed.code;
        lastMessage = claimed.message;
        continue;
      }
      // 毕业保障：保持剩余必要课程仍有联合可行安排（含已有课表、本次拟加入课程与共享容量）
      if (!graduationFeasible(ws, occupancy, pref.courseId, opts)) {
        releaseSeat(classId, claimed.usesReserved);
        lastCode = ERROR_CODES.GRADUATION_INFEASIBLE;
        lastMessage = '落实该课程后，剩余毕业必要课程不存在联合可行的安排';
        continue;
      }
      ws.assignedClasses.set(pref.courseId, classId);
      ws.arrangement.add(pref.courseId);
      ws.credits += cls.credits;
      for (const key of occupancy) ws.occupancy.add(key);
      refreshDemand(ws);
      return {
        ...base,
        classId,
        classCode: cls.classCode,
        decision: 'allocated',
        reasonCode: 'ALLOCATED',
        reason: `${opts.reasonPrefix ?? ''}按需求等级、志愿排名与固定随机键排序后落实`,
        guarantee: opts.guarantee === true,
      };
    }

    return {
      ...base,
      classId: null,
      classCode: null,
      decision: 'rejected',
      reasonCode: lastCode,
      reason: lastMessage,
      guarantee: opts.guarantee,
    };
  };

  // ------------------------------------------------------------------
  // ① 普通竞争：竞争单位是“具体课程申请”，全局统一排序
  // ------------------------------------------------------------------
  interface Unit {
    studentId: number;
    courseId: number;
  }
  const units: Unit[] = [];
  for (const student of payload.students) {
    for (const pref of student.preferences) units.push({ studentId: student.studentId, courseId: pref.courseId });
  }
  const decided = new Set<string>();
  const pending = new Map<string, Unit>();
  for (const unit of units) pending.set(`${unit.studentId}:${unit.courseId}`, unit);

  const total = units.length;
  let processed = 0;
  while (pending.size > 0) {
    deadline.assert('统一分配超时');
    let bestKey: string | null = null;
    let bestUnit: Unit | null = null;
    let bestWeight = 99;
    let bestRank = Number.MAX_SAFE_INTEGER;
    let bestRandom = '';
    for (const [key, unit] of pending) {
      const ws = working.get(unit.studentId)!;
      const weight = demandWeight[demandOf(ws, unit.courseId)];
      const pref = ws.preferences.find((p) => p.courseId === unit.courseId)!;
      const rank = pref.globalRank;
      const random = ws.randomKeys[String(unit.courseId)] ?? '';
      const better =
        bestUnit === null ||
        weight < bestWeight ||
        (weight === bestWeight &&
          (rank < bestRank ||
            (rank === bestRank &&
              (random < bestRandom ||
                (random === bestRandom &&
                  (unit.studentId < bestUnit.studentId ||
                    (unit.studentId === bestUnit.studentId && unit.courseId < bestUnit.courseId)))))));
      if (better) {
        bestKey = key;
        bestUnit = unit;
        bestWeight = weight;
        bestRank = rank;
        bestRandom = random;
      }
    }
    if (!bestUnit || !bestKey) break;
    pending.delete(bestKey);
    decided.add(bestKey);
    const ws = working.get(bestUnit.studentId)!;
    const pref = ws.preferences.find((p) => p.courseId === bestUnit!.courseId)!;
    setDecision(attempt(ws, pref, { allowReserved: false, reservedFor: null }));
    processed += 1;
    onProgress?.(processed, total);

    sinceYield += 1;
    if (sinceYield >= 32) {
      sinceYield = 0;
      yieldCount += 1;
      await yieldToEventLoop();
    }
  }

  // ------------------------------------------------------------------
  // ② 毕业兜底：普通竞争后处理尚未落实的毕业保障
  // ------------------------------------------------------------------
  let guaranteeAttempted = 0;
  let guaranteeFulfilled = 0;
  const now = Date.now();
  for (const entry of payload.reservations) {
    const reservedFor = reservationsByCourse.get(entry.courseId) ?? new Set(entry.studentIds);
    const courseClasses = classesByCourse.get(entry.courseId) ?? [];
    const allClassIds = courseClasses.map((c) => c.classId);
    for (const studentId of entry.studentIds) {
      deadline.assert('毕业保障处理超时');
      const ws = working.get(studentId);
      if (!ws) {
        exceptions.push({
          kind: RESERVATION_KINDS.notSubmitted,
          severity: 'warning',
          studentId,
          courseId: entry.courseId,
          detail: { message: '保护名单中的学生没有有效志愿提交，无法自动兜底' },
        });
        reservationOutcomes.push({ studentId, courseId: entry.courseId, status: 'active' });
        continue;
      }
      if (ws.arrangement.has(entry.courseId)) {
        reservationOutcomes.push({ studentId, courseId: entry.courseId, status: 'fulfilled' });
        continue;
      }

      const authorization = authorizations.get(`${studentId}:${entry.courseId}`);
      if (!authorization || authorization.classIds.length === 0) {
        exceptions.push({
          kind: RESERVATION_KINDS.noAuthorization,
          severity: 'critical',
          studentId,
          courseId: entry.courseId,
          detail: {
            message: '该学生没有有效的毕业兜底授权（或未接受任何教学班），系统不会自动扩大选择',
            hasAuthorization: Boolean(authorization),
            acceptedClassIds: authorization?.classIds ?? [],
          },
        });
        reservationOutcomes.push({ studentId, courseId: entry.courseId, status: 'abnormal' });
        continue;
      }
      if (authorization.expiresAt && new Date(authorization.expiresAt).getTime() <= now) {
        exceptions.push({
          kind: RESERVATION_KINDS.noAuthorization,
          severity: 'critical',
          studentId,
          courseId: entry.courseId,
          detail: { message: '毕业兜底授权已过期，需要学生重新确认', expiresAt: authorization.expiresAt },
        });
        reservationOutcomes.push({ studentId, courseId: entry.courseId, status: 'abnormal' });
        continue;
      }

      // 只允许在学生明确接受的教学班范围内兜底，且这些班必须属于本课程、当前开放
      const accepted = authorization.classIds.filter((id) => allClassIds.includes(id));
      if (accepted.length === 0) {
        exceptions.push({
          kind: RESERVATION_KINDS.rejectedAll,
          severity: 'critical',
          studentId,
          courseId: entry.courseId,
          detail: {
            message: '学生接受的教学班都不属于本课程当前开放的教学班，无法兜底',
            acceptedClassIds: authorization.classIds,
            availableClassIds: allClassIds,
          },
        });
        reservationOutcomes.push({ studentId, courseId: entry.courseId, status: 'abnormal' });
        continue;
      }

      guaranteeAttempted += 1;
      const pref =
        ws.preferences.find((p) => p.courseId === entry.courseId) ??
        ({
          preferenceId: null,
          courseId: entry.courseId,
          courseName: entry.courseName,
          credits: courseClasses[0]?.credits ?? 0,
          globalRank: 9999,
          groupCode: null,
          classIds: accepted,
        } satisfies SnapshotPreference);
      const decision = attempt(ws, pref, {
        allowReserved: true,
        reservedFor,
        candidateClassIds: accepted,
        reasonPrefix: '毕业保障兜底：',
        guarantee: true,
      });
      if (decision.decision === 'allocated') {
        guaranteeFulfilled += 1;
        reservationOutcomes.push({ studentId, courseId: entry.courseId, status: 'fulfilled' });
        setDecision(decision);
      } else {
        const kind =
          decision.reasonCode === ERROR_CODES.GRADUATION_INFEASIBLE
            ? RESERVATION_KINDS.noSolution
            : decision.reasonCode === ERROR_CODES.RESERVED_CAPACITY_ONLY ||
                decision.reasonCode === ERROR_CODES.NO_CAPACITY
              ? RESERVATION_KINDS.rejectedAll
              : RESERVATION_KINDS.rejectedAll;
        exceptions.push({
          kind,
          severity: 'critical',
          studentId,
          courseId: entry.courseId,
          detail: {
            message: decision.reason,
            reasonCode: decision.reasonCode,
            acceptedClassIds: accepted,
          },
        });
        reservationOutcomes.push({ studentId, courseId: entry.courseId, status: 'abnormal' });
        setDecision({ ...decision, decision: 'error', reasonCode: kind });
      }
    }
  }

  // ------------------------------------------------------------------
  // ③ 预留释放计划：整门课程的保护需求全部落实后才释放剩余预留
  // ------------------------------------------------------------------
  const fulfilledByCourse = new Map<number, number>();
  const blockedByCourse = new Set<number>();
  for (const outcome of reservationOutcomes) {
    if (outcome.status === 'fulfilled') {
      fulfilledByCourse.set(outcome.courseId, (fulfilledByCourse.get(outcome.courseId) ?? 0) + 1);
    } else {
      blockedByCourse.add(outcome.courseId);
    }
  }
  for (const cls of payload.classes) {
    const reservedTotal = reservationsByCourse.get(cls.courseId)?.size ?? 0;
    if (reservedTotal === 0) continue;
    if (blockedByCourse.has(cls.courseId)) continue;
    if ((fulfilledByCourse.get(cls.courseId) ?? 0) === 0) continue;
    const seat = seats.get(cls.classId);
    if (!seat) continue;
    const spare = seat.reservedSeats - seat.reservedUsed;
    if (spare > 0) releasePlan.push({ classId: cls.classId, courseId: cls.courseId, seats: spare });
  }

  return {
    decisions,
    guaranteeAttempted,
    guaranteeFulfilled,
    exceptions,
    conflictsSample,
    reservationOutcomes,
    releasePlan,
    yieldCount,
  };
}

/**
 * 把试算阶段的保障异常写入异常清单，供管理员在发布前形成明确处理结果。
 * 试算允许写任务、决策、报告与异常记录，但不改动任何正式选课/保障/预留状态。
 */
function persistExceptions(
  db: SqliteDb,
  batchId: number,
  runId: number,
  exceptions: AllocationException[],
): void {
  if (exceptions.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO exceptions (batch_id, run_id, student_id, course_id, kind, severity, status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  );
  const now = nowIso();
  db.transaction(() => {
    for (const exception of exceptions) {
      insert.run(
        batchId,
        runId,
        exception.studentId,
        exception.courseId,
        exception.kind,
        exception.severity,
        stableStringify(exception.detail),
        now,
      );
    }
  })();
}

function persistDecisions(db: SqliteDb, runId: number, batchId: number, decisions: AllocationDecision[]): void {  const insert = db.prepare(
    `INSERT INTO allocation_items
     (run_id, student_id, batch_id, course_id, preference_id, class_id, group_id, demand_level, global_rank, random_key,
      order_index, decision, reason_code, reason, score_trace, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, student_id, course_id) DO UPDATE SET
       class_id = excluded.class_id, decision = excluded.decision, reason_code = excluded.reason_code,
       reason = excluded.reason, score_trace = excluded.score_trace, demand_level = excluded.demand_level,
       global_rank = excluded.global_rank, random_key = excluded.random_key, created_at = excluded.created_at`,
  );
  const now = nowIso();
  db.transaction(() => {
    decisions.forEach((decision, index) => {
      insert.run(
        runId,
        decision.studentId,
        batchId,
        decision.courseId,
        decision.preferenceId,
        decision.classId,
        decision.groupId,
        decision.demandLevel,
        decision.globalRank,
        decision.randomKey || null,
        index + 1,
        decision.decision,
        decision.reasonCode,
        decision.reason,
        stableStringify({ ...decision.scoreTrace, guarantee: decision.guarantee === true }),
        now,
      );
    });
  })();
}

/**
 * 发布一次分配结果。
 *
 * 要求：
 *   - 只能发布检查通过（succeeded）的试算结果；
 *   - 发布前校验批次、快照版本、保障异常与实际容量；
 *   - 选课落位、保护状态、预留释放、自动候补与批次发布必须整体成功，任何一步失败全部回滚；
 *   - 重复发布返回已有结果，绝不通过“先取消学生现有课程”来实现幂等。
 */
export function publishRun(
  db: SqliteDb,
  runId: number,
  actor: AuthUser,
): { runId: number; report: AllocationReport; idempotentReplay: boolean; alreadyPublished: boolean } {
  const run = db
    .prepare(
      `SELECT id, batch_id, mode, status, snapshot_hash, report, result_summary FROM allocation_runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: number;
        batch_id: number;
        mode: string;
        status: string;
        snapshot_hash: string | null;
        report: string | null;
        result_summary: string | null;
      }
    | undefined;
  if (!run) throw notFound('分配任务不存在');

  // 重复发布同一结果：直接返回已有结果，不做任何取消/重写
  if (run.status === 'published') {
    return {
      runId,
      report: run.report ? (JSON.parse(run.report) as AllocationReport) : emptyReport(run.batch_id, run.snapshot_hash),
      idempotentReplay: true,
      alreadyPublished: true,
    };
  }
  if (run.status !== 'succeeded') {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      `分配任务当前状态为 ${run.status}，只有检查通过的试算结果才能发布`,
      409,
    );
  }

  const batch = db.prepare('SELECT id, status, term FROM selection_batches WHERE id = ?').get(run.batch_id) as
    | { id: number; status: string; term: string }
    | undefined;
  if (!batch) throw notFound('批次不存在');
  if (batch.status === 'closed') {
    throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '批次已结束，不能再发布结果', 409);
  }
  // 一个批次只允许有一份正式结果：绝不允许用“再发布一次”覆盖或混入另一份结果
  const otherPublished = db
    .prepare("SELECT id FROM allocation_runs WHERE batch_id = ? AND status = 'published' AND id != ? LIMIT 1")
    .get(run.batch_id, runId) as { id: number } | undefined;
  if (otherPublished) {
    throw conflict(
      `该批次已经发布过分配结果（执行 #${otherPublished.id}）。如需重新发布，请重新冻结批次并作废旧结果后再试算发布`,
    );
  }
  const snapshot = db.prepare('SELECT content_hash FROM batch_snapshots WHERE batch_id = ?').get(run.batch_id) as
    | { content_hash: string }
    | undefined;
  if (!snapshot) throw conflict('批次缺少冻结快照，无法发布');
  if (run.snapshot_hash && run.snapshot_hash !== snapshot.content_hash) {
    throw conflict('批次快照已变化，该试算结果已失效，请重新试算后再发布');
  }

  const allocatedItems = db
    .prepare(
      `SELECT student_id AS studentId, course_id AS courseId, class_id AS classId, decision, reason, score_trace AS scoreTrace
       FROM allocation_items WHERE run_id = ? AND decision = 'allocated' ORDER BY order_index`,
    )
    .all(runId) as Array<{
    studentId: number;
    courseId: number;
    classId: number;
    decision: string;
    reason: string;
    scoreTrace: string | null;
  }>;

  // 发布前校验：保障异常必须已经形成明确处理结果
  const openCritical = db
    .prepare(
      `SELECT COUNT(*) AS c FROM exceptions
       WHERE batch_id = ? AND status = 'open' AND severity = 'critical' AND run_id = ?`,
    )
    .get(run.batch_id, runId) as { c: number };
  if (openCritical.c > 0) {
    const samples = db
      .prepare(
        `SELECT kind, student_id AS studentId, course_id AS courseId, detail FROM exceptions
         WHERE batch_id = ? AND status = 'open' AND severity = 'critical' AND run_id = ? LIMIT 20`,
      )
      .all(run.batch_id, runId);
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      `还有 ${openCritical.c} 条关键保障异常未处理，发布前必须形成明确处理结果（不能通过 force 绕过）`,
      409,
      { openExceptions: openCritical.c, samples },
    );
  }

  // 只有“毕业兜底阶段”落实的判定才允许占用毕业预留；
  // 普通竞争（即使课程有保护名单）不能用预留名额。
  const viaGuaranteeFor = (item: { scoreTrace: string | null }): boolean => {
    if (!item.scoreTrace) return false;
    try {
      return (JSON.parse(item.scoreTrace) as { guarantee?: boolean }).guarantee === true;
    } catch {
      return false;
    }
  };

  // 发布前校验：实际容量（快照之外的实时变化必须重新核对）
  const byClass = new Map<number, { general: number; reserved: number; courseId: number }>();
  for (const item of allocatedItems) {
    const viaGuarantee = viaGuaranteeFor(item);
    const entry = byClass.get(item.classId) ?? { general: 0, reserved: 0, courseId: item.courseId };
    if (viaGuarantee) entry.reserved += 1;
    else entry.general += 1;
    byClass.set(item.classId, entry);
  }
  for (const [classId, need] of byClass) {
    const usage = getSeatUsage(db, classId);
    const generalNeed = need.general;
    const reservedNeed = need.reserved;
    if (usage.generalAvailable < generalNeed || usage.totalAvailable < generalNeed + reservedNeed) {
      throw new AppError(
        ERROR_CODES.NO_CAPACITY,
        `教学班 ${classId} 的实际名额已不足以落实本次结果，请重新试算后再发布`,
        409,
        {
          classId,
          generalAvailable: usage.generalAvailable,
          totalAvailable: usage.totalAvailable,
          needGeneral: generalNeed,
          needReserved: reservedNeed,
        },
      );
    }
  }

  const service = new EnrollmentService(db);
  const report = run.report ? (JSON.parse(run.report) as AllocationReport) : emptyReport(run.batch_id, run.snapshot_hash);
  let applied = 0;
  const waitlistQueued = { value: 0 };

  db.transaction(() => {
    // 落位：逐条走正式选课服务（名额在事务内复核），任何一条失败都会抛错并整体回滚
    for (const item of allocatedItems) {
      if (!item.classId) continue;
      const viaGuarantee = viaGuaranteeFor(item);
      const result: OperationResult = service.allocateTo(item.studentId, item.classId, {
        source: viaGuarantee ? 'guarantee' : 'allocation',
        batchId: run.batch_id,
        allocationRunId: runId,
        allowReserved: viaGuarantee,
        actor,
        reason: item.reason,
        skipOperationLog: false,
        allowFrozen: true,
        idempotencyKey: `alloc:${runId}:${item.studentId}:${item.courseId}`,
      });
      if (!result.ok) {
        throw new AppError(
          (result.error?.code ?? ERROR_CODES.INTERNAL) as never,
          `落实学生 ${item.studentId} 的课程 ${item.courseId} 失败：${result.error?.message ?? '未知原因'}`,
          409,
          { studentId: item.studentId, courseId: item.courseId },
        );
      }
      applied += 1;
    }

    // 正式保障状态：把本轮的 fulfilled / abnormal 结论落库
    const outcomes = db
      .prepare(
        `SELECT student_id AS studentId, course_id AS courseId,
                CASE WHEN decision = 'allocated' THEN 'fulfilled' ELSE 'abnormal' END AS status
         FROM allocation_items WHERE run_id = ? AND course_id IN (
           SELECT course_id FROM graduation_reservations WHERE batch_id = ?
         )`,
      )
      .all(runId, run.batch_id) as Array<{ studentId: number; courseId: number; status: string }>;
    for (const outcome of outcomes) {
      db.prepare(
        `UPDATE graduation_reservations SET status = ?
         WHERE batch_id = ? AND course_id = ? AND student_id = ? AND status = 'active'`,
      ).run(outcome.status, run.batch_id, outcome.courseId, outcome.studentId);
    }
    // 未提交志愿的保护学生仍保持 active，不视为保障完成，也不释放预留

    // 预留释放：整门课程的保护需求全部落实后，只释放“确实没用到的”预留
    const reservedCourses = db
      .prepare('SELECT DISTINCT course_id AS courseId FROM graduation_reservations WHERE batch_id = ?')
      .all(run.batch_id) as Array<{ courseId: number }>;
    for (const { courseId } of reservedCourses) {
      const state = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN status = 'abnormal' THEN 1 ELSE 0 END) AS abnormal,
             SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END) AS fulfilled
           FROM graduation_reservations WHERE batch_id = ? AND course_id = ?`,
        )
        .get(run.batch_id, courseId) as { active: number | null; abnormal: number | null; fulfilled: number | null };
      const active = state.active ?? 0;
      const abnormal = state.abnormal ?? 0;
      const fulfilled = state.fulfilled ?? 0;
      // 只要有未落实（active）或异常（abnormal）的保护需求，就绝不提前释放预留
      if (active > 0 || abnormal > 0 || fulfilled === 0) continue;
      const classes = db
        .prepare("SELECT id, reserved_seats AS reservedSeats FROM teaching_classes WHERE course_id = ? AND term = ?")
        .all(courseId, batch.term) as Array<{ id: number; reservedSeats: number }>;
      let released = 0;
      for (const cls of classes) {
        const usedReserved = (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled' AND uses_reserved = 1",
            )
            .get(cls.id) as { c: number }
        ).c;
        const spare = cls.reservedSeats - usedReserved;
        if (spare <= 0) continue;
        // 只保留真正被占用的预留数，其余释放为普通名额
        db.prepare('UPDATE teaching_classes SET reserved_seats = ? WHERE id = ?').run(usedReserved, cls.id);
        released += spare;
      }
      if (released > 0) {
        writeAudit(db, {
          actorId: actor.id,
          actorName: actor.username,
          action: 'guarantee.release_reserved',
          entityType: 'course',
          entityId: courseId,
          summary: `课程保护需求全部落实，释放 ${released} 个预留名额`,
          detail: { batchId: run.batch_id, courseId },
        });
      }
    }

    // 自动候补：首轮发布时生成，不依赖管理员另点一次按钮
    waitlistQueued.value = enqueueRejectedFromAllocation(db, run.batch_id, runId, actor);

    // 批次发布
    const now = nowIso();
    db.prepare("UPDATE selection_batches SET status = 'published', published_at = ? WHERE id = ? AND status != 'published'").run(
      now,
      run.batch_id,
    );
    db.prepare("UPDATE allocation_runs SET status = 'published', published_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?").run(
      now,
      now,
      runId,
    );
  })();

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'allocation.publish',
    entityType: 'allocation_run',
    entityId: runId,
    summary: `发布分配结果：落实 ${applied} 项，自动候补 ${waitlistQueued.value} 条`,
    detail: { snapshotHash: run.snapshot_hash, applied },
  });

  return { runId, report, idempotentReplay: false, alreadyPublished: false };
}

function emptyReport(batchId: number, snapshotHash: string | null): AllocationReport {
  return {
    batchId,
    snapshotHash: snapshotHash ?? '',
    totalStudents: 0,
    totalPreferences: 0,
    allocated: 0,
    rejected: 0,
    guaranteeAttempted: 0,
    guaranteeFulfilled: 0,
    releasedReservedSeats: 0,
    exceptions: [],
    conflictsSample: [],
    durationMs: 0,
  };
}

export function listRuns(db: SqliteDb, batchId: number): unknown[] {
  return db
    .prepare(
      `SELECT id, batch_id AS batchId, attempt, mode, status, snapshot_hash AS snapshotHash, started_at AS startedAt,
              finished_at AS finishedAt, published_at AS publishedAt, duration_ms AS durationMs,
              failure_code AS failureCode, failure_reason AS failureReason, result_summary AS resultSummary, report
       FROM allocation_runs WHERE batch_id = ? ORDER BY attempt DESC`,
    )
    .all(batchId);
}

export function getRun(db: SqliteDb, runId: number): unknown {
  const run = db
    .prepare(
      `SELECT id, batch_id AS batchId, attempt, mode, status, snapshot_hash AS snapshotHash, started_at AS startedAt,
              finished_at AS finishedAt, published_at AS publishedAt, duration_ms AS durationMs,
              failure_code AS failureCode, failure_reason AS failureReason, result_summary AS resultSummary, report
       FROM allocation_runs WHERE id = ?`,
    )
    .get(runId);
  if (!run) throw notFound('分配任务不存在');
  const items = db
    .prepare(
      `SELECT ai.id, ai.student_id AS studentId, s.student_no AS studentNo, s.name AS studentName,
              ai.course_id AS courseId, c.name AS courseName, ai.class_id AS classId, tc.class_code AS classCode,
              ai.demand_level AS demandLevel, ai.global_rank AS globalRank, ai.random_key AS randomKey,
              ai.decision, ai.reason_code AS reasonCode, ai.reason, ai.score_trace AS scoreTrace
       FROM allocation_items ai
       JOIN students s ON s.user_id = ai.student_id
       JOIN courses c ON c.id = ai.course_id
       LEFT JOIN teaching_classes tc ON tc.id = ai.class_id
       WHERE ai.run_id = ? ORDER BY ai.order_index LIMIT 1000`,
    )
    .all(runId);
  return { run, items };
}

export function listExceptions(
  db: SqliteDb,
  filter: { batchId?: number; status?: string; limit: number; offset: number },
): { items: unknown[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.batchId) {
    conditions.push('e.batch_id = ?');
    params.push(filter.batchId);
  }
  if (filter.status) {
    conditions.push('e.status = ?');
    params.push(filter.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM exceptions e ${where}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(
      `SELECT e.id, e.batch_id AS batchId, e.run_id AS runId, e.student_id AS studentId, s.student_no AS studentNo,
              s.name AS studentName, e.course_id AS courseId, c.name AS courseName, e.kind, e.severity, e.status,
              e.detail, e.resolution, e.created_at AS createdAt, e.resolved_at AS resolvedAt
       FROM exceptions e
       LEFT JOIN students s ON s.user_id = e.student_id
       LEFT JOIN courses c ON c.id = e.course_id
       ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset);
  return { items, total };
}

export function resolveException(
  db: SqliteDb,
  exceptionId: number,
  resolution: string,
  status: 'resolved' | 'ignored',
  actor: AuthUser,
): void {
  const row = db.prepare('SELECT id FROM exceptions WHERE id = ?').get(exceptionId);
  if (!row) throw notFound('异常记录不存在');
  db.prepare('UPDATE exceptions SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').run(
    status,
    resolution,
    actor.id,
    nowIso(),
    exceptionId,
  );
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'exception.resolve',
    entityType: 'exception',
    entityId: exceptionId,
    summary: status === 'resolved' ? '异常已处理' : '异常已忽略',
    detail: { resolution },
  });
}

/** 读取管理员配置的学分上限（缺失时用安全默认值） */
export function readCreditLimit(db: SqliteDb): number {
  const row = db.prepare("SELECT value FROM app_configs WHERE key = 'credit_limit_default'").get() as
    | { value: string }
    | undefined;
  const parsed = row ? Number.parseFloat(row.value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}
