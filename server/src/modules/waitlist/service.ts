/**
 * 候补与退改选。
 *
 * 规则要点：
 *   - 首轮未选中的有效申请自动进入候补，学生可以主动退出；
 *   - 允许新增或修改候补申请，但必须按“当前需求 + 当前排名 + 固定随机键”重新排序；
 *   - 展示的是“当前顺位”，不承诺永不后移；
 *   - 暂时冲突、学分不足或缺授权的申请暂挂（suspended）：保留申请但不阻塞后面的合格候补；
 *   - 永久失效的申请关闭（closed）并说明原因；
 *   - 逐个可用教学班尝试，第一个班满员时继续尝试其它已接受的教学班；
 *   - 名额先给合格候补；没有合格候补且名额不受保护时，才允许公开补选；
 *   - 同一学生在同一批次内的候补申请共用一个不重复的全局排名。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, notFound } from '../../core/errors.js';
import { deriveRandomKey, nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { assessDemand, type DemandLevel } from '../rules/service.js';
import { EnrollmentService, registerStudentChangeRecheck, registerWaitlistPromotion } from '../enrollment/service.js';
import { classSessions } from '../catalog/seat-utils.js';
import { findConflicts } from '../../core/time.js';
import { getSeatUsage } from '../catalog/service.js';
import { getBatchDto, type BatchStatus } from '../batch/service.js';

export interface WaitlistEntryDto {
  id: number;
  studentId: number;
  batchId: number;
  courseId: number;
  courseCode: string;
  courseName: string;
  credits: number;
  status: 'queued' | 'suspended' | 'promoted' | 'closed' | 'withdrawn';
  demandLevel: DemandLevel;
  globalRank: number | null;
  randomKey: string | null;
  classChoices: number[];
  position: number | null;
  queuedAhead: number | null;
  suspendCode: string | null;
  suspendReason: string | null;
  closeCode: string | null;
  closeReason: string | null;
  positionReason: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  /** 当前可用名额与候补缺口，便于学生判断是否值得等待 */
  capacity: { openClasses: number; generalAvailable: number; queued: number };
}

const DEMAND_WEIGHT: Record<DemandLevel, number> = { D2: 0, D1: 1, D0: 2 };

/** 候补只能在这些阶段进行：首轮结果发布之后 */
const WAITLIST_EDITABLE: BatchStatus[] = ['published', 'waitlist'];

function getBatchOrThrow(db: SqliteDb, batchId: number) {
  const row = db.prepare('SELECT id, term, status FROM selection_batches WHERE id = ?').get(batchId) as
    | { id: number; term: string; status: BatchStatus }
    | undefined;
  if (!row) throw notFound('批次不存在');
  return row;
}

/** 永久失效的原因：资格不符、课程不存在、重复课程、组内已落实 */
const PERMANENT_REASONS = new Set([
  'NOT_ELIGIBLE',
  'COURSE_NOT_OFFERED',
  'DUPLICATE_COURSE',
  'GROUP_FULFILLED',
  'ALREADY_FULFILLED',
  'SUBSTITUTE_GROUP_VIOLATION',
]);

