/** 课程与教学班：检索、容量、时段。 */
import type { SqliteDb } from '../../db/index.js';
import { notFound, conflict } from '../../core/errors.js';
import { nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { describeSession } from '../../core/time.js';

export interface SessionDto {
  id: number;
  dayOfWeek: number;
  periodStart: number;
  periodEnd: number;
  weekStart: number;
  weekEnd: number;
  weekParity: 'all' | 'odd' | 'even';
  room: string | null;
  text: string;
}

export interface SeatUsage {
  courseId: number;
  classId: number;
  capacity: number;
  reservedSeats: number;
  enrolled: number;
  usedReserved: number;
  /** 普通申请当前可用名额（预留名额在首轮不参与普通竞争） */
  generalAvailable: number;
  /** 含未被占用的预留名额 */
  totalAvailable: number;
}

export interface TeacherRow {
  id: number;
  name: string;
  department: string | null;
  title: string | null;
}

export interface ClassDto extends SeatUsage {
  id: number;
  classCode: string;
  term: string;
  courseId: number;
  courseCode: string;
  courseName: string;
  credits: number;
  courseType: string;
  department: string | null;
  teacher: TeacherRow | null;
  status: 'open' | 'closed' | 'cancelled';
  campus: string | null;
  note: string | null;
  sessions: SessionDto[];
}

export function getSeatUsage(db: SqliteDb, classId: number): SeatUsage {
  const cls = db
    .prepare('SELECT id, course_id, capacity, reserved_seats FROM teaching_classes WHERE id = ?')
    .get(classId) as { id: number; course_id: number; capacity: number; reserved_seats: number } | undefined;
  if (!cls) throw notFound('教学班不存在');
  const stat = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'enrolled' THEN 1 ELSE 0 END) AS enrolled,
         SUM(CASE WHEN status = 'enrolled' AND uses_reserved = 1 THEN 1 ELSE 0 END) AS usedReserved
       FROM enrollments WHERE class_id = ?`,
    )
    .get(classId) as { enrolled: number | null; usedReserved: number | null };
  const enrolled = stat.enrolled ?? 0;
  const usedReserved = stat.usedReserved ?? 0;
  const generalSeats = cls.capacity - cls.reserved_seats;
  const generalUsed = enrolled - usedReserved;
  return {
    courseId: cls.course_id,
    classId: cls.id,
    capacity: cls.capacity,
    reservedSeats: cls.reserved_seats,
    enrolled,
    usedReserved,
    generalAvailable: Math.max(0, generalSeats - generalUsed),
    totalAvailable: Math.max(0, cls.capacity - enrolled),
  };
}

function loadSessions(db: SqliteDb, classIds: number[]): Map<number, SessionDto[]> {
  const map = new Map<number, SessionDto[]>();
  if (classIds.length === 0) return map;
  const placeholders = classIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity, room
       FROM class_sessions WHERE class_id IN (${placeholders}) ORDER BY day_of_week, period_start`,
    )
    .all(...classIds) as Array<{
    id: number;
    class_id: number;
    day_of_week: number;
    period_start: number;
    period_end: number;
    week_start: number;
    week_end: number;
    week_parity: 'all' | 'odd' | 'even';
    room: string | null;
  }>;
  for (const row of rows) {
    const list = map.get(row.class_id) ?? [];
    list.push({
      id: row.id,
      dayOfWeek: row.day_of_week,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      weekStart: row.week_start,
      weekEnd: row.week_end,
      weekParity: row.week_parity,
      room: row.room,
      text: describeSession({
        day_of_week: row.day_of_week,
        period_start: row.period_start,
        period_end: row.period_end,
        week_start: row.week_start,
        week_end: row.week_end,
        week_parity: row.week_parity,
      }),
    });
    map.set(row.class_id, list);
  }
  return map;
}

const CLASS_BASE_SQL = `
  SELECT tc.id, tc.class_code, tc.term, tc.course_id, tc.capacity, tc.reserved_seats, tc.status, tc.campus, tc.note,
         c.code AS course_code, c.name AS course_name, c.credits, c.course_type, c.department,
         t.id AS teacher_id, t.name AS teacher_name, t.department AS teacher_department, t.title AS teacher_title
  FROM teaching_classes tc
  JOIN courses c ON c.id = tc.course_id
  LEFT JOIN teachers t ON t.id = tc.teacher_id
`;

interface ClassRawRow {
  id: number;
  class_code: string;
  term: string;
  course_id: number;
  capacity: number;
  reserved_seats: number;
  status: 'open' | 'closed' | 'cancelled';
  campus: string | null;
  note: string | null;
  course_code: string;
  course_name: string;
  credits: number;
  course_type: string;
  department: string | null;
  teacher_id: number | null;
  teacher_name: string | null;
  teacher_department: string | null;
  teacher_title: string | null;
}

