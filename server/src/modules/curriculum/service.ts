/**
 * 培养方案、学期必需课程、毕业保障名单与替换授权。
 *
 * 毕业保障的关键点：
 *   - 管理员按课程确认保护名单；
 *   - 系统要检查“一个学生的多门必要课程”是否存在联合可行安排（不能只看单门容量）；
 *   - 发布前必须对保障异常形成明确处理结果；
 *   - 整门课程的保护需求全部落实后，才能释放剩余预留。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../core/errors.js';
import { nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { checkGraduationFeasibility, computeProgress, reservedSeatsReleasable } from '../rules/service.js';
import { getSeatUsage } from '../catalog/service.js';

export function listPrograms(db: SqliteDb): unknown[] {
  return db
    .prepare(
      `SELECT p.id, p.code, p.name, p.grade, p.major, p.total_credits AS totalCredits, p.version, p.status,
              p.published_at AS publishedAt,
              (SELECT COUNT(*) FROM curriculum_requirements cr WHERE cr.program_id = p.id) AS requirementCount,
              (SELECT COUNT(*) FROM students s WHERE s.program_id = p.id) AS studentCount
       FROM programs p ORDER BY p.id`,
    )
    .all();
}

export function getProgramDetail(db: SqliteDb, programId: number): unknown {
  const program = db.prepare('SELECT * FROM programs WHERE id = ?').get(programId) as Record<string, unknown> | undefined;
  if (!program) throw notFound('培养方案不存在');
  const requirements = db
    .prepare(
      `SELECT cr.id, cr.code, cr.name, cr.category, cr.required_credits AS requiredCredits,
              cr.min_courses AS minCourses, cr.priority, cr.note,
              (SELECT COUNT(*) FROM curriculum_courses cc WHERE cc.requirement_id = cr.id) AS courseCount
       FROM curriculum_requirements cr WHERE cr.program_id = ? ORDER BY cr.priority, cr.id`,
    )
    .all(programId) as Array<Record<string, unknown> & { id: number }>;
  const courses = db
    .prepare(
      `SELECT cc.requirement_id AS requirementId, c.id AS courseId, c.code, c.name, c.credits, cc.relation, cc.priority
       FROM curriculum_courses cc JOIN courses c ON c.id = cc.course_id
       WHERE cc.requirement_id IN (SELECT id FROM curriculum_requirements WHERE program_id = ?)
       ORDER BY cc.requirement_id, cc.priority`,
    )
    .all(programId);
  return {
    program,
    requirements: requirements.map((r) => ({
      ...r,
      courses: (courses as Array<Record<string, unknown>>).filter((c) => c.requirementId === r.id),
    })),
  };
}

export interface TermRequiredInput {
  studentId: number;
  courseIds: number[];
  term: string;
  reason?: string;
}

/** 管理员确认“本学期必须完成”的课程：这是 D2 需求的正式依据之一 */
export function setTermRequired(db: SqliteDb, input: TermRequiredInput, actor: AuthUser): { added: number; term: string } {
  const now = nowIso();
  let added = 0;
  db.transaction(() => {
    for (const courseId of input.courseIds) {
      const info = db
        .prepare(
          `INSERT INTO term_required_courses (student_id, course_id, term, reason, confirmed_by, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (student_id, course_id, term) DO UPDATE SET reason = excluded.reason`,
        )
        .run(input.studentId, courseId, input.term, input.reason ?? '管理员确认本学期必须完成', actor.id, now);
      if (info.changes > 0) added += 1;
    }
  })();
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'curriculum.term_required',
    entityType: 'student',
    entityId: input.studentId,
    summary: `确认本学期必须完成课程 ${input.courseIds.length} 门（${input.term}）`,
    detail: { courseIds: input.courseIds, reason: input.reason ?? null },
  });
  return { added, term: input.term };
}

export interface GuaranteeInput {
  batchId: number;
  courseId: number;
  studentIds: number[];
  reason?: string;
}

/**
 * 管理员按课程确认毕业保障名单。
 * 确认后会给出教学班预留建议，并检查每个学生的多门必要课程是否联合可行。
 */
