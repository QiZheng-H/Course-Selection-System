/**
 * 候补与退改选。
 *
 * 规则要点：
 *   - 首轮未选中的有效申请自动进入候补，学生可以主动退出；
 *   - 允许新增或修改候补申请，但必须按“当前需求 + 当前排名 + 固定随机键”重新排序；
 *   - 展示的是“当前顺位”，不承诺永不后移；
 *   - 暂时冲突、学分不足、缺授权的申请暂挂（suspended），条件变化后重新检查；
 *   - 永久失效的申请关闭（closed）并说明原因；
 *   - 名额先给合格候补；没有合格候补且名额不受保护时，才允许公开补选。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, notFound } from '../../core/errors.js';
import { deriveRandomKey, nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { assessDemand, type DemandLevel } from '../rules/service.js';
import { EnrollmentService, registerWaitlistPromotion } from '../enrollment/service.js';
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
  createdAt: string;
  updatedAt: string;
  /** 当前可用名额与候补缺口，便于学生判断是否值得等待 */
  capacity: { openClasses: number; generalAvailable: number; queued: number };
}

const DEMAND_WEIGHT: Record<DemandLevel, number> = { D2: 0, D1: 1, D0: 2 };

function getBatchOrThrow(db: SqliteDb, batchId: number) {
  const row = db.prepare('SELECT id, term, status FROM selection_batches WHERE id = ?').get(batchId) as
    | { id: number; term: string; status: BatchStatus }
    | undefined;
  if (!row) throw notFound('批次不存在');
  return row;
}