function toClassDto(db: SqliteDb, row: ClassRawRow, sessions: Map<number, SessionDto[]>): ClassDto {
  const usage = getSeatUsage(db, row.id);
  return {
    id: row.id,
    classCode: row.class_code,
    term: row.term,
    courseCode: row.course_code,
    courseName: row.course_name,
    credits: row.credits,
    courseType: row.course_type,
    department: row.department,
    teacher: row.teacher_id
      ? { id: row.teacher_id, name: row.teacher_name ?? '', department: row.teacher_department, title: row.teacher_title }
      : null,
    status: row.status,
    campus: row.campus,
    note: row.note,
    sessions: sessions.get(row.id) ?? [],
    ...usage,
  };
}

export function getClassDto(db: SqliteDb, classId: number): ClassDto {
  const row = db.prepare(`${CLASS_BASE_SQL} WHERE tc.id = ?`).get(classId) as ClassRawRow | undefined;
  if (!row) throw notFound('教学班不存在');
  return toClassDto(db, row, loadSessions(db, [classId]));
}

export interface ListClassesFilter {
  term?: string;
  courseId?: number;
  courseIds?: number[];
  keyword?: string;
  department?: string;
  courseType?: string;
  onlyAvailable?: boolean;
  limit: number;
  offset: number;
}