/** 首轮未选中的申请自动进入候补（分配发布后在同一事务内调用） */
export function enqueueRejectedFromAllocation(db: SqliteDb, batchId: number, runId: number, actor: AuthUser): number {
  const rows = db
    .prepare(
      `SELECT ai.student_id, ai.course_id, ai.demand_level, ai.global_rank, ai.random_key, ai.reason_code
       FROM allocation_items ai
       WHERE ai.run_id = ? AND ai.decision IN ('rejected', 'error')`,
    )
    .all(runId) as Array<{
    student_id: number;
    course_id: number;
    demand_level: DemandLevel;
    global_rank: number;
    random_key: string | null;
    reason_code: string | null;
  }>;

  let queued = 0;
  const now = nowIso();
  const batch = getBatchOrThrow(db, batchId);
  for (const row of rows) {
    const already = db
      .prepare('SELECT id, status FROM waitlist_entries WHERE student_id = ? AND batch_id = ? AND course_id = ?')
      .get(row.student_id, batchId, row.course_id) as { id: number; status: string } | undefined;
    const stillEnrolled = (
      db
        .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ? AND course_id = ? AND status = 'enrolled'")
        .get(row.student_id, row.course_id) as { c: number }
    ).c;
    if (stillEnrolled > 0) {
      if (already) {
        db.prepare(
          "UPDATE waitlist_entries SET status = 'closed', close_code = 'duplicate', close_reason = ?, position_reason = ?, updated_at = ? WHERE id = ?",
        ).run('已经在正式选课中落实该课程', '已落实该课程，候补关闭', now, already.id);
      }
      continue;
    }
    // 教学班偏好只取本批次本学期的有效班
    const classChoices = (
      db
        .prepare(
          `SELECT pcc.class_id FROM preference_class_choices pcc
           JOIN preferences p ON p.id = pcc.preference_id
           JOIN preference_submissions ps ON ps.id = p.submission_id
           JOIN teaching_classes tc ON tc.id = pcc.class_id
           WHERE ps.batch_id = ? AND ps.student_id = ? AND p.course_id = ?
             AND ps.status = 'submitted' AND tc.term = ? AND tc.status = 'open'
           ORDER BY pcc.class_rank`,
        )
        .all(batchId, row.student_id, row.course_id, batch.term) as Array<{ class_id: number }>
    ).map((r) => r.class_id);

    const isPermanent = row.reason_code ? PERMANENT_REASONS.has(row.reason_code) : false;
    const status = isPermanent ? 'closed' : 'queued';
    if (already) {
      db.prepare(
        `UPDATE waitlist_entries SET status = ?, demand_level = ?, global_rank = ?, random_key = ?,
           class_choices = ?, close_code = ?, close_reason = ?, position_reason = ?, updated_at = ? WHERE id = ?`,
      ).run(
        status,
        row.demand_level,
        row.global_rank,
        row.random_key,
        JSON.stringify(classChoices),
        isPermanent ? row.reason_code : null,
        isPermanent ? '申请已永久失效' : null,
        isPermanent ? '永久失效' : '首轮未选中，转入候补',
        now,
        already.id,
      );
    } else {
      db.prepare(
        `INSERT INTO waitlist_entries
         (student_id, batch_id, course_id, class_choices, status, demand_level, global_rank, random_key,
          close_code, close_reason, position_reason, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'allocation', ?, ?)`,
      ).run(
        row.student_id,
        batchId,
        row.course_id,
        JSON.stringify(classChoices),
        status,
        row.demand_level,
        row.global_rank,
        row.random_key,
        isPermanent ? row.reason_code : null,
        isPermanent ? '申请已永久失效' : null,
        isPermanent ? '永久失效' : '首轮未选中，转入候补',
        now,
        now,
      );
    }
    if (status === 'queued') queued += 1;
  }

  // 首轮落定后统一重排：已落实更高偏好时关闭更低偏好，缺授权时暂挂
  const studentIds = Array.from(new Set(rows.map((r) => r.student_id)));
  for (const studentId of studentIds) {
    refreshStudentWaitlist(db, studentId, batchId);
  }

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'waitlist.enqueue',
    entityType: 'selection_batch',
    entityId: batchId,
    summary: `首轮未选中申请转入候补：${queued} 条`,
  });
  return queued;
}

export interface WaitlistInput {
  courseId: number;
  classIds?: number[];
  globalRank?: number | null;
}

/** 取学生在本批次提交志愿里的课程排名 */
function submittedRank(db: SqliteDb, studentId: number, batchId: number, courseId: number): number | null {
  const row = db
    .prepare(
      `SELECT p.global_rank FROM preferences p
       JOIN preference_submissions ps ON ps.id = p.submission_id
       WHERE ps.student_id = ? AND ps.batch_id = ? AND ps.status = 'submitted' AND p.course_id = ?`,
    )
    .get(studentId, batchId, courseId) as { global_rank: number } | undefined;
  return row?.global_rank ?? null;
}

/**
 * 解析候补申请的全局排名。
 * 同一学生在同一批次内的候补申请必须共用互不重复的全局排名，
 * 不允许每个申请都填“第一名”来获得优势。
 */
function resolveGlobalRank(
  db: SqliteDb,
  studentId: number,
  batchId: number,
  courseId: number,
  requested: number | null | undefined,
  selfEntryId: number | null,
): number {
  const others = db
    .prepare(
      `SELECT id, course_id, global_rank FROM waitlist_entries
       WHERE student_id = ? AND batch_id = ? AND status IN ('queued', 'suspended')`,
    )
    .all(studentId, batchId) as Array<{ id: number; course_id: number; global_rank: number | null }>;
  const taken = new Map<number, number>();
  for (const row of others) {
    if (selfEntryId !== null && row.id === selfEntryId) continue;
    if (row.global_rank !== null) taken.set(row.global_rank, row.course_id);
  }

  if (requested !== null && requested !== undefined) {
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, '全局排名必须是正整数', 422);
    }
    if (taken.has(requested)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        `全局排名 ${requested} 已被你的另一门候补申请使用，请为每门课程分配唯一排名`,
        422,
        { conflictCourseId: taken.get(requested) },
      );
    }
    return requested;
  }

  const preferred = submittedRank(db, studentId, batchId, courseId);
  if (preferred !== null && !taken.has(preferred)) return preferred;
  const max = others.reduce((acc, row) => Math.max(acc, row.global_rank ?? 0), 0);
  return Math.max(max, preferred ?? 0) + 1;
}

