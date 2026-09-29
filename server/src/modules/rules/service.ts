/**
 * 统一规则层：时间冲突、资格、重复课程、学分上限、培养需求等级、替代组、毕业保障可行性。
 *
 * 为什么单独成层：
 * “志愿规划（Agent）”和“正式选课”都必须用同一套判断，
 * 否则会出现“Agent 说能选、真正选课时又失败”的矛盾。
 * 本层只做纯计算，不写数据库（除了查询读取），不修改名额。
 */
import type { SqliteDb } from '../../db/index.js';
import { describeSession, describeWeeks, findConflicts, type SessionLike } from '../../core/time.js';

export type DemandLevel = 'D2' | 'D1' | 'D0';

export interface ClassSchedule {
  classId: number;
  courseId: number;
  classCode: string;
  courseCode: string;
  courseName: string;
  credits: number;
  sessions: Array<SessionLike & { id: number; room: string | null }>;
}

/** 已落实的课表片段（来自 enrollments） */
export function loadStudentSchedule(
  db: SqliteDb,
  studentId: number,
  options: { excludeClassIds?: number[] } = {},
): ClassSchedule[] {
  const exclude = options.excludeClassIds ?? [];
  const rows = db
    .prepare(
      `SELECT tc.id AS class_id, tc.course_id, tc.class_code, c.code AS course_code, c.name AS course_name, c.credits
       FROM enrollments e
       JOIN teaching_classes tc ON tc.id = e.class_id
       JOIN courses c ON c.id = e.course_id
       WHERE e.student_id = ? AND e.status = 'enrolled'
       ORDER BY c.code`,
    )
    .all(studentId) as Array<{
    class_id: number;
    course_id: number;
    class_code: string;
    course_code: string;
    course_name: string;
    credits: number;
  }>;
  const filtered = rows.filter((r) => !exclude.includes(r.class_id));
  return hydrateSessions(
    db,
    filtered.map((r) => ({
      classId: r.class_id,
      courseId: r.course_id,
      classCode: r.class_code,
      courseCode: r.course_code,
      courseName: r.course_name,
      credits: r.credits,
      sessions: [],
    })),
  );
}

export function loadClassSchedule(db: SqliteDb, classIds: number[]): ClassSchedule[] {
  if (classIds.length === 0) return [];
  const placeholders = classIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT tc.id AS class_id, tc.course_id, tc.class_code, c.code AS course_code, c.name AS course_name, c.credits
       FROM teaching_classes tc JOIN courses c ON c.id = tc.course_id
       WHERE tc.id IN (${placeholders})`,
    )
    .all(...classIds) as Array<{
    class_id: number;
    course_id: number;
    class_code: string;
    course_code: string;
    course_name: string;
    credits: number;
  }>;
  return hydrateSessions(
    db,
    rows.map((r) => ({
      classId: r.class_id,
      courseId: r.course_id,
      classCode: r.class_code,
      courseCode: r.course_code,
      courseName: r.course_name,
      credits: r.credits,
      sessions: [],
    })),
  );
}

function hydrateSessions(db: SqliteDb, items: ClassSchedule[]): ClassSchedule[] {
  if (items.length === 0) return items;
  const placeholders = items.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity, room
       FROM class_sessions WHERE class_id IN (${placeholders})`,
    )
    .all(...items.map((i) => i.classId)) as Array<{
    id: number;
    class_id: number;
    day_of_week: number;
    period_start: number;
    period_end: number;
    week_start: number;
    week_end: number;
    week_parity: string;
    room: string | null;
  }>;
  const byClass = new Map<number, ClassSchedule['sessions']>();
  for (const row of rows) {
    const list = byClass.get(row.class_id) ?? [];
    list.push({
      id: row.id,
      day_of_week: row.day_of_week,
      period_start: row.period_start,
      period_end: row.period_end,
      week_start: row.week_start,
      week_end: row.week_end,
      week_parity: row.week_parity,
      room: row.room,
    });
    byClass.set(row.class_id, list);
  }
  for (const item of items) {
    item.sessions = byClass.get(item.classId) ?? [];
  }
  return items;
}