export function listClasses(db: SqliteDb, filter: ListClassesFilter): { items: ClassDto[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.term) {
    conditions.push('tc.term = ?');
    params.push(filter.term);
  }
  if (filter.courseId) {
    conditions.push('tc.course_id = ?');
    params.push(filter.courseId);
  }
  if (filter.courseIds && filter.courseIds.length > 0) {
    conditions.push(`tc.course_id IN (${filter.courseIds.map(() => '?').join(',')})`);
    params.push(...filter.courseIds);
  }
  if (filter.keyword) {
    conditions.push('(c.name LIKE ? OR c.code LIKE ? OR tc.class_code LIKE ?)');
    params.push(`%${filter.keyword}%`, `%${filter.keyword}%`, `%${filter.keyword}%`);
  }
  if (filter.department) {
    conditions.push('c.department = ?');
    params.push(filter.department);
  }
  if (filter.courseType) {
    conditions.push('c.course_type = ?');
    params.push(filter.courseType);
  }
  if (filter.onlyAvailable) {
    conditions.push("tc.status = 'open'");
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM teaching_classes tc JOIN courses c ON c.id = tc.course_id ${where}`,
      )
      .get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(`${CLASS_BASE_SQL} ${where} ORDER BY c.code, tc.class_code LIMIT ? OFFSET ?`)
    .all(...params, filter.limit, filter.offset) as ClassRawRow[];
  const sessions = loadSessions(
    db,
    rows.map((r) => r.id),
  );
  const items = rows.map((row) => toClassDto(db, row, sessions));
  return { items, total };
}

export interface CourseDto {
  id: number;
  code: string;
  name: string;
  credits: number;
  department: string | null;
  courseType: string;
  description: string | null;
  classCount: number;
  totalCapacity: number;
  totalAvailable: number;
}

export function listCourses(
  db: SqliteDb,
  filter: { keyword?: string; department?: string; courseType?: string; term?: string; limit: number; offset: number },
): { items: CourseDto[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.keyword) {
    conditions.push('(c.name LIKE ? OR c.code LIKE ?)');
    params.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
  }
  if (filter.department) {
    conditions.push('c.department = ?');
    params.push(filter.department);
  }
  if (filter.courseType) {
    conditions.push('c.course_type = ?');
    params.push(filter.courseType);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM courses c ${where}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT c.id, c.code, c.name, c.credits, c.department, c.course_type, c.description,
              (SELECT COUNT(*) FROM teaching_classes tc WHERE tc.course_id = c.id) AS class_count,
              (SELECT COALESCE(SUM(tc.capacity), 0) FROM teaching_classes tc WHERE tc.course_id = c.id) AS total_capacity,
              (SELECT COUNT(*) FROM enrollments e JOIN teaching_classes tc2 ON tc2.id = e.class_id
                 WHERE tc2.course_id = c.id AND e.status = 'enrolled') AS total_enrolled
       FROM courses c ${where} ORDER BY c.code LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as Array<{
    id: number;
    code: string;
    name: string;
    credits: number;
    department: string | null;
    course_type: string;
    description: string | null;
    class_count: number;
    total_capacity: number;
    total_enrolled: number;
  }>;
  const items = rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    credits: row.credits,
    department: row.department,
    courseType: row.course_type,
    description: row.description,
    classCount: row.class_count,
    totalCapacity: row.total_capacity,
    totalAvailable: Math.max(0, row.total_capacity - row.total_enrolled),
  }));
  return { items, total };
}

export function getCourseDetail(db: SqliteDb, courseId: number): CourseDto & { classes: ClassDto[] } {
  const row = db
    .prepare('SELECT id, code, name, credits, department, course_type, description FROM courses WHERE id = ?')
    .get(courseId) as
    | { id: number; code: string; name: string; credits: number; department: string | null; course_type: string; description: string | null }
    | undefined;
  if (!row) throw notFound('课程不存在');
  const { items: classes } = listClasses(db, { courseId, limit: 200, offset: 0 });
  const totalCapacity = classes.reduce((sum, c) => sum + c.capacity, 0);
  const totalAvailable = classes.reduce((sum, c) => sum + c.totalAvailable, 0);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    credits: row.credits,
    department: row.department,
    courseType: row.course_type,
    description: row.description,
    classCount: classes.length,
    totalCapacity,
    totalAvailable,
    classes,
  };
}

export interface SessionInput {
  dayOfWeek: number;
  periodStart: number;
  periodEnd: number;
  weekStart: number;
  weekEnd: number;
  weekParity?: 'all' | 'odd' | 'even';
  room?: string | null;
}

export interface ClassInput {
  courseId: number;
  classCode: string;
  term: string;
  teacherId?: number | null;
  capacity: number;
  reservedSeats?: number;
  status?: 'open' | 'closed' | 'cancelled';
  campus?: string | null;
  note?: string | null;
  sessions?: SessionInput[];
}

export function upsertClass(db: SqliteDb, input: ClassInput, actor: AuthUser, classId?: number): ClassDto {
  const now = nowIso();
  const course = db.prepare('SELECT id, credits FROM courses WHERE id = ?').get(input.courseId) as { id: number; credits: number } | undefined;
  if (!course) throw notFound('课程不存在');
  if (input.reservedSeats && input.reservedSeats > input.capacity) {
    throw conflict('预留名额不能超过总容量');
  }
  const reserved = input.reservedSeats ?? 0;

  const id = db.transaction(() => {
    let targetId = classId;
    if (targetId) {
      const exists = db.prepare('SELECT id FROM teaching_classes WHERE id = ?').get(targetId);
      if (!exists) throw notFound('教学班不存在');
      db.prepare(
        `UPDATE teaching_classes SET course_id = ?, class_code = ?, term = ?, teacher_id = ?, capacity = ?,
           reserved_seats = ?, status = ?, campus = ?, note = ? WHERE id = ?`,
      ).run(
        input.courseId,
        input.classCode,
        input.term,
        input.teacherId ?? null,
        input.capacity,
        reserved,
        input.status ?? 'open',
        input.campus ?? null,
        input.note ?? null,
        targetId,
      );
    } else {
      const info = db
        .prepare(
          `INSERT INTO teaching_classes (course_id, class_code, term, teacher_id, capacity, reserved_seats, status, campus, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.courseId,
          input.classCode,
          input.term,
          input.teacherId ?? null,
          input.capacity,
          reserved,
          input.status ?? 'open',
          input.campus ?? null,
          input.note ?? null,
          now,
        );
      targetId = Number(info.lastInsertRowid);
    }
    if (input.sessions) {
      db.prepare('DELETE FROM class_sessions WHERE class_id = ?').run(targetId);
      const insert = db.prepare(
        `INSERT INTO class_sessions (class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity, room)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of input.sessions) {
        insert.run(
          targetId,
          s.dayOfWeek,
          s.periodStart,
          s.periodEnd,
          s.weekStart,
          s.weekEnd,
          s.weekParity ?? 'all',
          s.room ?? null,
        );
      }
    }
    return targetId;
  })();

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: classId ? 'class.update' : 'class.create',
    entityType: 'teaching_class',
    entityId: id,
    summary: `${classId ? '修改' : '新建'}教学班 ${input.classCode}`,
  });
  return getClassDto(db, id);
}

export function setClassStatus(
  db: SqliteDb,
  classId: number,
  status: 'open' | 'closed' | 'cancelled',
  actor: AuthUser,
  reason?: string,
): void {
  const exists = db.prepare('SELECT id, class_code FROM teaching_classes WHERE id = ?').get(classId) as
    | { id: number; class_code: string }
    | undefined;
  if (!exists) throw notFound('教学班不存在');
  db.prepare('UPDATE teaching_classes SET status = ? WHERE id = ?').run(status, classId);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: `class.${status}`,
    entityType: 'teaching_class',
    entityId: classId,
    summary: `教学班 ${exists.class_code} 状态改为 ${status}`,
    detail: reason ? { reason } : undefined,
  });
}

export function listTerms(db: SqliteDb): string[] {
  const rows = db.prepare('SELECT DISTINCT term FROM teaching_classes ORDER BY term DESC').all() as Array<{ term: string }>;
  return rows.map((r) => r.term);
}

export function listDepartments(db: SqliteDb): string[] {
  const rows = db
    .prepare("SELECT DISTINCT department FROM courses WHERE department IS NOT NULL ORDER BY department")
    .all() as Array<{ department: string }>;
  return rows.map((r) => r.department);
}