export function upsertWaitlistEntry(
  db: SqliteDb,
  studentId: number,
  batchId: number,
  input: WaitlistInput,
  actor: AuthUser,
): WaitlistEntryDto {
  const batch = getBatchOrThrow(db, batchId);
  if (!WAITLIST_EDITABLE.includes(batch.status)) {
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      '当前批次状态不允许修改候补申请（首轮结果发布后才可以）',
      409,
    );
  }
  const course = db.prepare('SELECT id, name, credits FROM courses WHERE id = ?').get(input.courseId) as
    | { id: number; name: string; credits: number }
    | undefined;
  if (!course) throw notFound('课程不存在');
  const enrolled = (
    db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ? AND course_id = ? AND status = 'enrolled'").get(
      studentId,
      input.courseId,
    ) as { c: number }
  ).c;
  if (enrolled > 0) {
    throw new AppError(ERROR_CODES.DUPLICATE_COURSE, '该课程已经有有效选课记录，不需要候补', 409);
  }

  // 候选教学班必须属于本批次学期且当前开放
  const openClasses = db
    .prepare("SELECT id FROM teaching_classes WHERE course_id = ? AND term = ? AND status = 'open'")
    .all(input.courseId, batch.term) as Array<{ id: number }>;
  const openIds = new Set(openClasses.map((c) => c.id));
  const classIds = (input.classIds ?? []).filter((id) => openIds.has(id));

  const demand = assessDemand(db, studentId, [input.courseId]).get(input.courseId);
  const learner = db
    .prepare('SELECT random_key FROM student_course_random_keys WHERE student_id = ? AND course_id = ? AND term = ?')
    .get(studentId, input.courseId, batch.term) as { random_key: string } | undefined;
  const randomKey = learner?.random_key ?? deriveRandomKey(`${batchId}:${batch.term}`, studentId, input.courseId);
  if (!learner) {
    db.prepare(
      'INSERT INTO student_course_random_keys (student_id, course_id, term, random_key, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(studentId, input.courseId, batch.term, randomKey, nowIso());
  }

  const now = nowIso();
  const existing = db
    .prepare('SELECT id FROM waitlist_entries WHERE student_id = ? AND batch_id = ? AND course_id = ?')
    .get(studentId, batchId, input.courseId) as { id: number } | undefined;
  const globalRank = resolveGlobalRank(db, studentId, batchId, input.courseId, input.globalRank ?? null, existing?.id ?? null);

  if (existing) {
    db.prepare(
      `UPDATE waitlist_entries SET class_choices = ?, status = 'queued', demand_level = ?, global_rank = ?,
         random_key = ?, suspend_code = NULL, suspend_reason = NULL, close_code = NULL, close_reason = NULL,
         position_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(
      JSON.stringify(classIds.length > 0 ? classIds : openClasses.map((c) => c.id)),
      demand?.demandLevel ?? 'D0',
      globalRank,
      randomKey,
      '学生修改候补申请',
      now,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO waitlist_entries
       (student_id, batch_id, course_id, class_choices, status, demand_level, global_rank, random_key,
        position_reason, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, 'manual', ?, ?)`,
    ).run(
      studentId,
      batchId,
      input.courseId,
      JSON.stringify(classIds.length > 0 ? classIds : openClasses.map((c) => c.id)),
      demand?.demandLevel ?? 'D0',
      globalRank,
      randomKey,
      '学生新增候补申请',
      now,
      now,
    );
  }
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'waitlist.upsert',
    entityType: 'waitlist_entry',
    entityId: input.courseId,
    summary: `更新候补申请：${course.name}`,
  });
  refreshStudentWaitlist(db, studentId, batchId);
  return getWaitlistEntry(db, studentId, batchId, input.courseId)!;
}

export function withdrawWaitlist(db: SqliteDb, studentId: number, entryId: number, actor: AuthUser): void {
  const row = db.prepare('SELECT id, student_id, status FROM waitlist_entries WHERE id = ?').get(entryId) as
    | { id: number; student_id: number; status: string }
    | undefined;
  if (!row) throw notFound('候补记录不存在');
  if (row.student_id !== studentId && actor.role !== 'admin') {
    throw new AppError(ERROR_CODES.FORBIDDEN, '只能退出自己的候补', 403);
  }
  db.prepare(
    "UPDATE waitlist_entries SET status = 'withdrawn', withdrawn_at = ?, position_reason = ?, updated_at = ? WHERE id = ?",
  ).run(nowIso(), '学生主动退出候补', nowIso(), entryId);
}