/** 首轮未选中的申请自动进入候补（分配发布后调用） */
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

  // 永久失效的原因：资格不符、课程不存在、重复课程、组内已落实
  const permanent = new Set(['NOT_ELIGIBLE', 'COURSE_NOT_OFFERED', 'DUPLICATE_COURSE', 'GROUP_FULFILLED', 'ALREADY_FULFILLED']);

  let queued = 0;
  const now = nowIso();
  db.transaction(() => {
    for (const row of rows) {
      const already = db
        .prepare('SELECT id, status FROM waitlist_entries WHERE student_id = ? AND batch_id = ? AND course_id = ?')
        .get(row.student_id, batchId, row.course_id) as { id: number; status: string } | undefined;
      const stillNeeded = (
        db
          .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ? AND course_id = ? AND status = 'enrolled'")
          .get(row.student_id, row.course_id) as { c: number }
      ).c;
      if (stillNeeded > 0) {
        if (already) {
          db.prepare("UPDATE waitlist_entries SET status = 'closed', close_code = 'duplicate', close_reason = ?, updated_at = ? WHERE id = ?").run(
            '已经在正式选课中落实该课程',
            now,
            already.id,
          );
        }
        continue;
      }
      const classChoices = (
        db
          .prepare(
            `SELECT pcc.class_id FROM preference_class_choices pcc
             JOIN preferences p ON p.id = pcc.preference_id
             JOIN preference_submissions ps ON ps.id = p.submission_id
             WHERE ps.batch_id = ? AND ps.student_id = ? AND p.course_id = ?
               AND ps.status = 'submitted'
             ORDER BY pcc.class_rank`,
          )
          .all(batchId, row.student_id, row.course_id) as Array<{ class_id: number }>
      ).map((r) => r.class_id);

      const isPermanent = row.reason_code ? permanent.has(row.reason_code) : false;
      const status = isPermanent ? 'closed' : 'queued';
      if (already) {
        db.prepare(
          `UPDATE waitlist_entries SET status = ?, demand_level = ?, global_rank = ?, random_key = ?,
             class_choices = ?, close_code = ?, close_reason = ?, updated_at = ? WHERE id = ?`,
        ).run(
          status,
          row.demand_level,
          row.global_rank,
          row.random_key,
          JSON.stringify(classChoices),
          isPermanent ? row.reason_code : null,
          isPermanent ? '申请已永久失效' : null,
          now,
          already.id,
        );
      } else {
        db.prepare(
          `INSERT INTO waitlist_entries
           (student_id, batch_id, course_id, class_choices, status, demand_level, global_rank, random_key,
            close_code, close_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          now,
          now,
        );
      }
      if (status === 'queued') queued += 1;
    }
  })();

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

export function upsertWaitlistEntry(
  db: SqliteDb,
  studentId: number,
  batchId: number,
  input: WaitlistInput,
  actor: AuthUser,
): WaitlistEntryDto {
  const batch = getBatchOrThrow(db, batchId);
  if (batch.status === 'frozen' || batch.status === 'closed' || batch.status === 'preparing') {
    throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '当前批次状态不允许修改候补申请', 409);
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

  if (existing) {
    db.prepare(
      `UPDATE waitlist_entries SET class_choices = ?, status = 'queued', demand_level = ?, global_rank = COALESCE(?, global_rank),
         random_key = ?, suspend_code = NULL, suspend_reason = NULL, updated_at = ? WHERE id = ?`,
    ).run(
      JSON.stringify(input.classIds ?? []),
      demand?.demandLevel ?? 'D0',
      input.globalRank ?? null,
      randomKey,
      now,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO waitlist_entries
       (student_id, batch_id, course_id, class_choices, status, demand_level, global_rank, random_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(
      studentId,
      batchId,
      input.courseId,
      JSON.stringify(input.classIds ?? []),
      demand?.demandLevel ?? 'D0',
      input.globalRank ?? null,
      randomKey,
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
  void getBatchDto;
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
  db.prepare("UPDATE waitlist_entries SET status = 'withdrawn', withdrawn_at = ?, updated_at = ? WHERE id = ?").run(
    nowIso(),
    nowIso(),
    entryId,
  );
}

/** 计算某门课程当前候补队列（按当前需求、排名、固定随机键排序） */
export function computeQueue(db: SqliteDb, batchId: number, courseId: number): Array<{
  entryId: number;
  studentId: number;
  demandLevel: DemandLevel;
  globalRank: number | null;
  randomKey: string | null;
}> {
  // 暂挂（suspended）只是“条件暂不满足”，并没有退出队列：
  // 它仍然按需求等级 + 排名 + 固定随机键参与排序，条件恢复后回到原来的顺位。
  const rows = db
    .prepare(
      `SELECT id AS entryId, student_id AS studentId, demand_level AS demandLevel, global_rank AS globalRank, random_key AS randomKey
       FROM waitlist_entries WHERE batch_id = ? AND course_id = ? AND status IN ('queued', 'suspended')`,
    )
    .all(batchId, courseId) as Array<{
    entryId: number;
    studentId: number;
    demandLevel: DemandLevel;
    globalRank: number | null;
    randomKey: string | null;
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
  const classes = db
    .prepare("SELECT id FROM teaching_classes WHERE course_id = ? AND status = 'open'")
    .all(entry.course_id) as Array<{ id: number }>;
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
  const entries = db
    .prepare('SELECT id, course_id FROM waitlist_entries WHERE student_id = ? AND batch_id = ? AND status IN (?, ?)')
    .all(studentId, batchId, 'queued', 'suspended') as Array<{ id: number; course_id: number }>;
  const service = new EnrollmentService(db);
  const now = nowIso();
  let promoted = 0;
  let suspended = 0;
  let closed = 0;

  for (const entry of entries) {
    const queue = computeQueue(db, batchId, entry.course_id);
    const position = queue.findIndex((q) => q.entryId === entry.id) + 1;
    db.prepare('UPDATE waitlist_entries SET position_hint = ?, updated_at = ? WHERE id = ?').run(
      position > 0 ? position : null,
      now,
      entry.id,
    );
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
 * 若是排队在后面（名额不足）则保持排队。
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

  const queue = computeQueue(db, entry.batch_id, entry.course_id);
  const index = queue.findIndex((q) => q.entryId === entry.id);
  if (index < 0) return 'pending';

  const classes = db
    .prepare("SELECT id FROM teaching_classes WHERE course_id = ? AND status = 'open' ORDER BY id")
    .all(entry.course_id) as Array<{ id: number }>;
  if (classes.length === 0) {
    db.prepare("UPDATE waitlist_entries SET status = 'closed', close_code = 'course_cancelled', close_reason = ?, updated_at = ? WHERE id = ?").run(
      '课程本学期不再开设教学班',
      nowIso(),
      entry.id,
    );
    return 'closed';
  }

  // 只有排在最前、且仍有普通名额时才尝试（毕业预留不面向普通候补）
  const generalAvailable = classes.reduce((sum, c) => sum + getSeatUsage(db, c.id).generalAvailable, 0);
  if (generalAvailable <= 0) return 'pending';
  if (index > 0) {
    // 前面还有人：先把顺位记录下来，等他们处理完
    db.prepare('UPDATE waitlist_entries SET position_hint = ? WHERE id = ?').run(index + 1, entry.id);
    return 'pending';
  }

  const preferred = entry.class_choices ? (JSON.parse(entry.class_choices) as number[]) : [];
  const ordered = [...preferred.filter((id) => classes.some((c) => c.id === id)), ...classes.map((c) => c.id)];

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
        "UPDATE waitlist_entries SET status = 'promoted', promoted_at = ?, updated_at = ?, suspend_code = NULL, suspend_reason = NULL WHERE id = ?",
      ).run(nowIso(), nowIso(), entry.id);
      writeAudit(db, {
        actorId: actor?.id,
        actorName: actor?.username ?? 'system',
        action: 'waitlist.promote',
        entityType: 'waitlist_entry',
        entityId: entry.id,
        summary: `候补提升成功（触发：${options.trigger}）`,
      });
      // 一名学生提升后，其它课程的候补条件可能变化
      recheckOtherEntries(db, entry.student_id, entry.batch_id, entry.course_id, actor);
      return 'promoted';
    }
    lastError = result.error ? { code: result.error.code, message: result.error.message } : null;
    // 名额满就停止尝试其它班
    if (result.error?.code === ERROR_CODES.NO_CAPACITY) break;
  }

  if (!lastError) return 'pending';
  const permanentCodes: string[] = [
    ERROR_CODES.DUPLICATE_COURSE,
    ERROR_CODES.NOT_ELIGIBLE,
    ERROR_CODES.CLASS_CANCELLED,
    ERROR_CODES.CLASS_CLOSED,
  ];
  if (permanentCodes.includes(lastError.code)) {
    db.prepare("UPDATE waitlist_entries SET status = 'closed', close_code = ?, close_reason = ?, updated_at = ? WHERE id = ?").run(
      lastError.code,
      lastError.message,
      nowIso(),
      entry.id,
    );
    return 'closed';
  }
  db.prepare(
    `UPDATE waitlist_entries SET status = 'suspended', suspend_code = ?, suspend_reason = ?, updated_at = ? WHERE id = ?`,
  ).run(lastError.code, lastError.message, nowIso(), entry.id);
  return 'suspended';
}

function recheckOtherEntries(db: SqliteDb, studentId: number, batchId: number, excludeCourseId: number, actor: AuthUser | undefined): void {
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
  const service = new EnrollmentService(db);
  // 找到所有在本课程排队、且当前批次处于候补阶段的记录
  const entries = db
    .prepare(
      `SELECT we.id FROM waitlist_entries we
       JOIN selection_batches sb ON sb.id = we.batch_id
       WHERE we.course_id = ? AND we.status IN ('queued', 'suspended')
         AND sb.status IN ('published', 'waitlist')
       ORDER BY we.id`,
    )
    .all(cls.course_id) as Array<{ id: number }>;
  if (entries.length === 0) return;
  // 系统触发时没有具体操作人：actor 传 undefined，操作记录里 actor_id 记为 NULL
  for (const entry of entries) {
    const outcome = tryPromote(db, service, entry.id, undefined, { trigger: 'seat_released' });
    if (outcome !== 'pending') break;
  }
}

/** 注册到正式选课服务：退课/换班释放名额后自动尝试提升候补 */
export function registerWaitlistModule(): void {
  registerWaitlistPromotion((db, classId) => promoteWaitlistForClass(db, classId));
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
} {
  const batch = getBatchDto(db, batchId);
  const config = db.prepare("SELECT value FROM app_configs WHERE key = 'public_supplement_enabled'").get() as
    | { value: string }
    | undefined;
  const enabled = config ? config.value === 'true' || config.value === '1' : true;
  const qualified = (
    db
      .prepare("SELECT COUNT(*) AS c FROM waitlist_entries WHERE batch_id = ? AND course_id = ? AND status IN ('queued', 'suspended')")
      .get(batchId, courseId) as { c: number }
  ).c;
  const protectedSeats = (
    db
      .prepare("SELECT COALESCE(SUM(reserved_seats), 0) AS c FROM teaching_classes WHERE course_id = ? AND status = 'open'")
      .get(courseId) as { c: number }
  ).c;
  if (!enabled) return { allowed: false, reason: '管理员已关闭公开补选', qualifiedWaitlist: qualified, protectedSeats };
  if (batch.status !== 'waitlist') {
    return { allowed: false, reason: '当前批次尚未进入候补与补选阶段', qualifiedWaitlist: qualified, protectedSeats };
  }
  if (qualified > 0) {
    return { allowed: false, reason: `还有 ${qualified} 条合格候补在队列中，名额必须先给候补`, qualifiedWaitlist: qualified, protectedSeats };
  }
  return { allowed: true, reason: '没有合格候补，可以公开补选', qualifiedWaitlist: 0, protectedSeats };
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
      return '缺少有效的替换授权，请重新确认';
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
    db.prepare("SELECT id FROM teaching_classes WHERE course_id = ? AND status = 'open'").all(courseId) as Array<{ id: number }>
  ).map((c) => c.id);
  const sessions = classSessions(db, classIds);
  for (const list of sessions.values()) {
    if (findConflicts(current, list).length > 0) return true;
  }
  return false;
}