export interface ScheduleConflict {
  leftClassId: number;
  leftCourseName: string;
  rightClassId: number;
  rightCourseName: string;
  leftText: string;
  rightText: string;
  weeks: number[];
}

/** 计算一组课表内部的全部冲突（两两比较） */
export function findScheduleConflicts(schedule: ClassSchedule[]): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  for (let i = 0; i < schedule.length; i += 1) {
    for (let j = i + 1; j < schedule.length; j += 1) {
      const left = schedule[i];
      const right = schedule[j];
      for (const pair of findConflicts(left.sessions, right.sessions)) {
        conflicts.push({
          leftClassId: left.classId,
          leftCourseName: left.courseName,
          rightClassId: right.classId,
          rightCourseName: right.courseName,
          leftText: describeSession(pair.left),
          rightText: describeSession(pair.right),
          weeks: pair.weeks,
        });
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// 占用索引：让分配算法在 100 学生 / 50 教学班规模下也能快速判断冲突
// ---------------------------------------------------------------------------

/**
 * 把一节课展开成“星期|节次|周次”的键集合。
 * 两个教学班的占用键有交集 ⇔ 时间冲突，因此可以直接用集合判断。
 */
export function occupancyKeys(sessions: SessionLike[]): Set<string> {
  const keys = new Set<string>();
  for (const session of sessions) {
    for (const week of expandWeeks2(session)) {
      for (let period = session.period_start; period <= session.period_end; period += 1) {
        keys.add(`${session.day_of_week}|${period}|${week}`);
      }
    }
  }
  return keys;
}

function expandWeeks2(session: SessionLike): number[] {
  const start = Math.max(1, Math.min(session.week_start, session.week_end));
  const end = Math.min(30, Math.max(session.week_start, session.week_end));
  const weeks: number[] = [];
  for (let w = start; w <= end; w += 1) {
    if (session.week_parity === 'odd' && w % 2 === 0) continue;
    if (session.week_parity === 'even' && w % 2 === 1) continue;
    weeks.push(w);
  }
  return weeks;
}

export function keysIntersect(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const key of small) {
    if (large.has(key)) return true;
  }
  return false;
}

export interface ScheduleEvaluation {
  schedule: ClassSchedule[];
  credits: number;
  creditLimit: number;
  conflicts: ScheduleConflict[];
  duplicateCourseIds: number[];
  ok: boolean;
  messages: string[];
}

/**
 * 检查“替换后的完整课表”是否成立。
 * addClassIds 是本次要落实的教学班，removeClassIds 是本次要释放的教学班；
 * 只检查替换后的结果，避免“先退原课再抢目标课”的中间态被误判为可行。
 */
export function evaluateSchedule(
  db: SqliteDb,
  studentId: number,
  addClassIds: number[],
  options: { removeClassIds?: number[]; creditLimit?: number } = {},
): ScheduleEvaluation {
  const removeClassIds = options.removeClassIds ?? [];
  const kept = loadStudentSchedule(db, studentId, { excludeClassIds: removeClassIds });
  const added = loadClassSchedule(db, addClassIds);
  const schedule = [...kept, ...added];

  const courseCount = new Map<number, number>();
  for (const item of schedule) {
    courseCount.set(item.courseId, (courseCount.get(item.courseId) ?? 0) + 1);
  }
  const duplicateCourseIds = Array.from(courseCount.entries())
    .filter(([, count]) => count > 1)
    .map(([courseId]) => courseId);

  const conflicts = findScheduleConflicts(schedule);
  const credits = schedule.reduce((sum, item) => sum + item.credits, 0);
  const creditLimit = options.creditLimit ?? getCreditLimit(db, studentId);
  const messages: string[] = [];

  if (duplicateCourseIds.length > 0) {
    const names = duplicateCourseIds
      .map((id) => schedule.find((s) => s.courseId === id)?.courseName ?? String(id))
      .join('、');
    messages.push(`同一门课程被重复安排：${names}`);
  }
  for (const conflict of conflicts) {
    messages.push(
      `${conflict.leftCourseName}（${conflict.leftText}）与 ${conflict.rightCourseName}（${conflict.rightText}）在${describeWeeks(conflict.weeks)}冲突`,
    );
  }
  if (credits > creditLimit) {
    messages.push(`替换后总学分 ${credits} 超过上限 ${creditLimit}`);
  }

  return {
    schedule,
    credits,
    creditLimit,
    conflicts,
    duplicateCourseIds,
    ok: messages.length === 0,
    messages,
  };
}

// ---------------------------------------------------------------------------
// 学分上限与培养需求
// ---------------------------------------------------------------------------

export function getCreditLimit(db: SqliteDb, _studentId: number): number {
  const row = db.prepare("SELECT value FROM app_configs WHERE key = 'credit_limit_default'").get() as { value: string } | undefined;
  const parsed = row ? Number.parseFloat(row.value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export interface RequirementProgress {
  requirementId: number;
  code: string;
  name: string;
  category: string | null;
  requiredCredits: number;
  minCourses: number;
  priority: number;
  passedCredits: number;
  passedCourses: number;
  inProgressCredits: number;
  selectedCredits: number;
  /** 已通过或正在修读（含本学期已选）已达到的总量 */
  countedCredits: number;
  /** 已通过 + 本学期已选达到的课程门数 */
  countedCourses: number;
  /** 还缺多少学分（>=0） */
  remainingCredits: number;
  remainingCourses: number;
  /** 该类别下尚未完成、且本学期开设的课程 */
  candidateCourseIds: number[];
  satisfied: boolean;
}

export interface ProgressSnapshot {
  programId: number | null;
  requirements: RequirementProgress[];
  passedCredits: number;
  selectedCredits: number;
  /** 每门培养方案课程唯一归属的需求类别（courseId → requirementId） */
  courseRequirement: Record<number, number>;
  /** 冻结时已经“有安排”的课程：已通过、正在修读、本学期已选 */
  arrangedCourseIds: number[];
}

/**
 * 计算培养需求完成情况。
 * 口径说明（对应验收要求）：
 *   - 已获得学分（passed）与正在修读（in_progress）都算“已有安排”；
 *   - 本学期已选（selected，来自 enrollments 或分配结果）也算安排，但“已选不等于已通过”；
 *   - 一门课只在一个需求类别里计分：按培养方案里 relation 的优先级取第一个匹配的类别，
 *     避免同一门课在多个类别重复加分（Agent 不能自行重复计分）。
 */
export function computeProgress(
  db: SqliteDb,
  studentId: number,
  options: { plannedCourseIds?: number[]; term?: string } = {},
): ProgressSnapshot {
  const programRow = db.prepare('SELECT program_id FROM students WHERE user_id = ?').get(studentId) as
    | { program_id: number | null }
    | undefined;
  const programId = programRow?.program_id ?? null;
  if (!programId) {
    return { programId: null, requirements: [], passedCredits: 0, selectedCredits: 0, courseRequirement: {}, arrangedCourseIds: [] };
  }

  const records = db
    .prepare(
      `SELECT course_id, status, credits FROM student_course_records
       WHERE student_id = ? AND status IN ('passed', 'in_progress')`,
    )
    .all(studentId) as Array<{ course_id: number; status: string; credits: number }>;

  const enrolled = db
    .prepare(
      `SELECT e.course_id, c.credits FROM enrollments e JOIN courses c ON c.id = e.course_id
       WHERE e.student_id = ? AND e.status = 'enrolled'`,
    )
    .all(studentId) as Array<{ course_id: number; credits: number }>;

  const planned = options.plannedCourseIds ?? [];
  const plannedCredits = new Map<number, number>();
  if (planned.length > 0) {
    const placeholders = planned.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, credits FROM courses WHERE id IN (${placeholders})`)
      .all(...planned) as Array<{ id: number; credits: number }>;
    for (const row of rows) plannedCredits.set(row.id, row.credits);
  }

  // 每门课只取一个最相关的需求类别：relation 优先级 direct(1) < substitute(2)，
  // 其次是需求 priority 小的优先。
  const mappings = db
    .prepare(
      `SELECT cc.course_id, cc.relation, cr.id AS requirement_id, cr.priority
       FROM curriculum_courses cc
       JOIN curriculum_requirements cr ON cr.id = cc.requirement_id
       WHERE cr.program_id = ?`,
    )
    .all(programId) as Array<{ course_id: number; relation: string; requirement_id: number; priority: number }>;

  const coursePrimaryRequirement = new Map<number, number>();
  const ranked = [...mappings].sort((a, b) => {
    const relA = a.relation === 'direct' ? 1 : 2;
    const relB = b.relation === 'direct' ? 1 : 2;
    if (relA !== relB) return relA - relB;
    return a.priority - b.priority;
  });
  for (const m of ranked) {
    if (!coursePrimaryRequirement.has(m.course_id)) {
      coursePrimaryRequirement.set(m.course_id, m.requirement_id);
    }
  }

  const requirementRows = db
    .prepare(
      `SELECT id, code, name, category, required_credits, min_courses, priority
       FROM curriculum_requirements WHERE program_id = ? ORDER BY priority, id`,
    )
    .all(programId) as Array<{
    id: number;
    code: string;
    name: string;
    category: string | null;
    required_credits: number;
    min_courses: number;
    priority: number;
  }>;

  const requirements: RequirementProgress[] = requirementRows.map((row) => {
    const candidateRows = db
      .prepare(
        `SELECT cc.course_id, c.credits FROM curriculum_courses cc
         JOIN courses c ON c.id = cc.course_id WHERE cc.requirement_id = ?`,
      )
      .all(row.id) as Array<{ course_id: number; credits: number }>;
    const candidateCourseIds = candidateRows.map((c) => c.course_id);

    const creditOf = (courseId: number) =>
      candidateRows.find((c) => c.course_id === courseId)?.credits ??
      (db.prepare('SELECT credits FROM courses WHERE id = ?').get(courseId) as { credits: number } | undefined)?.credits ??
      0;

    let passedCredits = 0;
    let passedCourses = 0;
    let inProgressCredits = 0;
    for (const record of records) {
      if (coursePrimaryRequirement.get(record.course_id) !== row.id) continue;
      if (record.status === 'passed') {
        passedCredits += record.credits || creditOf(record.course_id);
        passedCourses += 1;
      } else {
        inProgressCredits += record.credits || creditOf(record.course_id);
      }
    }

    let selectedCredits = 0;
    const selectedCourseIds = new Set<number>();
    for (const item of enrolled) {
      if (coursePrimaryRequirement.get(item.course_id) !== row.id) continue;
      selectedCredits += item.credits || creditOf(item.course_id);
      selectedCourseIds.add(item.course_id);
    }
    for (const [courseId, credits] of plannedCredits) {
      if (coursePrimaryRequirement.get(courseId) !== row.id) continue;
      if (selectedCourseIds.has(courseId)) continue;
      selectedCredits += credits;
      selectedCourseIds.add(courseId);
    }

    const countedCredits = passedCredits + inProgressCredits + selectedCredits;
    const countedCourses = passedCourses + selectedCourseIds.size;
    const remainingCredits = Math.max(0, row.required_credits - countedCredits);
    const remainingCourses = Math.max(0, row.min_courses - countedCourses);

    return {
      requirementId: row.id,
      code: row.code,
      name: row.name,
      category: row.category,
      requiredCredits: row.required_credits,
      minCourses: row.min_courses,
      priority: row.priority,
      passedCredits,
      passedCourses,
      inProgressCredits,
      selectedCredits,
      countedCredits,
      countedCourses,
      remainingCredits,
      remainingCourses,
      candidateCourseIds,
      satisfied: remainingCredits <= 0 && remainingCourses <= 0,
    };
  });

  const passedCredits = records.filter((r) => r.status === 'passed').reduce((sum, r) => sum + r.credits, 0);
  const selectedCredits = enrolled.reduce((sum, r) => sum + r.credits, 0);
  // “已有安排”只包含已通过、正在修读、本学期已选这三类真实记录。
  // 志愿申请（plannedCourseIds）只用于规划预览，不能抵扣正式竞争中的培养缺口。
  const arrangedCourseIds = Array.from(
    new Set<number>([...records.map((r) => r.course_id), ...enrolled.map((r) => r.course_id)]),
  );
  const courseRequirement: Record<number, number> = {};
  for (const [courseId, requirementId] of coursePrimaryRequirement) {
    courseRequirement[courseId] = requirementId;
  }
  return { programId, requirements, passedCredits, selectedCredits, courseRequirement, arrangedCourseIds };
}

export interface DemandAssessment {
  courseId: number;
  demandLevel: DemandLevel;
  reasons: string[];
  requirementId: number | null;
  requirementName: string | null;
  /** 这门课是否属于毕业必要（必修/限选且仍有缺口） */
  graduationNecessary: boolean;
}

/** 冻结快照里的培养需求基线：只包含“已有安排”，不含任何未落实的志愿 */
export interface RequirementBaseline {
  requirementId: number;
  code: string;
  name: string;
  category: string | null;
  priority: number;
  requiredCredits: number;
  minCourses: number;
  countedCredits: number;
  countedCourses: number;
  candidateCourseIds: number[];
}

/**
 * 培养需求计算上下文。
 * 它把“冻结时点”的全部需求信息固定下来，使分配过程可以在内存里反复重算剩余需求，
 * 而不必（也不允许）回头读取实时变化的课程、课表或授权。
 */
export interface DemandContext {
  requirements: RequirementBaseline[];
  /** 培养方案课程 → 唯一需求类别 */
  courseRequirement: Record<string, number>;
  /** 课程 → 学分 */
  courseCredits: Record<string, number>;
  /** 冻结时已经算入 countedCredits 的课程，动态更新时据此避免重复计分 */
  baseArrangedCourseIds: number[];
  /** 管理员确认“本学期必须完成”的课程 */
  forcedRequiredCourseIds: number[];
}

export function buildDemandContext(
  db: SqliteDb,
  studentId: number,
  options: { plannedCourseIds?: number[]; term?: string } = {},
): DemandContext {
  // 注意：plannedCourseIds 只用于规划预览（例如学生端的培养进度提示）。
  // 统一分配冻结时绝不传入志愿，否则未落实的申请会错误抵扣培养缺口。
  const progress = computeProgress(db, studentId, { plannedCourseIds: options.plannedCourseIds, term: options.term });
  const courseIds = new Set<number>();
  for (const requirement of progress.requirements) {
    for (const courseId of requirement.candidateCourseIds) courseIds.add(courseId);
  }
  for (const courseId of options.plannedCourseIds ?? []) courseIds.add(courseId);
  for (const courseId of progress.arrangedCourseIds) courseIds.add(courseId);

  const courseCredits: Record<string, number> = {};
  const idList = Array.from(courseIds);
  if (idList.length > 0) {
    const rows = db
      .prepare(`SELECT id, credits FROM courses WHERE id IN (${idList.map(() => '?').join(',')})`)
      .all(...idList) as Array<{ id: number; credits: number }>;
    for (const row of rows) courseCredits[String(row.id)] = row.credits;
  }

  const requirementFilter = options.term ? 'AND term = ?' : '';
  const forcedRows = db
    .prepare(`SELECT course_id FROM term_required_courses WHERE student_id = ? ${requirementFilter}`)
    .all(...(options.term ? [studentId, options.term] : [studentId])) as Array<{ course_id: number }>;

  return {
    requirements: progress.requirements.map((r) => ({
      requirementId: r.requirementId,
      code: r.code,
      name: r.name,
      category: r.category,
      priority: r.priority,
      requiredCredits: r.requiredCredits,
      minCourses: r.minCourses,
      countedCredits: r.countedCredits,
      countedCourses: r.countedCourses,
      candidateCourseIds: r.candidateCourseIds,
    })),
    courseRequirement: Object.fromEntries(Object.entries(progress.courseRequirement).map(([k, v]) => [k, v])),
    courseCredits,
    baseArrangedCourseIds: [...progress.arrangedCourseIds],
    forcedRequiredCourseIds: forcedRows.map((r) => r.course_id),
  };
}

/**
 * 在给定“已落实安排”下重新计算每门课程的培养需求等级。
 * arrangedCourseIds 应当同时包含已有安排与本轮已经落实的结果；
 * 未落实的志愿不会被计入，因此不会抵扣正式竞争中的培养缺口。
 */
export function computeDemandLevels(
  context: DemandContext,
  arrangedCourseIds: Iterable<number>,
): Map<number, DemandAssessment> {
  const base = new Set(context.baseArrangedCourseIds);
  const state = new Map<number, { credits: number; courses: number }>();
  for (const requirement of context.requirements) {
    state.set(requirement.requirementId, {
      credits: requirement.countedCredits,
      courses: requirement.countedCourses,
    });
  }
  for (const courseId of arrangedCourseIds) {
    if (base.has(courseId)) continue;
    const requirementId = context.courseRequirement[String(courseId)];
    if (requirementId === undefined) continue;
    const target = state.get(requirementId);
    if (!target) continue;
    target.credits += context.courseCredits[String(courseId)] ?? 0;
    target.courses += 1;
  }

  const forced = new Set(context.forcedRequiredCourseIds);
  const requirementById = new Map(context.requirements.map((r) => [r.requirementId, r]));
  const allCourseIds = new Set<number>();
  for (const key of Object.keys(context.courseRequirement)) allCourseIds.add(Number(key));
  for (const courseId of forced) allCourseIds.add(courseId);

  const result = new Map<number, DemandAssessment>();
  for (const courseId of allCourseIds) {
    const requirementId = context.courseRequirement[String(courseId)];
    const requirement = requirementId === undefined ? undefined : requirementById.get(requirementId);
    if (!requirement) {
      result.set(courseId, {
        courseId,
        demandLevel: forced.has(courseId) ? 'D2' : 'D0',
        reasons: forced.has(courseId)
          ? ['管理员确认本学期必须完成，且尚无足够安排']
          : ['不属于培养方案中的必修或类别课程，按额外兴趣处理'],
        requirementId: null,
        requirementName: null,
        graduationNecessary: forced.has(courseId),
      });
      continue;
    }
    const current = state.get(requirement.requirementId) ?? { credits: 0, courses: 0 };
    const satisfied = current.credits >= requirement.requiredCredits && current.courses >= requirement.minCourses;
    const remainingCredits = Math.max(0, requirement.requiredCredits - current.credits);
    if (satisfied) {
      result.set(courseId, {
        courseId,
        demandLevel: 'D0',
        reasons: [`培养需求「${requirement.name}」已满足，属于改善申请或额外兴趣`],
        requirementId: requirement.requirementId,
        requirementName: requirement.name,
        graduationNecessary: false,
      });
      continue;
    }
    const level: DemandLevel = forced.has(courseId) || requirement.priority <= 1 ? 'D2' : 'D1';
    result.set(courseId, {
      courseId,
      demandLevel: level,
      reasons:
        level === 'D2'
          ? [
              forced.has(courseId)
                ? '管理员确认本学期必须完成，且尚无足够安排'
                : `本期必须完成的正式要求「${requirement.name}」，尚缺 ${remainingCredits} 学分`,
            ]
          : [`可补足未完成的「${requirement.name}」，尚缺 ${remainingCredits} 学分`],
      requirementId: requirement.requirementId,
      requirementName: requirement.name,
      graduationNecessary: true,
    });
  }
  return result;
}

/**
 * 判断学生对某门课程的“培养需求等级”。
 *   D2：正式规则或管理员确认“本学期必须完成”，且尚无足够安排；
 *   D1：可以补足未完成的必修或类别学分，且尚无足够安排；
 *   D0：已有足够安排后的改善申请，或额外兴趣。
 * plannedCourseIds 仅用于界面预览“如果这些课都选上会怎样”，不参与正式竞争。
 */
export function assessDemand(
  db: SqliteDb,
  studentId: number,
  courseIds: number[],
  options: { plannedCourseIds?: number[] } = {},
): Map<number, DemandAssessment> {
  const result = new Map<number, DemandAssessment>();
  if (courseIds.length === 0) return result;
  const context = buildDemandContext(db, studentId, { plannedCourseIds: options.plannedCourseIds });
  const levels = computeDemandLevels(context, options.plannedCourseIds ?? []);
  for (const courseId of courseIds) {
    result.set(
      courseId,
      levels.get(courseId) ?? {
        courseId,
        demandLevel: 'D0',
        reasons: ['不属于培养方案要求，视为额外兴趣'],
        requirementId: null,
        requirementName: null,
        graduationNecessary: false,
      },
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// 替代组规则
// ---------------------------------------------------------------------------

export interface SubstituteGroup {
  groupId: number;
  code: string;
  name: string;
  rankHint: number;
  courseIds: number[];
}

/** 替代组最多落实一门；同一课程不允许跨组重复出现 */
export function validateSubstituteGroups(groups: SubstituteGroup[]): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  const seen = new Map<number, string>();
  for (const group of groups) {
    for (const courseId of group.courseIds) {
      const previous = seen.get(courseId);
      if (previous && previous !== group.code) {
        messages.push(`课程 ${courseId} 同时出现在替代组「${previous}」和「${group.code}」，同一课程不能跨组重复`);
      }
      seen.set(courseId, group.code);
    }
  }
  return { ok: messages.length === 0, messages };
}

/** 给定一组已落实课程，判断替代组是否被违反（组内超过一门） */
export function checkGroupFulfilment(groups: SubstituteGroup[], fulfilledCourseIds: number[]): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  for (const group of groups) {
    const hit = group.courseIds.filter((id) => fulfilledCourseIds.includes(id));
    if (hit.length > 1) {
      messages.push(`替代组「${group.name}」最多落实一门，当前落实了 ${hit.length} 门`);
    }
  }
  return { ok: messages.length === 0, messages };
}

// ---------------------------------------------------------------------------
// 毕业保障的联合可行性
// ---------------------------------------------------------------------------

export interface GraduationCourseOption {
  courseId: number;
  courseName: string;
  classIds: number[];
}

export interface GraduationFeasibilityInput {
  /** 每门必要课程可用的、且该学生有资格的候选教学班 */
  courseOptions: GraduationCourseOption[];
  /** 已经落实、不可退出的课程（例如预分配或已选） */
  fixedSchedule?: ClassSchedule[];
  /**
   * 直接提供教学班占用键（冻结快照计算用）。
   * 传入时不再查询数据库，保证试算只依赖快照内容。
   */
  occupancyOf?: (classId: number) => Set<string> | undefined;
  /** 已有课表的占用键（与 occupancyOf 搭配使用） */
  fixedOccupancy?: Set<string>;
  /** 班级展示名（用于异常可读性），默认查库 */
  classCodeOf?: (classId: number) => string | undefined;
}

export interface GraduationFeasibility {
  feasible: boolean;
  /** 无解的课程组合（例如两门课只有同一时段可选） */
  conflicts: Array<{ courseIds: number[]; courseNames: string[]; messages: string[] }>;
  assignment: Array<{ courseId: number; classId: number }>;
}

/**
 * 检查“一个学生的多门必要课程”是否存在联合可行的安排。
 * 只看单门课程的总容量是不够的：不同课程可能只有同一时段的教学班，
 * 那样即使每门课都有空位，学生也永远无法同时修完。
 *
 * 联合匹配必须同时包含：
 *   - 学生已经落实、不可退出的课程（fixedSchedule / fixedOccupancy）；
 *   - 本次拟加入的课程（调用方把它并入 fixedOccupancy）；
 *   - 全部剩余必要课程；
 *   - 共享容量（调用方已按当前可用名额过滤 classIds）。
 * 只验证“单人局部空课表”会把明明排不下的组合误判为可行。
 */
export function checkGraduationFeasibility(
  db: SqliteDb | null,
  input: GraduationFeasibilityInput,
): GraduationFeasibility {
  const fixedSchedule = input.fixedSchedule ?? [];
  const fixedCourseIds = new Set(fixedSchedule.map((f) => f.courseId));
  const options = input.courseOptions.filter((o) => !fixedCourseIds.has(o.courseId));

  const scheduleCache = new Map<number, ClassSchedule>();
  const loadOne = (classId: number): ClassSchedule | undefined => {
    if (!db) return undefined;
    if (!scheduleCache.has(classId)) {
      const [loaded] = loadClassSchedule(db, [classId]);
      if (loaded) scheduleCache.set(classId, loaded);
    }
    return scheduleCache.get(classId);
  };
  const occupancyCache = new Map<number, Set<string> | undefined>();
  const occupancyOf =
    input.occupancyOf ??
    ((classId: number) => {
      if (!occupancyCache.has(classId)) {
        const loaded = loadOne(classId);
        occupancyCache.set(classId, loaded ? occupancyKeys(loaded.sessions) : undefined);
      }
      return occupancyCache.get(classId);
    });
  const classCodeOf = input.classCodeOf ?? ((classId: number) => loadOne(classId)?.classCode);

  const fixedOccupancy = new Set<string>(input.fixedOccupancy ?? []);
  if (!input.fixedOccupancy) {
    for (const item of fixedSchedule) {
      for (const key of occupancyKeys(item.sessions)) fixedOccupancy.add(key);
    }
  }

  const assignment: Array<{ courseId: number; classId: number }> = [];
  const failureTrace: string[] = [];
  const chosenUnion = new Set<string>(fixedOccupancy);

  // 按候选数量从少到多（最受限优先）贪心 + 回溯：课程数不多，开销可控
  const ordered = [...options].sort((a, b) => a.classIds.length - b.classIds.length);

  const backtrack = (index: number): boolean => {
    if (index >= ordered.length) return true;
    const option = ordered[index];
    if (option.classIds.length === 0) {
      failureTrace.push(`课程「${option.courseName}」没有任何可用教学班`);
      return false;
    }
    for (const classId of option.classIds) {
      const occupancy = occupancyOf(classId);
      if (!occupancy) continue;
      if (keysIntersect(chosenUnion, occupancy)) continue;
      const added: string[] = [];
      for (const key of occupancy) {
        if (!chosenUnion.has(key)) {
          chosenUnion.add(key);
          added.push(key);
        }
      }
      assignment.push({ courseId: option.courseId, classId });
      if (backtrack(index + 1)) return true;
      assignment.pop();
      for (const key of added) chosenUnion.delete(key);
    }
    failureTrace.push(`课程「${option.courseName}」的所有候选教学班都与已安排课程冲突`);
    return false;
  };

  const feasible = ordered.length === 0 ? true : backtrack(0);
  if (feasible) {
    return { feasible: true, conflicts: [], assignment };
  }

  // 失败时给出可解释的原因：找出互相“怎么选都冲突”的课程对
  const conflicts: GraduationFeasibility['conflicts'] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i];
      const b = ordered[j];
      const pairs: string[] = [];
      for (const classA of a.classIds) {
        for (const classB of b.classIds) {
          const oa = occupancyOf(classA);
          const ob = occupancyOf(classB);
          if (!oa || !ob) continue;
          if (keysIntersect(oa, ob)) {
            pairs.push(`${classCodeOf(classA) ?? classA} 与 ${classCodeOf(classB) ?? classB} 时间冲突`);
          }
        }
      }
      // 只有“所有组合都冲突”才算结构性冲突
      if (pairs.length > 0 && pairs.length >= a.classIds.length * b.classIds.length) {
        conflicts.push({
          courseIds: [a.courseId, b.courseId],
          courseNames: [a.courseName, b.courseName],
          messages: pairs.slice(0, 3),
        });
      }
    }
  }

  return {
    feasible: false,
    conflicts:
      conflicts.length > 0
        ? conflicts
        : [
            {
              courseIds: ordered.map((o) => o.courseId),
              courseNames: ordered.map((o) => o.courseName),
              messages: failureTrace.slice(0, 5),
            },
          ],
    assignment: [],
  };
}

/**
 * 计算某门课程的预留名额是否可以释放。
 * 规则：整门课程的保护需求全部落实后，才能释放剩余预留。
 */
export function reservedSeatsReleasable(
  db: SqliteDb,
  batchId: number,
  courseId: number,
): { releasable: boolean; activeReservations: number; fulfilled: number; abnormal: number } {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM graduation_reservations WHERE batch_id = ? AND course_id = ? GROUP BY status')
    .all(batchId, courseId) as Array<{ status: string; c: number }>;
  const byStatus = new Map(rows.map((r) => [r.status, r.c]));
  const active = byStatus.get('active') ?? 0;
  const fulfilled = byStatus.get('fulfilled') ?? 0;
  const abnormal = byStatus.get('abnormal') ?? 0;
  return {
    releasable: active === 0 && abnormal === 0 && fulfilled > 0,
    activeReservations: active,
    fulfilled,
    abnormal,
  };
}