/** 计算某门课程当前候补队列（按当前需求、排名、固定随机键排序） */
export function computeQueue(db: SqliteDb, batchId: number, courseId: number): Array<{
  entryId: number;
  studentId: number;
  demandLevel: DemandLevel;
  globalRank: number | null;
  randomKey: string | null;
  status: string;
}> {
  // 暂挂（suspended）只是“条件暂不满足”，并没有退出队列：
  // 它仍然按需求等级 + 排名 + 固定随机键参与排序，条件恢复后回到原来的顺位。
  const rows = db
    .prepare(
      `SELECT id AS entryId, student_id AS studentId, demand_level AS demandLevel, global_rank AS globalRank,
              random_key AS randomKey, status
       FROM waitlist_entries WHERE batch_id = ? AND course_id = ? AND status IN ('queued', 'suspended')`,
    )
    .all(batchId, courseId) as Array<{
    entryId: number;
    studentId: number;
    demandLevel: DemandLevel;
    globalRank: number | null;
    randomKey: string | null;
    status: string;
  }>;
  return rows.sort((a, b) => {
    const wa = DEMAND_WEIGHT[a.demandLevel] ?? 3;
    const wb = DEMAND_WEIGHT[b.demandLevel] ?? 3;
    if (wa !== wb) return wa - wb;
    const ra = a.globalRank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.globalRank ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    const ka = a.randomKey ?? '';
    const kb = b.randomKey ?? '';
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.entryId - b.entryId;
  });
}

export function getWaitlistEntry(db: SqliteDb, studentId: number, batchId: number, courseId: number): WaitlistEntryDto | null {
  const entry = db
    .prepare(
      `SELECT we.*, c.code AS course_code, c.name AS course_name, c.credits
       FROM waitlist_entries we JOIN courses c ON c.id = we.course_id
       WHERE we.student_id = ? AND we.batch_id = ? AND we.course_id = ?`,
    )
    .get(studentId, batchId, courseId) as
    | (Record<string, unknown> & {
        id: number;
        course_id: number;
        status: WaitlistEntryDto['status'];
        demand_level: DemandLevel;
        global_rank: number | null;
        random_key: string | null;
        class_choices: string | null;
        suspend_code: string | null;
        suspend_reason: string | null;
        close_code: string | null;
        close_reason: string | null;
        position_reason: string | null;
        source: string | null;
        created_at: string;
        updated_at: string;
        course_code: string;
        course_name: string;
        credits: number;
      })
    | undefined;
  if (!entry) return null;
  const queue = computeQueue(db, batchId, entry.course_id);
  const index = queue.findIndex((q) => q.entryId === entry.id);
  const classes = listOpenClassesForBatchCourse(db, batchId, entry.course_id);
  const generalAvailable = classes.reduce((sum, c) => sum + getSeatUsage(db, c.id).generalAvailable, 0);
  return {
    id: entry.id,
    studentId,
    batchId,
    courseId: entry.course_id,
    courseCode: entry.course_code,
    courseName: entry.course_name,
    credits: entry.credits,
    status: entry.status,
    demandLevel: entry.demand_level,
    globalRank: entry.global_rank,
    randomKey: entry.random_key,
    classChoices: entry.class_choices ? (JSON.parse(entry.class_choices) as number[]) : [],
    position: index >= 0 ? index + 1 : null,
    queuedAhead: index >= 0 ? index : null,
    suspendCode: entry.suspend_code,
    suspendReason: entry.suspend_reason,
    closeCode: entry.close_code,
    closeReason: entry.close_reason,
    positionReason: entry.position_reason,
    source: entry.source,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    capacity: { openClasses: classes.length, generalAvailable, queued: queue.length },
  };
}

export function listWaitlistForStudent(db: SqliteDb, studentId: number, batchId: number): WaitlistEntryDto[] {
  const rows = db
    .prepare('SELECT course_id FROM waitlist_entries WHERE student_id = ? AND batch_id = ? ORDER BY id')
    .all(studentId, batchId) as Array<{ course_id: number }>;
  return rows
    .map((row) => getWaitlistEntry(db, studentId, batchId, row.course_id))
    .filter((entry): entry is WaitlistEntryDto => entry !== null);
}

/** 本批次本学期、当前开放的教学班（严格限制在正确学期内） */
function listOpenClassesForBatchCourse(db: SqliteDb, batchId: number, courseId: number): Array<{ id: number }> {
  const batch = getBatchOrThrow(db, batchId);
  return db
    .prepare("SELECT id FROM teaching_classes WHERE course_id = ? AND term = ? AND status = 'open' ORDER BY id")
    .all(courseId, batch.term) as Array<{ id: number }>;
}

/**
 * 按“当前需求 + 当前已落实课表”重排一名学生的候补申请：
 *   - 已落实更高偏好（排名更靠前）→ 关闭更低偏好；
 *   - 目标是比已落实课程更高的偏好，但没有替换授权 → 暂挂，等待学生授权；
 *   - 其余保持排队。
 * 同时在选退课、修读记录确认、授权变化后刷新需求等级与顺位。
 */