export function confirmGuarantee(
  db: SqliteDb,
  input: GuaranteeInput,
  actor: AuthUser,
): {
  added: number;
  studentCount: number;
  reservationSuggestion: Array<{ classId: number; classCode: string; suggested: number; capacity: number; currentReserved: number }>;
  feasibility: Array<{ studentId: number; studentNo: string; feasible: boolean; conflicts: unknown[] }>;
} {
  const batch = db.prepare('SELECT id, term, status FROM selection_batches WHERE id = ?').get(input.batchId) as
    | { id: number; term: string; status: string }
    | undefined;
  if (!batch) throw notFound('批次不存在');
  const course = db.prepare('SELECT id, name FROM courses WHERE id = ?').get(input.courseId) as { id: number; name: string } | undefined;
  if (!course) throw notFound('课程不存在');

  const now = nowIso();
  let added = 0;
  db.transaction(() => {
    for (const studentId of input.studentIds) {
      const info = db
        .prepare(
          `INSERT INTO graduation_reservations (batch_id, course_id, student_id, status, reason, confirmed_by, confirmed_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?)
           ON CONFLICT (batch_id, course_id, student_id) DO UPDATE SET status = 'active', reason = excluded.reason,
             confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at, released_at = NULL`,
        )
        .run(input.batchId, input.courseId, studentId, input.reason ?? '管理员确认毕业保障', actor.id, now);
      if (info.changes > 0) added += 1;
    }
  })();

  // 预留建议：按“保护人数”分摊到该课程的各个教学班
  const classes = db
    .prepare(
      `SELECT id, class_code, capacity, reserved_seats FROM teaching_classes
       WHERE course_id = ? AND status = 'open' ORDER BY id`,
    )
    .all(input.courseId) as Array<{ id: number; class_code: string; capacity: number; reserved_seats: number }>;
  const totalProtected = (
    db
      .prepare("SELECT COUNT(*) AS c FROM graduation_reservations WHERE batch_id = ? AND course_id = ? AND status = 'active'")
      .get(input.batchId, input.courseId) as { c: number }
  ).c;
  const perClass = classes.length > 0 ? Math.ceil(totalProtected / classes.length) : 0;
  const reservationSuggestion = classes.map((cls) => {
    const usage = getSeatUsage(db, cls.id);
    return {
      classId: cls.id,
      classCode: cls.class_code,
      suggested: Math.min(perClass, Math.max(0, cls.capacity - 1)),
      capacity: cls.capacity,
      currentReserved: usage.reservedSeats,
    };
  });

  // 联合可行性：逐个学生检查他的所有保护课程
  const feasibility = checkGuaranteeForBatch(db, input.batchId, input.studentIds);

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'guarantee.confirm',
    entityType: 'graduation_reservation',
    entityId: input.courseId,
    summary: `确认毕业保障名单：课程「${course.name}」${input.studentIds.length} 人`,
    detail: { batchId: input.batchId, added },
  });

  return { added, studentCount: totalProtected, reservationSuggestion, feasibility: feasibility.students };
}

/**
 * 检查毕业保障的联合可行性。
 * 返回每个学生的必要课程是否存在“同时安排得下”的方案；
 * 无解的学生会进入异常清单，不自动视为保障完成。
 */
export function checkGuaranteeForBatch(
  db: SqliteDb,
  batchId: number | null,
  studentIds?: number[],
): {
  students: Array<{ studentId: number; studentNo: string; feasible: boolean; conflicts: unknown[]; courseNames: string[] }>;
  releasable: Array<{ courseId: number; courseName: string; releasable: boolean; activeReservations: number; fulfilled: number }>;
} {
  const params: unknown[] = [];
  let where = "gr.status = 'active'";
  if (batchId) {
    where += ' AND gr.batch_id = ?';
    params.push(batchId);
  }
  if (studentIds && studentIds.length > 0) {
    where += ` AND gr.student_id IN (${studentIds.map(() => '?').join(',')})`;
    params.push(...studentIds);
  }
  const rows = db
    .prepare(
      `SELECT gr.student_id AS studentId, gr.course_id AS courseId, c.name AS courseName,
              s.student_no AS studentNo
       FROM graduation_reservations gr
       JOIN courses c ON c.id = gr.course_id
       JOIN students s ON s.user_id = gr.student_id
       WHERE ${where} ORDER BY gr.student_id`,
    )
    .all(...params) as Array<{ studentId: number; courseId: number; courseName: string; studentNo: string }>;

  const byStudent = new Map<number, { studentNo: string; courses: Array<{ courseId: number; courseName: string }> }>();
  for (const row of rows) {
    const entry = byStudent.get(row.studentId) ?? { studentNo: row.studentNo, courses: [] };
    entry.courses.push({ courseId: row.courseId, courseName: row.courseName });
    byStudent.set(row.studentId, entry);
  }

  const students = Array.from(byStudent.entries()).map(([studentId, entry]) => {
    const options = entry.courses.map((course) => {
      const classes = db
        .prepare("SELECT id FROM teaching_classes WHERE course_id = ? AND status = 'open' ORDER BY id")
        .all(course.courseId) as Array<{ id: number }>;
      return { courseId: course.courseId, courseName: course.courseName, classIds: classes.map((c) => c.id) };
    });
    const feasible = checkGraduationFeasibility(db, { courseOptions: options });
    if (!feasible.feasible) {
      // 记录异常，等待管理员给出明确处理结果
      const existing = db
        .prepare(
          `SELECT id FROM exceptions WHERE student_id = ? AND kind = 'guarantee_no_solution' AND status = 'open'
             ${batchId ? 'AND batch_id = ?' : ''}`,
        )
        .get(...(batchId ? [studentId, batchId] : [studentId])) as { id: number } | undefined;
      if (!existing) {
        db.prepare(
          `INSERT INTO exceptions (batch_id, student_id, course_id, kind, severity, status, detail, created_at)
           VALUES (?, ?, NULL, 'guarantee_no_solution', 'critical', 'open', ?, ?)`,
        ).run(
          batchId,
          studentId,
          JSON.stringify({ courseNames: entry.courses.map((c) => c.courseName), conflicts: feasible.conflicts }),
          nowIso(),
        );
      }
    }
    return {
      studentId,
      studentNo: entry.studentNo,
      feasible: feasible.feasible,
      conflicts: feasible.conflicts,
      courseNames: entry.courses.map((c) => c.courseName),
    };
  });

  const releasable: Array<{ courseId: number; courseName: string; releasable: boolean; activeReservations: number; fulfilled: number }> = [];
  if (batchId) {
    const courses = db
      .prepare(
        `SELECT DISTINCT gr.course_id AS courseId, c.name AS courseName
         FROM graduation_reservations gr JOIN courses c ON c.id = gr.course_id WHERE gr.batch_id = ?`,
      )
      .all(batchId) as Array<{ courseId: number; courseName: string }>;
    for (const course of courses) {
      const state = reservedSeatsReleasable(db, batchId, course.courseId);
      releasable.push({
        courseId: course.courseId,
        courseName: course.courseName,
        releasable: state.releasable,
        activeReservations: state.activeReservations,
        fulfilled: state.fulfilled,
      });
    }
  }

  return { students, releasable };
}

