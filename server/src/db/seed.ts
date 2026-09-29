/**
 * 演示数据生成。
 *
 * 培养方案来自官方文件（见 db/official-plan.ts 与 docs/培养方案来源核对.md）：
 *   上海理工大学 计算机科学与技术（080901 / 培养计划编号 1208），2024 级本科生。
 *   课程代码、名称、学分、必修选修属性、类别学分要求与建议修读学年学期均照抄官方表格。
 *
 * 明确标记为演示数据的部分：
 *   - 教师姓名 / 职称 / 院系
 *   - 教学班编号、上课时间、教室、容量与毕业预留
 *   - 学生账号、修读记录、预分配记录
 * 这些数据在库里有 is_demo 标记，课程描述里也会写明。
 *
 * 规模按验收要求默认 100 名学生、50 个教学班；通过固定随机种子生成，
 * 保证每次 `db:reset` 得到同样的数据，方便演示与测试。
 */
import type { SqliteDb } from './index.js';
import { nowIso, sha256, stableStringify } from '../core/utils.js';
import { hashPassword } from '../core/password.js';
import {
  DEMO_DATA_NOTICE,
  USST_CS_2024_COURSES,
  USST_CS_2024_MODULES,
  USST_CS_2024_SOURCE,
  currentStage,
  parseSuggestedTerm,
  suggestedTermOffset,
  type OfficialCourse,
} from './official-plan.js';

interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: T[]): T;
  bool(p: number): boolean;
}

function makeRng(seed: string): Rng {
  let counter = 0;
  const next = () => {
    const h = sha256(`${seed}:${counter++}`);
    return Number.parseInt(h.slice(0, 8), 16) / 0xffffffff;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    bool: (p) => next() < p,
  };
}

export interface SeedSummary {
  students: number;
  courses: number;
  classes: number;
  records: number;
  preallocations: number;
  /** 演示数据自带的选课批次（状态 open，可直接提交志愿） */
  batchId: number;
  /** 绑定的官方培养方案 */
  programCode: string;
  programName: string;
  /** 官方课程门数（有课程号的） */
  officialCourses: number;
  /** 教学班所在的演示学期 */
  term: string;
}

const DAYS = [1, 2, 3, 4, 5];
const PERIODS: Array<[number, number]> = [
  [1, 2],
  [3, 4],
  [5, 6],
  [7, 8],
  [9, 10],
];

export interface SeedOptions {
  studentCount?: number;
  classCount?: number;
  adminPassword?: string;
  studentPassword?: string;
  /** 教学班所在学期（同时决定学生的当前教学阶段） */
  term?: string;
  admittedYear?: number;
}

export function seedDatabase(db: SqliteDb, options: SeedOptions = {}): SeedSummary {
  const studentCount = options.studentCount ?? 100;
  const classCount = options.classCount ?? 50;
  const adminPassword = options.adminPassword ?? 'admin123';
  const studentPassword = options.studentPassword ?? '123456';
  const term = options.term ?? '2026-2027-1';
  const admittedYear = options.admittedYear ?? Number(USST_CS_2024_SOURCE.grade);
  const rng = makeRng('course-selection-demo-v2');
  const now = nowIso();

  return db.transaction(() => {
    // 清空业务数据（保留结构），方便重复执行
    const tables = [
      'background_tasks',
      'exceptions',
      'audit_logs',
      'enrollment_operations',
      'waitlist_entries',
      'guarantee_authorizations',
      'upgrade_authorizations',
      'graduation_reservations',
      'enrollments',
      'student_course_random_keys',
      'preference_class_choices',
      'preference_group_courses',
      'preference_groups',
      'preferences',
      'preference_submissions',
      'preference_drafts',
      'allocation_items',
      'allocation_runs',
      'batch_snapshots',
      'selection_batches',
      'preallocation_results',
      'source_confirmations',
      'data_versions',
      'import_batches',
      'student_course_records',
      'curriculum_courses',
      'curriculum_requirements',
      'students',
      'sessions',
      'users',
      'class_sessions',
      'teaching_classes',
      'teachers',
      'courses',
      'programs',
      'app_configs',
    ];
    for (const t of tables) {
      db.exec(`DELETE FROM ${t}`);
    }
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('" + tables.join("','") + "')");

    // 口令哈希在数据写入时直接生成：管理员 admin/admin123，学生 学号/123456
    return seedBusinessData(db, rng, {
      studentCount,
      classCount,
      now,
      adminPassword,
      studentPassword,
      term,
      admittedYear,
    });
  })();
}