export function refreshStudentWaitlist(db: SqliteDb, studentId: number, batchId: number): void {
  const entries = db
    .prepare(
      `SELECT id, course_id, status, global_rank, demand_level FROM waitlist_entries
       WHERE student_id = ? AND batch_id = ? AND status IN ('queued', 'suspended')`,
    )
    .all(studentId, batchId) as Array<{
    id: number;
    course_id: number;
    status: string;
    global_rank: number | null;
    demand_level: DemandLevel;
  }>;
  if (entries.length === 0) return;
  const batch = getBatchOrThrow(db, batchId);

  const demand = assessDemand(db, studentId, entries.map((e) => e.course_id));

  // 学生在本批次已经正式落实的课程及其志愿排名
  const enrolled = db
    .prepare(
      `SELECT DISTINCT e.course_id FROM enrollments e
       JOIN teaching_classes tc ON tc.id = e.class_id
       WHERE e.student_id = ? AND tc.term = ? AND e.status = 'enrolled'`,
    )
    .all(studentId, batch.term) as Array<{ course_id: number }>;
  const enrolledRanks = enrolled
    .map((row) => submittedRank(db, studentId, batchId, row.course_id))
    .filter((rank): rank is number => rank !== null);
  // 只有“已经落实了某门课”时，才谈得上更高偏好升级与更低偏好关闭
  const hasAllocation = enrolledRanks.length > 0;
  const highestAllocatedRank = hasAllocation ? Math.min(...enrolledRanks) : Number.MAX_SAFE_INTEGER;

  const now = nowIso();
  for (const entry of entries) {
    const demandLevel = demand.get(entry.course_id)?.demandLevel ?? entry.demand_level;
    const rank = entry.global_rank ?? submittedRank(db, studentId, batchId, entry.course_id) ?? Number.MAX_SAFE_INTEGER;

    if (hasAllocation && rank > highestAllocatedRank) {
      db.prepare(
        `UPDATE waitlist_entries SET status = 'closed', close_code = 'lower_preference', close_reason = ?,
           position_reason = ?, demand_level = ?, updated_at = ? WHERE id = ?`,
      ).run('已落实更高偏好的课程，关闭更低偏好', '顺位变化：更高偏好已落实', demandLevel, now, entry.id);
      continue;
    }

    if (hasAllocation && rank < highestAllocatedRank) {
      // 比已落实课程更好的偏好：需要学生明确授权“用目标课程替换原课程”
      const authorization = db
        .prepare(
          `SELECT id FROM upgrade_authorizations
           WHERE student_id = ? AND batch_id = ? AND target_course_id = ? AND status IN ('active', 'pending')`,
        )
        .get(studentId, batchId, entry.course_id) as { id: number } | undefined;
      if (!authorization) {
        db.prepare(
          `UPDATE waitlist_entries SET status = 'suspended', suspend_code = ?, suspend_reason = ?,
             position_reason = ?, demand_level = ?, updated_at = ? WHERE id = ?`,
        ).run(
          ERROR_CODES.AUTHORIZATION_REQUIRED,
          '更高偏好需要你先确认用目标课程替换原课程，确认后会自动重新检查',
          '顺位变化：等待学生授权自动升级',
          demandLevel,
          now,
          entry.id,
        );
        continue;
      }
    }

    // 未被关闭的申请只刷新需求等级；是否恢复“可执行”由提升尝试时重新判断，
    // 以免把仍然冲突/缺授权的申请错误地标成可执行。
    db.prepare('UPDATE waitlist_entries SET demand_level = ? WHERE id = ?').run(demandLevel, entry.id);
  }

  // 更新顺位展示（仅展示，不承诺）
  const courseIds = Array.from(new Set(entries.map((e) => e.course_id)));
  for (const courseId of courseIds) {
    const queue = computeQueue(db, batchId, courseId);
    queue.forEach((row, index) => {
      db.prepare('UPDATE waitlist_entries SET position_hint = ? WHERE id = ?').run(index + 1, row.entryId);
    });
  }
}

/**
 * 重新检查一名学生的候补状态：
 * 条件变化（退了别的课腾出时间、学分变化、补齐授权）后可以重新变为合格。
 */