export interface AuthorizationInput {
  studentId: number;
  batchId: number;
  sourceClassId: number;
  targetCourseId: number;
  targetClassId?: number | null;
  expiresAt?: string | null;
}

/**
 * 授予“自动升级”授权：必须明确目标课程、目标教学班范围（可为空）
 * 和被替换的原课程。授权带版本，关键资料变化后自动失效。
 */
export function grantUpgradeAuthorization(
  db: SqliteDb,
  input: AuthorizationInput,
  actor: AuthUser,
): { id: number; status: string; expiresAt: string | null; versionId: number | null } {
  const source = db
    .prepare('SELECT id, course_id, class_code FROM teaching_classes WHERE id = ?')
    .get(input.sourceClassId) as { id: number; course_id: number; class_code: string } | undefined;
  if (!source) throw notFound('原教学班不存在');
  const targetCourse = db.prepare('SELECT id, name FROM courses WHERE id = ?').get(input.targetCourseId) as
    | { id: number; name: string }
    | undefined;
  if (!targetCourse) throw notFound('目标课程不存在');
  if (source.course_id === input.targetCourseId) {
    throw conflict('目标课程不能与原课程相同；同课调班请使用“同课换班”');
  }
  // 学生必须确实已选原课程，否则授权没有意义
  const enrolled = (
    db
      .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'enrolled'")
      .get(input.studentId, input.sourceClassId) as { c: number }
  ).c;
  if (enrolled === 0) {
    throw conflict('该学生当前没有修读原教学班，无法建立替换授权');
  }
  const recordsVersion = db
    .prepare("SELECT id FROM data_versions WHERE scope = 'records' AND active = 1 ORDER BY version_no DESC LIMIT 1")
    .get() as { id: number } | undefined;
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO upgrade_authorizations
       (student_id, batch_id, source_course_id, source_class_id, target_course_id, target_class_id, status,
        version_id, granted_by, granted_at, expires_at, note)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
       ON CONFLICT (student_id, batch_id, target_course_id, source_course_id) DO UPDATE SET
         source_class_id = excluded.source_class_id, target_class_id = excluded.target_class_id, status = 'active',
         version_id = excluded.version_id, granted_by = excluded.granted_by, granted_at = excluded.granted_at,
         expires_at = excluded.expires_at, invalidated_at = NULL, used_at = NULL`,
    )
    .run(
      input.studentId,
      input.batchId,
      source.course_id,
      input.sourceClassId,
      input.targetCourseId,
      input.targetClassId ?? null,
      recordsVersion?.id ?? null,
      actor.id,
      now,
      input.expiresAt ?? null,
      '管理员授予自动替换授权',
    );
  const id =
    Number(info.lastInsertRowid) ||
    ((db
      .prepare(
        'SELECT id FROM upgrade_authorizations WHERE student_id = ? AND batch_id = ? AND target_course_id = ? AND source_course_id = ?',
      )
      .get(input.studentId, input.batchId, input.targetCourseId, source.course_id) as { id: number }).id ?? 0);

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'authorization.grant',
    entityType: 'upgrade_authorization',
    entityId: id,
    summary: `授予自动替换授权：用「${targetCourse.name}」替换原教学班 ${source.class_code}`,
    detail: { studentId: input.studentId, expiresAt: input.expiresAt ?? null },
  });

  return { id, status: 'active', expiresAt: input.expiresAt ?? null, versionId: recordsVersion?.id ?? null };
}

export function studentProgressSummary(db: SqliteDb, studentId: number): unknown {
  const progress = computeProgress(db, studentId);
  const student = db
    .prepare('SELECT s.student_no AS studentNo, s.name, p.name AS programName FROM students s LEFT JOIN programs p ON p.id = s.program_id WHERE s.user_id = ?')
    .get(studentId);
  if (!student) throw new AppError(ERROR_CODES.NOT_FOUND, '学生不存在', 404);
  return { student, progress };
}
