/**
 * 统一分配与毕业保障。
 *
 * 分配使用的输入全部来自“冻结快照”：冻结之后即使有人修改资料、重新提交或新增选课，
 * 都不会影响本轮结果（这是验收要求“提交先后不影响首轮结果”的前提）。
 *
 * 排序规则（与需求一致）：
 *   培养需求等级（D2 > D1 > D0） → 全局志愿排名 → 固定随机键。
 *   随机键在提交志愿时就已经固定，重交、重试、退出后重新加入都不重抽。
 *
 * 流程：
 *   ① 在冻结快照上按优先级逐项尝试；
 *   ② 每次成功都必须满足完整课表、容量、资格、学分与替代组约束；
 *   ③ 普通竞争结束后处理尚未落实的毕业兜底（可使用预留名额）；
 *   ④ 最后才按规则释放确实用不到的预留余量。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../core/errors.js';
import { contentHash, Deadline, nowIso, randomToken, stableStringify, unique } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { classSessions } from '../catalog/seat-utils.js';
import {
  checkGraduationFeasibility,
  computeProgress,
  keysIntersect,
  occupancyKeys,
  type DemandLevel,
} from '../rules/service.js';
import { EnrollmentService, type OperationResult } from '../enrollment/service.js';
import { loadSubmissionPayload } from '../preference/service.js';
import { getSeatUsage } from '../catalog/service.js';

export interface SnapshotPayload {
  batchId: number;
  term: string;
  frozenAt: string;
  creditLimit: number;
  classes: Array<{
    classId: number;
    courseId: number;
    classCode: string;
    courseName: string;
    credits: number;
    capacity: number;
    reservedSeats: number;
    status: string;
    sessions: Array<{
      day_of_week: number;
      period_start: number;
      period_end: number;
      week_start: number;
      week_end: number;
      week_parity: string;
    }>;
  }>;
  students: Array<{
    studentId: number;
    studentNo: string;
    name: string;
    submissionId: number;
    versionNo: number;
    preferences: Array<{
      courseId: number;
      courseName: string;
      credits: number;
      globalRank: number;
      groupCode: string | null;
      classIds: number[];
    }>;
    demand: Record<string, { level: DemandLevel; reasons: string[] }>;
    randomKeys: Record<string, string>;
    /** 冻结时已经落实的课程（预分配等），分配时视为不可退出的既成事实 */
    existingCourseIds: number[];
  }>;
  reservations: Array<{
    courseId: number;
    courseName: string;
    studentIds: number[];
  }>;
  /** 冻结时每门课程普通名额的使用情况（只做校验报告，实际占用以事务内计数为准） */
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