export function recheckStudentWaitlist(db: SqliteDb, studentId: number, batchId: number, actor: AuthUser): {
  checked: number;
  promoted: number;
  suspended: number;
  closed: number;
} {
  refreshStudentWaitlist(db, studentId, batchId);
  const entries = db
    .prepare('SELECT id, course_id FROM waitlist_entries WHERE student_id = ? AND batch_id = ? AND status IN (?, ?)')
    .all(studentId, batchId, 'queued', 'suspended') as Array<{ id: number; course_id: number }>;
  const service = new EnrollmentService(db);
  let promoted = 0;
  let suspended = 0;
  let closed = 0;

  for (const entry of entries) {
    const result = tryPromote(db, service, entry.id, actor, { trigger: 'recheck' });
    if (result === 'promoted') promoted += 1;
    else if (result === 'suspended') suspended += 1;
    else if (result === 'closed') closed += 1;
  }

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'waitlist.recheck',
    entityType: 'student',
    entityId: studentId,
    summary: `重新检查候补：提升 ${promoted}，暂挂 ${suspended}，关闭 ${closed}`,
  });
  return { checked: entries.length, promoted, suspended, closed };
}

type PromoteOutcome = 'promoted' | 'suspended' | 'closed' | 'pending';

/**
 * 尝试提升单条候补。
 * 若暂时不满足条件（时间冲突/学分/缺授权）则暂挂；永久失效则关闭；
 * 名额不足则保持排队。
 */
function tryPromote(
  db: SqliteDb,
  service: EnrollmentService,
  entryId: number,
  actor: AuthUser | undefined,
  options: { trigger: string },
): PromoteOutcome {
  const entry = db
    .prepare(
      `SELECT we.id, we.student_id, we.batch_id, we.course_id, we.class_choices, we.status,
              sb.status AS batch_status, sb.term
       FROM waitlist_entries we JOIN selection_batches sb ON sb.id = we.batch_id
       WHERE we.id = ?`,
    )
    .get(entryId) as
    | {
        id: number;
        student_id: number;
        batch_id: number;
        course_id: number;
        class_choices: string | null;
        status: string;
        batch_status: BatchStatus;
        term: string;
      }
    | undefined;
  if (!entry) return 'pending';
  if (entry.status !== 'queued' && entry.status !== 'suspended') return 'pending';
  // 批次结束后不再递补
  if (entry.batch_status !== 'published' && entry.batch_status !== 'waitlist') return 'pending';

  const classes = listOpenClassesForBatchCourse(db, entry.batch_id, entry.course_id);
  if (classes.length === 0) {
    db.prepare(
      "UPDATE waitlist_entries SET status = 'closed', close_code = 'course_cancelled', close_reason = ?, position_reason = ?, updated_at = ? WHERE id = ?",
    ).run('课程本学期不再开设教学班', '课程已取消', nowIso(), entry.id);
    return 'closed';
  }

  const generalAvailable = classes.reduce((sum, c) => sum + getSeatUsage(db, c.id).generalAvailable, 0);
  if (generalAvailable <= 0) return 'pending';

  const accepted = entry.class_choices ? (JSON.parse(entry.class_choices) as number[]) : [];
  const openIds = classes.map((c) => c.id);
  // 已接受的教学班优先；没有接受任何班时退化为所有开放班
  const ordered = [
    ...accepted.filter((id) => openIds.includes(id)),
    ...openIds.filter((id) => !accepted.includes(id)),
  ];

  let lastError: { code: string; message: string } | null = null;
  for (const classId of ordered) {
    const result = service.allocateTo(entry.student_id, classId, {
      source: 'waitlist',
      opType: 'promote',
      batchId: entry.batch_id,
      actor,
      reason: '候补名额释放后提升',
      // 普通候补不能占用毕业保障预留名额（预留只给兜底使用）
      allowReserved: false,
      // 候补提升是“每次条件变化后的重新尝试”，不是用户重复点击，
      // 因此不写统一幂等记录（否则上一次失败会固化，条件变好后永远无法提升）。
      // 提升过程本身在 waitlist_entries 与 audit_logs 里可追溯。
      skipOperationLog: true,
    });
    if (result.ok) {
      db.prepare(
        `UPDATE waitlist_entries SET status = 'promoted', promoted_at = ?, updated_at = ?, suspend_code = NULL,
           suspend_reason = NULL, position_reason = ? WHERE id = ?`,
      ).run(nowIso(), nowIso(), `候补提升成功（${options.trigger}）`, entry.id);
      writeAudit(db, {
        actorId: actor?.id,
        actorName: actor?.username ?? 'system',
        action: 'waitlist.promote',
        entityType: 'waitlist_entry',
        entityId: entry.id,
        summary: `候补提升成功（触发：${options.trigger}）`,
      });
      // 一名学生提升后，其它课程的候补条件可能变化
      refreshStudentWaitlist(db, entry.student_id, entry.batch_id);
      recheckOtherEntries(db, entry.student_id, entry.batch_id, entry.course_id, actor);
      return 'promoted';
    }
    lastError = result.error ? { code: result.error.code, message: result.error.message } : null;
    // 第一个教学班满员时继续尝试其它已接受的教学班，而不是直接放弃
    if (result.error?.code === ERROR_CODES.NO_CAPACITY || result.error?.code === ERROR_CODES.RESERVED_CAPACITY_ONLY) {
      continue;
    }
  }

  if (!lastError) return 'pending';
  const permanentCodes: string[] = [
    ERROR_CODES.DUPLICATE_COURSE,
    ERROR_CODES.NOT_ELIGIBLE,
    ERROR_CODES.CLASS_CANCELLED,
    ERROR_CODES.CLASS_CLOSED,
    ERROR_CODES.SUBSTITUTE_GROUP_VIOLATION,
    'COURSE_NOT_OFFERED',
  ];
  if (permanentCodes.includes(lastError.code)) {
    db.prepare(
      "UPDATE waitlist_entries SET status = 'closed', close_code = ?, close_reason = ?, position_reason = ?, updated_at = ? WHERE id = ?",
    ).run(lastError.code, lastError.message, `永久失效：${lastError.message}`, nowIso(), entry.id);
    return 'closed';
  }
  db.prepare(
    `UPDATE waitlist_entries SET status = 'suspended', suspend_code = ?, suspend_reason = ?, position_reason = ?, updated_at = ? WHERE id = ?`,
  ).run(lastError.code, lastError.message, `暂挂：${lastError.message}`, nowIso(), entry.id);
  return 'suspended';
}