/** 只负责业务数据（课程、教学班、培养方案、学生与账号） */
function seedBusinessData(
  db: SqliteDb,
  rng: Rng,
  ctx: {
    studentCount: number;
    classCount: number;
    now: string;
    adminPassword: string;
    studentPassword: string;
    term: string;
    admittedYear: number;
  },
): SeedSummary {
  const { studentCount, classCount, now, adminPassword, studentPassword, term, admittedYear } = ctx;

  // ---------------- 管理员 ----------------
  db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, status, created_at)
     VALUES ('admin', ?, '系统管理员', 'admin', 'active', ?)`,
  ).run(hashPassword(adminPassword), now);

  // ---------------- 配置 ----------------
  const configs: Array<[string, string, string, string]> = [
    ['credit_limit_default', '30', 'number', '每名学生每学期可选学分上限（默认值）'],
    ['planning_timeout_ms', '60000', 'number', '规划与分配任务单次计算上限'],
    ['public_supplement_enabled', 'true', 'boolean', '是否允许在无合格候补时公开补选'],
    ['class_swap_enabled', 'true', 'boolean', '是否允许同课换班'],
    ['agent_online_enabled', 'false', 'boolean', '是否启用在线模型（默认关闭，使用离线备用）'],
    [
      'current_term',
      term,
      'string',
      `演示学期：教学班与“本学期开课”按该学期模拟；学生当前教学阶段由入学年份 ${admittedYear} 与学期推算`,
    ],
    ['demo_data_notice', DEMO_DATA_NOTICE, 'string', '演示数据说明（课程来自官方培养计划，教学班与教师为模拟配置）'],
  ];
  const insertConfig = db.prepare(
    'INSERT INTO app_configs (key, value, value_type, description, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [key, value, type, desc] of configs) {
    insertConfig.run(key, value, type, desc, now);
  }

  // ---------------- 教师（演示数据） ----------------
  const surnames = ['张', '李', '王', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡'];
  const given = ['明', '华', '强', '敏', '静', '磊', '洋', '勇', '艳', '杰', '涛', '霞', '军', '丽', '鹏'];
  const insertTeacher = db.prepare('INSERT INTO teachers (name, department, title, is_demo) VALUES (?, ?, ?, 1)');
  const teacherIds: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    const name = `${rng.pick(surnames)}${rng.pick(given)}`;
    const info = insertTeacher.run(name, '演示教师（模拟配置）', rng.pick(['教授', '副教授', '讲师']));
    teacherIds.push(Number(info.lastInsertRowid));
  }

  // ---------------- 课程（来自官方培养计划） ----------------
  const insertCourse = db.prepare(
    `INSERT INTO courses (code, name, credits, department, course_type, description, created_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSession = db.prepare(
    `INSERT INTO class_sessions (class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity, room)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertClass = db.prepare(
    `INSERT INTO teaching_classes (course_id, class_code, term, teacher_id, capacity, reserved_seats, status, campus, note, created_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1)`,
  );

  const departmentByModule = new Map(USST_CS_2024_MODULES.map((m) => [m.code, m.department]));
  const moduleNameByModule = new Map(USST_CS_2024_MODULES.map((m) => [m.code, `${m.group}·${m.name}`]));

  const courseIds: number[] = [];
  const courseIdByCode = new Map<string, number>();
  const officialByCode = new Map<string, OfficialCourse & { moduleCode: string }>();
  for (const course of USST_CS_2024_COURSES) {
    officialByCode.set(course.code, course);
    const info = insertCourse.run(
      course.code,
      course.name,
      course.credits,
      departmentByModule.get(course.moduleCode) ?? null,
      course.courseType,
      `官方培养计划课程（${moduleNameByModule.get(course.moduleCode) ?? course.moduleCode}，建议修读 ${course.suggestedTerm}，${course.nature}）。${DEMO_DATA_NOTICE}`,
      now,
      0,
    );
    const id = Number(info.lastInsertRowid);
    courseIds.push(id);
    courseIdByCode.set(course.code, id);
  }

  // ---------------- 教学班（演示数据：时间/容量/教师均为模拟配置） ----------------
  const stage = currentStage(term, admittedYear);
  const offsetOf = (course: OfficialCourse) => suggestedTermOffset(course.suggestedTerm, stage);
  const currentStageCourses = USST_CS_2024_COURSES.filter((c) => offsetOf(c) === 0).map((c) => courseIdByCode.get(c.code)!);
  const previousStageCourses = USST_CS_2024_COURSES.filter((c) => offsetOf(c) === -1).map((c) => courseIdByCode.get(c.code)!);
  const highCreditRequired = USST_CS_2024_COURSES.filter((c) => c.courseType === 'required' && c.credits >= 4).map(
    (c) => courseIdByCode.get(c.code)!,
  );

  // 必须开班的课程：官方顺序最前面的几门（保证通用检索/测试拿到有班课程）、
  // 高学分必修课、本学期（当前阶段）与上一阶段课程（补修用）。
  const mustHaveIds = Array.from(
    new Set<number>([
      ...courseIds.slice(0, 6),
      ...highCreditRequired,
      ...currentStageCourses,
      ...previousStageCourses,
    ]),
  );
  const priorityOrder = Array.from(
    new Set<number>([
      ...mustHaveIds,
      ...USST_CS_2024_COURSES.filter((c) => c.courseType === 'required').map((c) => courseIdByCode.get(c.code)!),
      ...courseIds,
    ]),
  );

  const classCourseIds: number[] = [];
  for (const courseId of priorityOrder) {
    if (classCourseIds.length >= classCount) break;
    classCourseIds.push(courseId);
  }
  // 还有余量：优先给必修课增加第二个班，制造“热门课名额紧张”的演示效果
  let extraCursor = 0;
  while (classCourseIds.length < classCount) {
    const courseId = priorityOrder[extraCursor % priorityOrder.length];
    extraCursor += 1;
    if (classCourseIds.filter((c) => c === courseId).length >= 2) continue;
    classCourseIds.push(courseId);
    if (extraCursor > priorityOrder.length * 4) break;
  }

  const classIds: number[] = [];
  classCourseIds.forEach((courseId, idx) => {
    const classCode = `${term.replace(/-/g, '')}-${String(idx + 1).padStart(3, '0')}`;
    const capacity = rng.int(30, 70);
    // 每个教学班预留 0-4 个毕业保障名额
    const reserved = rng.bool(0.5) ? rng.int(1, 4) : 0;
    const teacherId = teacherIds[idx % teacherIds.length];
    const info = insertClass.run(
      courseId,
      classCode,
      term,
      teacherId,
      capacity,
      Math.min(reserved, capacity - 5),
      rng.pick(['东校区', '西校区']),
      idx % 7 === 0 ? '【演示数据】含实验环节；教师与容量为模拟配置' : '【演示数据】教师与容量为模拟配置',
      now,
    );
    const classId = Number(info.lastInsertRowid);
    classIds.push(classId);

    // 时段：1-3 个时段；每 5 个班出现一个单双周班（演示模拟配置）
    const sessionCount = rng.int(1, 3);
    const usedKeys = new Set<string>();
    for (let s = 0; s < sessionCount; s += 1) {
      let day = rng.pick(DAYS);
      let period = rng.pick(PERIODS);
      let guard = 0;
      while (usedKeys.has(`${day}-${period[0]}`) && guard < 20) {
        day = rng.pick(DAYS);
        period = rng.pick(PERIODS);
        guard += 1;
      }
      usedKeys.add(`${day}-${period[0]}`);
      const parity = idx % 5 === 4 ? (rng.bool(0.5) ? 'odd' : 'even') : 'all';
      insertSession.run(
        classId,
        day,
        period[0],
        period[1],
        1,
        16,
        parity,
        `教${rng.int(1, 6)}-${rng.int(100, 499)}`,
      );
    }
  });

  // ---------------- 培养方案（官方文件） ----------------
  const insertProgram = db.prepare(
    `INSERT INTO programs
     (code, name, grade, major, total_credits, version, published_at, status, created_at,
      source_file, source_url, source_pages, source_sha256, source_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)`,
  );
  const programInfo = insertProgram.run(
    USST_CS_2024_SOURCE.majorCode,
    `${USST_CS_2024_SOURCE.major}（${USST_CS_2024_SOURCE.grade} 级）`,
    USST_CS_2024_SOURCE.grade,
    USST_CS_2024_SOURCE.major,
    USST_CS_2024_SOURCE.totalCredits,
    '2024版',
    now,
    now,
    USST_CS_2024_SOURCE.documentTitle,
    USST_CS_2024_SOURCE.fileUrl,
    `${USST_CS_2024_SOURCE.planPages}；学分结构 ${USST_CS_2024_SOURCE.creditStructurePages}；通识教育课程 ${USST_CS_2024_SOURCE.generalEducationPages}`,
    USST_CS_2024_SOURCE.fileSha256,
    `${USST_CS_2024_SOURCE.note} 公开页：${USST_CS_2024_SOURCE.disclosurePage}`,
  );
  const programId = Number(programInfo.lastInsertRowid);

  const insertRequirement = db.prepare(
    `INSERT INTO curriculum_requirements (program_id, code, name, category, required_credits, min_courses, priority, note, nature, source_pages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCurriculumCourse = db.prepare(
    'INSERT INTO curriculum_courses (requirement_id, course_id, relation, priority, suggested_term, course_nature) VALUES (?, ?, ?, ?, ?, ?)',
  );

  for (const module of USST_CS_2024_MODULES) {
    const info = insertRequirement.run(
      programId,
      module.code,
      module.name,
      module.group,
      module.minCredits,
      0,
      module.priority,
      module.note,
      module.nature,
      module.sourcePages,
    );
    const requirementId = Number(info.lastInsertRowid);
    module.courses.forEach((course, index) => {
      const courseId = courseIdByCode.get(course.code);
      if (!courseId) return;
      insertCurriculumCourse.run(requirementId, courseId, 'direct', index + 1, course.suggestedTerm, course.nature);
    });
  }

  // ---------------- 学生（演示账号，绑定该官方培养方案） ----------------
  const insertStudentUser = db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, status, created_at, last_login_at)
     VALUES (?, ?, ?, 'student', 'active', ?, NULL)`,
  );
  const insertStudent = db.prepare(
    `INSERT INTO students (user_id, student_no, name, grade, major, program_id, admitted_year, expected_graduate_at, created_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const insertRecord = db.prepare(
    `INSERT INTO student_course_records (student_id, course_id, status, term, credits, source, verified, version_id, updated_at, is_demo)
     VALUES (?, ?, ?, ?, ?, 'school', 1, NULL, ?, 1)`,
  );

  const studentIds: number[] = [];
  const studentHash = hashPassword(studentPassword);
  for (let i = 0; i < studentCount; i += 1) {
    const no = `${admittedYear}${String(1001 + i).padStart(4, '0')}`;
    const name = `${rng.pick(surnames)}${rng.pick(given)}${rng.bool(0.3) ? rng.pick(given) : ''}`;
    const userInfo = insertStudentUser.run(no, studentHash, name, now);
    const userId = Number(userInfo.lastInsertRowid);
    insertStudent.run(
      userId,
      no,
      name,
      USST_CS_2024_SOURCE.grade,
      USST_CS_2024_SOURCE.major,
      programId,
      admittedYear,
      `${admittedYear + 4}-07-01`,
      now,
    );
    studentIds.push(userId);
  }

  // 修读记录：按官方“建议修读学期”与当前教学阶段生成
  //   - 早于当前阶段的课程：多数已通过，少数不及格（需要补修）
  //   - 当前阶段课程：不预置，留给学生本学期规划与选课
  const academicTermOf = (course: OfficialCourse): string => {
    const parsed = parseSuggestedTerm(course.suggestedTerm);
    if (!parsed) return `${admittedYear}-${admittedYear + 1}-1`;
    const startYear = admittedYear + parsed.year - 1;
    return `${startYear}-${startYear + 1}-${parsed.term}`;
  };
  let recordCount = 0;
  for (const studentId of studentIds) {
    for (const course of USST_CS_2024_COURSES) {
      const offset = suggestedTermOffset(course.suggestedTerm, stage);
      if (offset === null || offset >= 0) continue;
      const roll = rng.next();
      if (roll < 0.82) {
        insertRecord.run(studentId, courseIdByCode.get(course.code)!, 'passed', academicTermOf(course), course.credits, now);
        recordCount += 1;
      } else if (roll < 0.9) {
        insertRecord.run(studentId, courseIdByCode.get(course.code)!, 'failed', academicTermOf(course), 0, now);
        recordCount += 1;
      }
    }
  }

  // ---------------- 专业课预分配（演示数据，待管理员落实） ----------------
  const insertPrealloc = db.prepare(
    `INSERT INTO preallocation_results (student_id, class_id, batch_id, status, margin, created_at, applied_at)
     VALUES (?, ?, NULL, 'pending', ?, ?, NULL)`,
  );
  const preallocCourseIds = currentStageCourses.slice(0, 3);
  let preallocCount = 0;
  for (let i = 0; i < Math.min(30, studentIds.length) && preallocCourseIds.length > 0; i += 1) {
    const studentId = studentIds[i];
    const courseId = preallocCourseIds[i % preallocCourseIds.length];
    const candidates = db
      .prepare('SELECT id, capacity, reserved_seats FROM teaching_classes WHERE course_id = ? AND status = ?')
      .all(courseId, 'open') as Array<{ id: number; capacity: number; reserved_seats: number }>;
    if (candidates.length === 0) continue;
    const target = candidates[i % candidates.length];
    insertPrealloc.run(studentId, target.id, 2, now);
    preallocCount += 1;
  }

  // ---------------- 演示用选课批次 ----------------
  // 种子库直接给出一个“正式受理中”的批次，这样打开页面就能提交志愿、跑分配，
  // 不需要先手动建批次（管理员也可以再建新的批次）。
  const openAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const closeAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const batchInfo = db
    .prepare(
      `INSERT INTO selection_batches (term, name, status, credit_limit, open_at, close_at, note, created_by, created_at)
       VALUES (?, ?, 'open', 30, ?, ?, ?, (SELECT id FROM users WHERE username = 'admin'), ?)`,
    )
    .run(
      term,
      `${term} 第一轮选课（演示批次）`,
      openAt,
      closeAt,
      `演示数据自带的批次：${DEMO_DATA_NOTICE}`,
      now,
    );
  const batchId = Number(batchInfo.lastInsertRowid);

  return {
    students: studentCount,
    courses: courseIds.length,
    classes: classIds.length,
    records: recordCount,
    preallocations: preallocCount,
    batchId,
    programCode: USST_CS_2024_SOURCE.majorCode,
    programName: `${USST_CS_2024_SOURCE.major}（${USST_CS_2024_SOURCE.grade} 级）`,
    officialCourses: USST_CS_2024_COURSES.length,
    term,
  };
}

/** 便捷校验：演示数据的稳定摘要（用于 README 与测试断言） */
export function seedFingerprint(db: SqliteDb): string {
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM courses) AS courses,
              (SELECT COUNT(*) FROM teaching_classes) AS classes,
              (SELECT COUNT(*) FROM students) AS students,
              (SELECT COUNT(*) FROM curriculum_requirements) AS requirements,
              (SELECT COUNT(*) FROM curriculum_courses) AS planCourses`,
    )
    .get() as { courses: number; classes: number; students: number; requirements: number; planCourses: number };
  return sha256(stableStringify(counts));
}