const RESERVATION_KINDS = {
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

    const students: SnapshotPayload['students'] = [];
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
      const progress = computeProgress(db, row.student_id, { plannedCourseIds: courseIds, term: batch.term });
      const forcedRequired = new Set(
        (
          db
            .prepare('SELECT course_id FROM term_required_courses WHERE student_id = ? AND term = ?')
            .all(row.student_id, batch.term) as Array<{ course_id: number }>
        ).map((r) => r.course_id),
      );
      const demand: Record<string, { level: DemandLevel; reasons: string[] }> = {};
      for (const pref of payload.preferences) {
        const requirement = progress.requirements.find((r) => r.candidateCourseIds.includes(pref.courseId));
        const course = courseNameById.get(pref.courseId);
        if (forcedRequired.has(pref.courseId)) {
          demand[String(pref.courseId)] = {
            level: 'D2',
            reasons: ['管理员确认本学期必须完成，且尚无足够安排'],
          };
          continue;
        }
        if (!requirement) {
          demand[String(pref.courseId)] = { level: 'D0', reasons: ['不属于培养方案要求，视为额外兴趣'] };
          continue;
        }
        if (requirement.satisfied) {
          demand[String(pref.courseId)] = {
            level: 'D0',
            reasons: [`培养需求「${requirement.name}」已满足，属于改善申请或额外兴趣`],
          };
          continue;
        }
        const level: DemandLevel = requirement.priority <= 1 ? 'D2' : 'D1';
        demand[String(pref.courseId)] = {
          level,
          reasons: [
            level === 'D2'
              ? `本期必须完成的正式要求，尚缺 ${requirement.remainingCredits} 学分`
              : `可补足未完成的「${requirement.name}」，尚缺 ${requirement.remainingCredits} 学分`,
            course ? `课程 ${course.name}（${course.credits} 学分）` : '',
          ].filter(Boolean),
        };
      }

      const randomKeys: Record<string, string> = {};
      const keyRows = db
        .prepare(
          `SELECT course_id, random_key FROM student_course_random_keys
           WHERE student_id = ? AND term = ? AND course_id IN (${courseIds.map(() => '?').join(',') || 'NULL'})`,
        )
        .all(row.student_id, batch.term, ...courseIds) as Array<{ course_id: number; random_key: string }>;
      for (const key of keyRows) randomKeys[String(key.course_id)] = key.random_key;

      const existing = db
        .prepare("SELECT DISTINCT course_id FROM enrollments WHERE student_id = ? AND status = 'enrolled'")
        .all(row.student_id) as Array<{ course_id: number }>;

      students.push({
        studentId: row.student_id,
        studentNo: row.student_no,
        name: row.name,
        submissionId: row.id,
        versionNo: row.version_no,
        preferences: payload.preferences
          .map((pref) => ({
            courseId: pref.courseId,
            courseName: courseNameById.get(pref.courseId)?.name ?? String(pref.courseId),
            credits: courseNameById.get(pref.courseId)?.credits ?? 0,
            globalRank: pref.globalRank,
            groupCode: pref.groupCode ?? null,
            classIds: pref.classIds ?? [],
          }))
          .sort((a, b) => a.globalRank - b.globalRank),
        demand,
        randomKeys,
        existingCourseIds: existing.map((e) => e.course_id),
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
    return Number(info.lastInsertRowid) || (db.prepare('SELECT id FROM batch_snapshots WHERE batch_id = ?').get(batchId) as { id: number }).id;
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

// ---------------------------------------------------------------------------
// 分配执行
// ---------------------------------------------------------------------------

interface WorkingStudent {
  studentId: number;
  studentNo: string;
  name: string;
  preferences: SnapshotPayload['students'][number]['preferences'];
  demand: SnapshotPayload['students'][number]['demand'];
  randomKeys: Record<string, string>;
  assignedClasses: Map<number, number>; // courseId -> classId
  occupancy: Set<string>;
  credits: number;
  fulfilledCourseIds: Set<number>;
}

export interface RunAllocationOptions {
  mode?: 'simulate' | 'publish';
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface RunResult {
  runId: number;
  status: 'succeeded' | 'failed' | 'published';
  report: AllocationReport | null;
  failure?: { code: string; reason: string };
  idempotentReplay: boolean;
}

export function runAllocation(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  options: RunAllocationOptions = {},
): RunResult {
  const mode = options.mode ?? 'simulate';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const snapshot = db.prepare('SELECT id, content_hash, payload FROM batch_snapshots WHERE batch_id = ?').get(batchId) as
    | { id: number; content_hash: string; payload: string }
    | undefined;
  if (!snapshot) {
    throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '请先冻结批次生成快照，再进行试算或发布', 409);
  }

  if (options.idempotencyKey) {
    const existing = db
      .prepare('SELECT id, status, result_summary, report, snapshot_hash FROM allocation_runs WHERE idempotency_key = ?')
      .get(options.idempotencyKey) as
      | { id: number; status: string; result_summary: string | null; report: string | null; snapshot_hash: string | null }
      | undefined;
    if (existing) {
      if (existing.snapshot_hash && existing.snapshot_hash !== snapshot.content_hash) {
        // 批次已经重新冻结：旧结果不再对应当前输入，不能直接复用
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

  const attempt = (
    db.prepare('SELECT COALESCE(MAX(attempt), 0) AS a FROM allocation_runs WHERE batch_id = ?').get(batchId) as { a: number }
  ).a + 1;
  const createdAt = nowIso();
  const info = db
    .prepare(
      `INSERT INTO allocation_runs (batch_id, attempt, mode, status, snapshot_hash, idempotency_key, started_at, timeout_ms, created_by, created_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
    )
    .run(batchId, attempt, mode, snapshot.content_hash, options.idempotencyKey ?? null, createdAt, timeoutMs, actor.id, createdAt);
  const runId = Number(info.lastInsertRowid);
  const startedAt = Date.now();

  try {
    const payload = JSON.parse(snapshot.payload) as SnapshotPayload;
    const deadline = new Deadline(timeoutMs);
    const outcome = executeAllocation(db, runId, batchId, payload, deadline, mode, actor);

    const report: AllocationReport = {
      batchId,
      snapshotHash: snapshot.content_hash,
      totalStudents: payload.students.length,
      totalPreferences: payload.students.reduce((sum, s) => sum + s.preferences.length, 0),
      allocated: outcome.decisions.filter((d) => d.decision === 'allocated').length,
      rejected: outcome.decisions.filter((d) => d.decision !== 'allocated').length,
      guaranteeAttempted: outcome.guaranteeAttempted,
      guaranteeFulfilled: outcome.guaranteeFulfilled,
      releasedReservedSeats: outcome.releasedReservedSeats,
      exceptions: outcome.exceptions.map((e) => ({
        kind: e.kind,
        severity: e.severity,
        studentId: e.studentId,
        courseId: e.courseId,
        detail: e.detail,
      })),
      conflictsSample: outcome.conflictsSample,
      durationMs: Date.now() - startedAt,
    };

    const finishedAt = nowIso();
    db.transaction(() => {
      db.prepare(
        `UPDATE allocation_runs SET status = ?, finished_at = ?, duration_ms = ?, result_summary = ?, report = ? WHERE id = ?`,
      ).run(
        mode === 'publish' ? 'published' : 'succeeded',
        finishedAt,
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
    })();

    writeAudit(db, {
      actorId: actor.id,
      actorName: actor.username,
      action: mode === 'publish' ? 'allocation.publish' : 'allocation.simulate',
      entityType: 'allocation_run',
      entityId: runId,
      summary: `${mode === 'publish' ? '发布' : '试算'}分配：落实 ${report.allocated} 项，保障处理 ${report.guaranteeFulfilled} 人`,
      detail: { snapshotHash: snapshot.content_hash, durationMs: report.durationMs, exceptions: report.exceptions.length },
    });

    return { runId, status: mode === 'publish' ? 'published' : 'succeeded', report, idempotentReplay: false };
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

interface ExecutionOutcome {
  decisions: AllocationDecision[];
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
}

interface SeatState {
  capacity: number;
  reservedSeats: number;
  /** 已经占用的座位：key 为学生标识，value 是否使用预留名额 */
  generalUsed: number;
  reservedUsed: number;
}

function executeAllocation(
  db: SqliteDb,
  runId: number,
  batchId: number,
  payload: SnapshotPayload,
  deadline: Deadline,
  mode: 'simulate' | 'publish',
  actor: AuthUser,
): ExecutionOutcome {
  const decisions: AllocationDecision[] = [];
  const decisionIndex = new Map<string, AllocationDecision>();
  const exceptions: ExecutionOutcome['exceptions'] = [];
  const conflictsSample: Array<Record<string, unknown>> = [];
  const insertItemStmt = db.prepare(
    `INSERT INTO allocation_items
     (run_id, student_id, batch_id, course_id, preference_id, class_id, group_id, demand_level, global_rank, random_key,
      order_index, decision, reason_code, reason, score_trace, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateItemStmt = db.prepare(
    `UPDATE allocation_items SET class_id = ?, decision = ?, reason_code = ?, reason = ?, score_trace = ?, demand_level = ?,
       global_rank = ?, random_key = ?, created_at = ?
     WHERE run_id = ? AND student_id = ? AND course_id = ?`,
  );

  /**
   * 记录一条分配判定。
   * 同一次执行里，同一名学生的同一门课程只保留一条最终判定：
   * 毕业兜底阶段如果改变了结论（例如从“普通竞争落选”变为“使用预留名额落实”），
   * 会覆盖之前那条记录，避免出现互相矛盾的明细。
   */
  const setDecision = (currentRunId: number, currentBatchId: number, decision: AllocationDecision): void => {
    const key = `${decision.studentId}:${decision.courseId}`;
    const created = nowIso();
    const existing = decisionIndex.get(key);
    if (existing) {
      updateItemStmt.run(
        decision.classId,
        decision.decision,
        decision.reasonCode,
        decision.reason,
        stableStringify(decision.scoreTrace),
        decision.demandLevel,
        decision.globalRank,
        decision.randomKey || null,
        created,
        currentRunId,
        decision.studentId,
        decision.courseId,
      );
      // 同步内存中的列表，否则发布阶段仍会用旧结论（例如把毕业兜底当成了普通落选）
      const index = decisions.indexOf(existing);
      if (index >= 0) decisions[index] = decision;
      decisionIndex.set(key, decision);
      return;
    }
    const orderIndex = decisions.length + 1;
    insertItemStmt.run(
      currentRunId,
      decision.studentId,
      currentBatchId,
      decision.courseId,
      decision.preferenceId,
      decision.classId,
      decision.groupId,
      decision.demandLevel,
      decision.globalRank,
      decision.randomKey || null,
      orderIndex,
      decision.decision,
      decision.reasonCode,
      decision.reason,
      stableStringify(decision.scoreTrace),
      created,
    );
    decisions.push(decision);
    decisionIndex.set(key, decision);
  };

  const classesById = new Map(payload.classes.map((c) => [c.classId, c]));
  const classesByCourse = new Map<number, SnapshotPayload['classes']>();
  for (const cls of payload.classes) {
    const list = classesByCourse.get(cls.courseId) ?? [];
    list.push(cls);
    classesByCourse.set(cls.courseId, list);
  }

  // 座位状态：以数据库真实占用为起点（预分配等已落实的课程已经占了名额）
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

  const reservationStudents = new Map<number, Set<number>>();
  for (const entry of payload.reservations) {
    reservationStudents.set(entry.courseId, new Set(entry.studentIds));
  }

  // 在数据库中已经落实的课程（预分配）：视为既成事实，不可为了本志愿退课
  const working = new Map<number, WorkingStudent>();
  for (const student of payload.students) {
    const ws: WorkingStudent = {
      studentId: student.studentId,
      studentNo: student.studentNo,
      name: student.name,
      preferences: student.preferences,
      demand: student.demand,
      randomKeys: student.randomKeys,
      assignedClasses: new Map(),
      occupancy: new Set(),
      credits: 0,
      fulfilledCourseIds: new Set(),
    };
    // 预分配课程占用座位与课表
    const preallocated = db
      .prepare(
        `SELECT e.class_id, e.course_id, e.uses_reserved, c.credits
         FROM enrollments e JOIN courses c ON c.id = e.course_id
         WHERE e.student_id = ? AND e.status = 'enrolled'`,
      )
      .all(student.studentId) as Array<{ class_id: number; course_id: number; uses_reserved: number; credits: number }>;
    for (const row of preallocated) {
      ws.assignedClasses.set(row.course_id, row.class_id);
      ws.fulfilledCourseIds.add(row.course_id);
      ws.credits += row.credits;
      const keys = classOccupancy.get(row.class_id);
      if (keys) for (const key of keys) ws.occupancy.add(key);
      const seat = seats.get(row.class_id);
      if (seat) {
        if (row.uses_reserved) seat.reservedUsed += 1;
        else seat.generalUsed += 1;
      }
    }
    working.set(student.studentId, ws);
  }

  const demandWeight: Record<DemandLevel, number> = { D2: 0, D1: 1, D0: 2 };
  const studentsOrdered = [...working.values()].sort((a, b) => {
    const demandA = Math.min(...a.preferences.map((p) => demandWeight[a.demand[String(p.courseId)]?.level ?? 'D0']), 9);
    const demandB = Math.min(...b.preferences.map((p) => demandWeight[b.demand[String(p.courseId)]?.level ?? 'D0']), 9);
    if (demandA !== demandB) return demandA - demandB;
    const rankA = Math.min(...a.preferences.map((p) => p.globalRank), Number.MAX_SAFE_INTEGER);
    const rankB = Math.min(...b.preferences.map((p) => p.globalRank), Number.MAX_SAFE_INTEGER);
    if (rankA !== rankB) return rankA - rankB;
    const seedA = a.randomKeys[String(a.preferences[0]?.courseId)] ?? String(a.studentId);
    const seedB = b.randomKeys[String(b.preferences[0]?.courseId)] ?? String(b.studentId);
    if (seedA !== seedB) return seedA < seedB ? -1 : 1;
    return a.studentId - b.studentId;
  });

  // 记录本轮已经处理的 (student, course)，避免同一课程重复判定
  const decided = new Set<string>();
  const claimSeat = (
    ws: WorkingStudent,
    classId: number,
    options: { allowReserved: boolean; reservedFor: number[] | null },
  ): { ok: true; usesReserved: boolean } | { ok: false; code: string; message: string } => {
    const cls = classesById.get(classId);
    if (!cls) return { ok: false, code: ERROR_CODES.CLASS_NOT_FOUND, message: '教学班不存在' };
    if (cls.status === 'cancelled') return { ok: false, code: ERROR_CODES.CLASS_CANCELLED, message: '教学班已取消' };
    if (cls.status !== 'open') return { ok: false, code: ERROR_CODES.CLASS_CLOSED, message: '教学班已关闭' };
    const seat = seats.get(classId);
    if (!seat) return { ok: false, code: ERROR_CODES.CLASS_NOT_FOUND, message: '教学班座位状态缺失' };

    const generalLeft = seat.capacity - seat.reservedSeats - seat.generalUsed;
    const totalLeft = seat.capacity - seat.generalUsed - seat.reservedUsed;
    if (totalLeft <= 0) {
      return { ok: false, code: ERROR_CODES.NO_CAPACITY, message: '教学班名额已满' };
    }
    if (!options.allowReserved) {
      if (generalLeft > 0) {
        seat.generalUsed += 1;
        return { ok: true, usesReserved: false };
      }
      return { ok: false, code: ERROR_CODES.RESERVED_CAPACITY_ONLY, message: '只剩毕业保障预留名额，普通申请不能占用' };
    }
    if (options.reservedFor && !options.reservedFor.includes(ws.studentId)) {
      return { ok: false, code: ERROR_CODES.RESERVED_CAPACITY_ONLY, message: '该预留名额不属于当前学生' };
    }
    // 毕业兜底：优先使用预留名额，避免把普通名额提前占掉。
    // reservedRemaining 由初始化时写入的容量快照推导，不依赖其它课程的结算顺序。
    const reservedRemaining = seats.get(classId)!.reservedSeats - seats.get(classId)!.reservedUsed;
    if (reservedRemaining > 0) {
      seat.reservedUsed += 1;
      return { ok: true, usesReserved: true };
    }
    if (generalLeft > 0) {
      seat.generalUsed += 1;
      return { ok: true, usesReserved: false };
    }
    return { ok: false, code: ERROR_CODES.NO_CAPACITY, message: '教学班名额已满' };
  };

  const releaseSeat = (classId: number, usesReserved: boolean): void => {
    const seat = seats.get(classId);
    if (!seat) return;
    if (usesReserved) seat.reservedUsed = Math.max(0, seat.reservedUsed - 1);
    else seat.generalUsed = Math.max(0, seat.generalUsed - 1);
  };

  const attempt = (
    ws: WorkingStudent,
    pref: SnapshotPayload['students'][number]['preferences'][number],
    options: { allowReserved: boolean; reservedFor: number[] | null; reasonPrefix?: string; guarantee?: boolean },
  ): AllocationDecision => {
    const demandLevel = ws.demand[String(pref.courseId)]?.level ?? 'D0';
    const randomKey = ws.randomKeys[String(pref.courseId)] ?? '';
    const groupCode = pref.groupCode;
    const base: Omit<AllocationDecision, 'decision' | 'reasonCode' | 'reason' | 'classId' | 'classCode'> = {
      studentId: ws.studentId,
      courseId: pref.courseId,
      courseName: pref.courseName,
      preferenceId: null,
      groupId: null,
      groupCode,
      demandLevel,
      globalRank: pref.globalRank,
      randomKey,
      scoreTrace: {
        demandLevel,
        globalRank: pref.globalRank,
        randomKey,
        reasons: ws.demand[String(pref.courseId)]?.reasons ?? [],
        candidateClasses: pref.classIds.length > 0 ? pref.classIds : (classesByCourse.get(pref.courseId) ?? []).map((c) => c.classId),
      },
    };

    if (ws.fulfilledCourseIds.has(pref.courseId)) {
      return {
        ...base,
        classId: null,
        classCode: null,
        decision: 'rejected',
        reasonCode: 'ALREADY_FULFILLED',
        reason: '已有该课程的有效记录，不重复落实',
      };
    }
    if (groupCode && ws.assignedClasses.size > 0) {
      const groupCourseIds = payload.students
        .find((s) => s.studentId === ws.studentId)
        ?.preferences.filter((p) => p.groupCode === groupCode)
        .map((p) => p.courseId) ?? [];
      const fulfilledInGroup = groupCourseIds.filter((id) => ws.fulfilledCourseIds.has(id));
      if (fulfilledInGroup.length > 0) {
        return {
          ...base,
          classId: null,
          classCode: null,
          decision: 'rejected',
          reasonCode: 'GROUP_FULFILLED',
          reason: `替代组「${groupCode}」已落实一门课程，组内不再重复落实`,
        };
      }
    }

    // 教学班顺序：优先学生填写的教学班偏好，再按班号
    const candidates = unique([
      ...pref.classIds.filter((id) => classesById.has(id)),
      ...(classesByCourse.get(pref.courseId) ?? []).map((c) => c.classId).sort((a, b) => a - b),
    ]);

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
      const claimed = claimSeat(ws, classId, options);
      if (!claimed.ok) {
        lastCode = claimed.code;
        lastMessage = claimed.message;
        continue;
      }
      // 毕业保障：保持剩余必要课程仍有联合可行安排
      const remainingNecessary = ws.preferences
        .filter(
          (p) =>
            !ws.fulfilledCourseIds.has(p.courseId) &&
            p.courseId !== pref.courseId &&
            (ws.demand[String(p.courseId)]?.level ?? 'D0') === 'D2',
        )
        .map((p) => p.courseId);
      if (remainingNecessary.length > 0) {
        const feasibility = checkGraduationFeasibility(db, {
          courseOptions: remainingNecessary.map((courseId) => ({
            courseId,
            courseName: classesByCourse.get(courseId)?.[0]?.courseName ?? String(courseId),
            classIds: (classesByCourse.get(courseId) ?? [])
              .filter((c) => {
                const seat = seats.get(c.classId);
                if (!seat) return false;
                const generalLeft = seat.capacity - seat.reservedSeats - seat.generalUsed;
                const totalLeft = seat.capacity - seat.generalUsed - seat.reservedUsed;
                return totalLeft > 0 && (options.allowReserved ? true : generalLeft > 0);
              })
              .map((c) => c.classId),
          })),
          fixedSchedule: [],
        });
        if (!feasibility.feasible) {
          releaseSeat(classId, claimed.usesReserved);
          lastCode = ERROR_CODES.GRADUATION_INFEASIBLE;
          lastMessage = '落实该课程后，剩余毕业必要课程不存在联合可行的安排';
          continue;
        }
      }

      ws.assignedClasses.set(pref.courseId, classId);
      ws.fulfilledCourseIds.add(pref.courseId);
      ws.credits += cls.credits;
      for (const key of occupancy) ws.occupancy.add(key);
      return {
        ...base,
        classId,
        classCode: cls.classCode,
        decision: 'allocated',
        reasonCode: 'ALLOCATED',
        reason: `${options.reasonPrefix ?? ''}按需求等级、志愿排名与固定随机键排序后落实`,
        guarantee: options.guarantee === true,
      };
    }

    return { ...base, classId: null, classCode: null, decision: 'rejected', reasonCode: lastCode, reason: lastMessage };
  };

  // 逐名学生处理（先做一次超时检查：0 上限时必须立即失败，不发布任何部分结果）
  deadline.assert('统一分配超时');
  for (const ws of studentsOrdered) {
    deadline.assert('统一分配超时');
    const preferences = [...ws.preferences].sort((a, b) => a.globalRank - b.globalRank);
    for (const pref of preferences) {
      const key = `${ws.studentId}:${pref.courseId}`;
      if (decided.has(key)) continue;
      decided.add(key);
      setDecision(runId, batchId, attempt(ws, pref, { allowReserved: false, reservedFor: null }));
    }
  }

  // 毕业兜底：普通竞争后处理尚未落实的毕业保障
  let guaranteeAttempted = 0;
  let guaranteeFulfilled = 0;
  for (const entry of payload.reservations) {
    const reservedFor = entry.studentIds;
    const classIds = (classesByCourse.get(entry.courseId) ?? []).map((c) => c.classId);
    for (const studentId of reservedFor) {
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
        continue;
      }
      if (ws.fulfilledCourseIds.has(entry.courseId)) {
        updateReservationStatus(db, batchId, entry.courseId, studentId, 'fulfilled');
        continue;
      }
      guaranteeAttempted += 1;
      const pref = ws.preferences.find((p) => p.courseId === entry.courseId);
      const syntheticPref: SnapshotPayload['students'][number]['preferences'][number] = pref ?? {
        courseId: entry.courseId,
        courseName: entry.courseName,
        credits: classesByCourse.get(entry.courseId)?.[0]?.credits ?? 0,
        globalRank: 9999,
        groupCode: null,
        classIds,
      };
      const decision = attempt(ws, { ...syntheticPref, classIds }, {
        allowReserved: true,
        reservedFor,
        reasonPrefix: '毕业保障兜底：',
        guarantee: true,
      });
      if (decision.decision === 'allocated') {
        guaranteeFulfilled += 1;
        updateReservationStatus(db, batchId, entry.courseId, studentId, 'fulfilled');
        decided.add(`${studentId}:${entry.courseId}`);
        // 毕业兜底结论覆盖普通竞争阶段的临时拒绝（同一批次内一名学生一门课程只有一条最终判定）
        setDecision(runId, batchId, decision);
      } else {
        const authorization = db
          .prepare(
            `SELECT id, status FROM upgrade_authorizations
             WHERE student_id = ? AND target_course_id = ? AND status IN ('active', 'pending')`,
          )
          .get(studentId, entry.courseId) as { id: number; status: string } | undefined;
        const kind = !authorization
          ? RESERVATION_KINDS.noAuthorization
          : decision.reasonCode === ERROR_CODES.GRADUATION_INFEASIBLE
            ? RESERVATION_KINDS.noSolution
            : RESERVATION_KINDS.rejectedAll;
        updateReservationStatus(db, batchId, entry.courseId, studentId, 'abnormal');
        exceptions.push({
          kind,
          severity: 'critical',
          studentId,
          courseId: entry.courseId,
          detail: {
            message: decision.reason,
            reasonCode: decision.reasonCode,
            hasAuthorization: Boolean(authorization),
            classIds,
          },
        });
        decided.add(`${studentId}:${entry.courseId}`);
        setDecision(runId, batchId, { ...decision, decision: 'error', reasonCode: kind });
      }
    }
  }

  // 释放确实用不到的预留余量：整门课程的保护需求全部落实后才允许
  let releasedReservedSeats = 0;
  for (const cls of payload.classes) {
    const seat = seats.get(cls.classId);
    if (!seat) continue;
    const reservedTotal = reservationStudents.get(cls.courseId)?.size ?? 0;
    if (reservedTotal === 0) continue;
    const active = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM graduation_reservations WHERE batch_id = ? AND course_id = ? AND status = 'active'",
        )
        .get(batchId, cls.courseId) as { c: number }
    ).c;
    const abnormal = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM graduation_reservations WHERE batch_id = ? AND course_id = ? AND status = 'abnormal'",
        )
        .get(batchId, cls.courseId) as { c: number }
    ).c;
    if (active === 0 && abnormal === 0 && seat.reservedUsed < seat.reservedSeats) {
      const spare = seat.reservedSeats - seat.reservedUsed;
      releasedReservedSeats += spare;
      seat.reservedSeats -= spare;
      // 真正落库：之前只改了内存与报告，会让预留名额永远留在“冻结”状态
      db.prepare('UPDATE teaching_classes SET reserved_seats = reserved_seats - ? WHERE id = ? AND reserved_seats >= ?').run(
        spare,
        cls.classId,
        spare,
      );
      // 该课程的保护需求已全部落实，释放记录写回 released 状态，便于审计
      db.prepare(
        `UPDATE graduation_reservations SET status = 'released', released_at = ?
         WHERE batch_id = ? AND course_id = ? AND status = 'fulfilled'`,
      ).run(nowIso(), batchId, cls.courseId);
    }
  }

  // 分配明细在判定时已经逐条落库（见 setDecision），这里不再重复写入

  writeGuaranteeExceptions(db, batchId, runId, exceptions);

  // 发布模式：把结果落实为正式选课记录（可安全重试）
  if (mode === 'publish') {
    publishDecisions(db, batchId, runId, decisions, actor);
  }

  return {
    decisions,
    guaranteeAttempted,
    guaranteeFulfilled,
    releasedReservedSeats,
    exceptions,
    conflictsSample,
  };
}

function updateReservationStatus(
  db: SqliteDb,
  batchId: number,
  courseId: number,
  studentId: number,
  status: 'fulfilled' | 'abnormal',
): void {
  // 试算阶段也记录状态，便于管理员在发布前就看见保障异常；
  // 预留名额的释放只在“整门课程保护需求全部落实”时才发生（见上方逻辑）。
  db.prepare(
    `UPDATE graduation_reservations SET status = ?, released_at = CASE WHEN ? = 'released' THEN ? ELSE released_at END
     WHERE batch_id = ? AND course_id = ? AND student_id = ? AND status = ?`,
  ).run(status, status, nowIso(), batchId, courseId, studentId, 'active');
}

function writeGuaranteeExceptions(
  db: SqliteDb,
  batchId: number,
  runId: number,
  exceptions: ExecutionOutcome['exceptions'],
): void {
  if (exceptions.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO exceptions (batch_id, run_id, student_id, course_id, kind, severity, status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  );
  const now = nowIso();
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
}

/**
 * 发布分配结果。
 * 可安全重试：先撤销本批次由上一次发布产生的记录，再按当前 run 的判定重新落实。
 * 因为每次执行的名额判断都基于数据库实际计数，重复发布不会重复扣名额。
 */
function publishDecisions(
  db: SqliteDb,
  batchId: number,
  runId: number,
  decisions: AllocationDecision[],
  actor: AuthUser,
): { applied: number; failed: number; failures: Array<{ studentId: number; courseId: number; reason: string }> } {
  const service = new EnrollmentService(db);
  const failures: Array<{ studentId: number; courseId: number; reason: string }> = [];
  let applied = 0;

  db.transaction(() => {
    // 撤销上一次发布（重试安全）
    db.prepare(
      `UPDATE enrollments SET status = 'cancelled', updated_at = ?, reason = ?
       WHERE batch_id = ? AND status = 'enrolled' AND source IN ('allocation', 'guarantee')`,
    ).run(nowIso(), '分配结果重新发布，旧结果作废', batchId);
  })();

  for (const decision of decisions) {
    if (decision.decision !== 'allocated' || !decision.classId) continue;
    const viaGuarantee = decision.guarantee === true;
    const result: OperationResult = service.allocateTo(decision.studentId, decision.classId, {
      source: viaGuarantee ? 'guarantee' : 'allocation',
      batchId,
      allocationRunId: runId,
      allowReserved: viaGuarantee,
      actor,
      reason: decision.reason,
      skipOperationLog: false,
      allowFrozen: true,
      idempotencyKey: `alloc:${runId}:${decision.studentId}:${decision.courseId}`,
    });
    if (result.ok) {
      applied += 1;
    } else {
      failures.push({
        studentId: decision.studentId,
        courseId: decision.courseId,
        reason: result.error?.message ?? '落实失败',
      });
    }
  }

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'allocation.apply',
    entityType: 'allocation_run',
    entityId: runId,
    summary: `发布分配结果：成功 ${applied} 项，失败 ${failures.length} 项`,
    detail: { failures: failures.slice(0, 20) },
  });

  return { applied, failed: failures.length, failures };
}

export function listRuns(db: SqliteDb, batchId: number): unknown[] {
  return db
    .prepare(
      `SELECT id, batch_id AS batchId, attempt, mode, status, snapshot_hash AS snapshotHash, started_at AS startedAt,
              finished_at AS finishedAt, duration_ms AS durationMs, failure_code AS failureCode, failure_reason AS failureReason,
              result_summary AS resultSummary, report
       FROM allocation_runs WHERE batch_id = ? ORDER BY attempt DESC`,
    )
    .all(batchId);
}

export function getRun(db: SqliteDb, runId: number): unknown {
  const run = db
    .prepare(
      `SELECT id, batch_id AS batchId, attempt, mode, status, snapshot_hash AS snapshotHash, started_at AS startedAt,
              finished_at AS finishedAt, duration_ms AS durationMs, failure_code AS failureCode, failure_reason AS failureReason,
              result_summary AS resultSummary, report
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