function recheckOtherEntries(
  db: SqliteDb,
  studentId: number,
  batchId: number,
  excludeCourseId: number,
  actor: AuthUser | undefined,
): void {
  const others = db
    .prepare('SELECT id FROM waitlist_entries WHERE student_id = ? AND batch_id = ? AND course_id != ? AND status IN (?, ?)')
    .all(studentId, batchId, excludeCourseId, 'queued', 'suspended') as Array<{ id: number }>;
  const service = new EnrollmentService(db);
  for (const other of others) {
    tryPromote(db, service, other.id, actor, { trigger: 'cascade' });
  }
}

/**
 * 名额释放后的候补提升入口。
 * 由正式选课服务在退课/换班成功后调用（注册到 enrollment 模块，避免循环依赖）。
 */
export function promoteWaitlistForClass(db: SqliteDb, classId: number): void {
  const cls = db.prepare('SELECT id, course_id FROM teaching_classes WHERE id = ?').get(classId) as
    | { id: number; course_id: number }
    | undefined;
  if (!cls) return;
  const batches = db
    .prepare(
      `SELECT DISTINCT we.batch_id AS batchId
       FROM waitlist_entries we JOIN selection_batches sb ON sb.id = we.batch_id
       WHERE we.course_id = ? AND we.status IN ('queued', 'suspended')
         AND sb.status IN ('published', 'waitlist')`,
    )
    .all(cls.course_id) as Array<{ batchId: number }>;
  for (const { batchId } of batches) {
    promoteCourseQueue(db, batchId, cls.course_id);
  }
}

/**
 * 逐条尝试某一门课程的候补队列。
 * 暂挂者保留申请但不阻塞后面的合格候补：
 *   - 提升成功 → 继续尝试，填满释放出来的名额；
 *   - 暂挂     → 继续看下一位合格候补；
 *   - 无名额   → 停止。
 */
function promoteCourseQueue(db: SqliteDb, batchId: number, courseId: number): void {
  const service = new EnrollmentService(db);
  const queue = computeQueue(db, batchId, courseId);
  for (const row of queue) {
    const remaining = listOpenClassesForBatchCourse(db, batchId, courseId).reduce(
      (sum, c) => sum + getSeatUsage(db, c.id).generalAvailable,
      0,
    );
    if (remaining <= 0) return;
    const outcome = tryPromote(db, service, row.entryId, undefined, { trigger: 'seat_released' });
    if (outcome === 'pending') return;
    // promoted / suspended / closed：都继续看下一位，暂挂者不阻塞队列
  }
}

/** 注册到正式选课服务：退课/换班释放名额后自动尝试提升候补 */
export function registerWaitlistModule(): void {
  registerWaitlistPromotion((db, classId) => promoteWaitlistForClass(db, classId));
  registerStudentChangeRecheck((db, studentId, batchId) => onStudentScheduleChanged(db, studentId, batchId));
}

/**
 * 选退课 / 修读记录确认 / 授权变化后重新评估一名学生的候补：
 * 先按最新需求与最新已落实课表重排，再逐条尝试提升。
 */
export function onStudentScheduleChanged(
  db: SqliteDb,
  studentId: number,
  batchId: number,
  actor?: AuthUser,
): { checked: number; promoted: number; suspended: number; closed: number } {
  refreshStudentWaitlist(db, studentId, batchId);
  const entries = db
    .prepare('SELECT id FROM waitlist_entries WHERE student_id = ? AND batch_id = ? AND status IN (?, ?)')
    .all(studentId, batchId, 'queued', 'suspended') as Array<{ id: number }>;
  const service = new EnrollmentService(db);
  let promoted = 0;
  let suspended = 0;
  let closed = 0;
  for (const entry of entries) {
    const outcome = tryPromote(db, service, entry.id, actor, { trigger: 'schedule_change' });
    if (outcome === 'promoted') promoted += 1;
    else if (outcome === 'suspended') suspended += 1;
    else if (outcome === 'closed') closed += 1;
  }
  return { checked: entries.length, promoted, suspended, closed };
}

/**
 * 公开补选判定：没有合格候补、且名额不受保护时才允许。
 * 返回值用于前端提示与管理端展示。
 */
export function canPublicSupplement(db: SqliteDb, batchId: number, courseId: number): {
  allowed: boolean;
  reason: string;
  qualifiedWaitlist: number;
  protectedSeats: number;
  generalAvailable: number;
} {
  const batch = getBatchDto(db, batchId);
  const config = db.prepare("SELECT value FROM app_configs WHERE key = 'public_supplement_enabled'").get() as
    | { value: string }
    | undefined;
  const enabled = config ? config.value === 'true' || config.value === '1' : true;
  const qualified = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM waitlist_entries WHERE batch_id = ? AND course_id = ? AND status IN ('queued', 'suspended')",
      )
      .get(batchId, courseId) as { c: number }
  ).c;
  const classes = listOpenClassesForBatchCourse(db, batchId, courseId);
  const protectedSeats = classes.reduce((sum, c) => sum + getSeatUsage(db, c.id).reservedSeats, 0);
  const generalAvailable = classes.reduce((sum, c) => sum + getSeatUsage(db, c.id).generalAvailable, 0);
  const result = { qualifiedWaitlist: qualified, protectedSeats, generalAvailable };
  if (!enabled) return { allowed: false, reason: '管理员已关闭公开补选', ...result };
  if (batch.status !== 'waitlist') {
    return { allowed: false, reason: '当前批次尚未进入候补与补选阶段', ...result };
  }
  if (qualified > 0) {
    return {
      allowed: false,
      reason: `还有 ${qualified} 条合格候补在队列中，名额必须先给候补`,
      ...result,
    };
  }
  if (generalAvailable <= 0) {
    return {
      allowed: false,
      reason:
        protectedSeats > 0
          ? '该课程只剩毕业保障预留名额，预留未释放前不能公开补选'
          : '该课程当前没有可用名额',
      ...result,
    };
  }
  return { allowed: true, reason: '没有合格候补且存在可用普通名额，可以公开补选', ...result };
}

/** 暂挂中的候补继续占用队列位置吗？—— 不占用名额，但保留记录，可直接用于顺位展示 */
export function describeSuspendReason(code: string | null): string {
  switch (code) {
    case ERROR_CODES.TIME_CONFLICT:
      return '与当前课表时间冲突，退掉冲突课程后会自动重新检查';
    case ERROR_CODES.CREDIT_LIMIT_EXCEEDED:
      return '学分已满，调整选课后会自动重新检查';
    case ERROR_CODES.AUTHORIZATION_REQUIRED:
    case ERROR_CODES.AUTHORIZATION_INVALIDATED:
    case ERROR_CODES.AUTHORIZATION_SUSPENDED:
      return '缺少有效的替换授权，请在“我的授权”里确认后才能自动升级';
    case ERROR_CODES.MATERIAL_NOT_CONFIRMED:
      return '个人修读记录尚未确认';
    default:
      return '条件暂不满足，系统会在条件变化后重新检查';
  }
}

/** 教学班时间冲突的辅助：判断某个候补课程是否与当前课表冲突 */
export function hasTimeConflictWithCurrent(db: SqliteDb, studentId: number, courseId: number): boolean {
  const current = db
    .prepare(
      `SELECT cs.day_of_week, cs.period_start, cs.period_end, cs.week_start, cs.week_end, cs.week_parity
       FROM enrollments e
       JOIN class_sessions cs ON cs.class_id = e.class_id
       WHERE e.student_id = ? AND e.status = 'enrolled'`,
    )
    .all(studentId) as Array<{
    day_of_week: number;
    period_start: number;
    period_end: number;
    week_start: number;
    week_end: number;
    week_parity: string;
  }>;
  const classIds = (
    db.prepare("SELECT id FROM teaching_classes WHERE course_id = ? AND status = 'open'").all(courseId) as Array<{
      id: number;
    }>
  ).map((c) => c.id);
  const sessions = classSessions(db, classIds);
  for (const list of sessions.values()) {
    if (findConflicts(current, list).length > 0) return true;
  }
  return false;
}
