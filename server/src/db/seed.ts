/**
 * 演示数据生成。
 *
 * 规模按验收要求默认 100 名学生、50 个教学班，
 * 数据里刻意包含：单双周课程、多时段课程、互斥替代组、毕业必要课程、预分配占用。
 * 通过固定随机种子生成，保证每次 `db:reset` 得到同样的数据，方便演示与测试。
 */
import type { SqliteDb } from './index.js';
import { nowIso, sha256, stableStringify } from '../core/utils.js';
import { hashPassword } from '../core/password.js';

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
}

export function seedDatabase(db: SqliteDb, options: SeedOptions = {}): SeedSummary {
  const studentCount = options.studentCount ?? 100;
  const classCount = options.classCount ?? 50;
  const adminPassword = options.adminPassword ?? 'admin123';
  const studentPassword = options.studentPassword ?? '123456';
  const rng = makeRng('course-selection-demo-v1');
  const now = nowIso();

  return db.transaction(() => {
    // 清空业务数据（保留结构），方便重复执行
    const tables = [
      'exceptions',
      'audit_logs',
      'enrollment_operations',
      'waitlist_entries',
      'upgrade_authorizations',
      'graduation_reservations',
      'enrollments',
      'student_course_random_keys',
      'preference_class_choices',
      'preference_group_courses',
      'preference_groups',
      'preferences',
      'preference_submissions',
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
    return seedBusinessData(db, rng, { studentCount, classCount, now, adminPassword, studentPassword });
  })();
}

/** 只负责业务数据（课程、教学班、培养方案、学生与账号） */
function seedBusinessData(
  db: SqliteDb,
  rng: Rng,
  ctx: { studentCount: number; classCount: number; now: string; adminPassword: string; studentPassword: string },
): SeedSummary {
  const { studentCount, classCount, now, adminPassword, studentPassword } = ctx;

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
  ];
  const insertConfig = db.prepare(
    'INSERT INTO app_configs (key, value, value_type, description, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [key, value, type, desc] of configs) {
    insertConfig.run(key, value, type, desc, now);
  }

  // ---------------- 教师 ----------------
  const surnames = ['张', '李', '王', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡'];
  const given = ['明', '华', '强', '敏', '静', '磊', '洋', '勇', '艳', '杰', '涛', '霞', '军', '丽', '鹏'];
  const departments = ['计算机学院', '数学学院', '外国语学院', '经济管理学院', '物理学院', '马克思主义学院'];
  const insertTeacher = db.prepare('INSERT INTO teachers (name, department, title) VALUES (?, ?, ?)');
  const teacherIds: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    const name = `${rng.pick(surnames)}${rng.pick(given)}`;
    const info = insertTeacher.run(name, rng.pick(departments), rng.pick(['教授', '副教授', '讲师']));
    teacherIds.push(Number(info.lastInsertRowid));
  }

  // ---------------- 课程 ----------------
  const insertCourse = db.prepare(
    `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSession = db.prepare(
    `INSERT INTO class_sessions (class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity, room)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertClass = db.prepare(
    `INSERT INTO teaching_classes (course_id, class_code, term, teacher_id, capacity, reserved_seats, status, campus, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  );

  const term = '2026-2027-1';
  const courseIds: number[] = [];
  const requiredCourses: number[] = [];

  const catalogue: Array<{ name: string; credits: number; type: 'required' | 'limited_elective' | 'elective' | 'general'; dept: string }> = [
    { name: '高等数学A', credits: 5, type: 'required', dept: '数学学院' },
    { name: '线性代数', credits: 3, type: 'required', dept: '数学学院' },
    { name: '概率论与数理统计', credits: 3, type: 'required', dept: '数学学院' },
    { name: '大学物理', credits: 4, type: 'required', dept: '物理学院' },
    { name: '程序设计基础', credits: 4, type: 'required', dept: '计算机学院' },
    { name: '数据结构', credits: 4, type: 'required', dept: '计算机学院' },
    { name: '计算机组成原理', credits: 4, type: 'required', dept: '计算机学院' },
    { name: '操作系统', credits: 4, type: 'required', dept: '计算机学院' },
    { name: '数据库系统原理', credits: 3, type: 'required', dept: '计算机学院' },
    { name: '计算机网络', credits: 3, type: 'required', dept: '计算机学院' },
    { name: '软件工程', credits: 3, type: 'required', dept: '计算机学院' },
    { name: '编译原理', credits: 3, type: 'limited_elective', dept: '计算机学院' },
    { name: '人工智能导论', credits: 3, type: 'limited_elective', dept: '计算机学院' },
    { name: '机器学习', credits: 3, type: 'limited_elective', dept: '计算机学院' },
    { name: 'Web 应用开发', credits: 3, type: 'limited_elective', dept: '计算机学院' },
    { name: '信息安全基础', credits: 3, type: 'limited_elective', dept: '计算机学院' },
    { name: '离散数学', credits: 3, type: 'required', dept: '数学学院' },
    { name: '数值分析', credits: 3, type: 'limited_elective', dept: '数学学院' },
    { name: '大学英语', credits: 3, type: 'required', dept: '外国语学院' },
    { name: '学术英语写作', credits: 2, type: 'general', dept: '外国语学院' },
    { name: '微观经济学', credits: 3, type: 'general', dept: '经济管理学院' },
    { name: '管理学原理', credits: 3, type: 'general', dept: '经济管理学院' },
    { name: '中国近现代史纲要', credits: 3, type: 'required', dept: '马克思主义学院' },
    { name: '马克思主义基本原理', credits: 3, type: 'required', dept: '马克思主义学院' },
    { name: '体育（一）', credits: 1, type: 'required', dept: '体育部' },
    { name: '艺术鉴赏', credits: 2, type: 'general', dept: '艺术学院' },
    { name: '科技写作', credits: 2, type: 'general', dept: '文学院' },
    { name: '数据可视化', credits: 2, type: 'elective', dept: '计算机学院' },
  ];

  catalogue.forEach((item, idx) => {
    const code = `C${String(idx + 1).padStart(4, '0')}`;
    const info = insertCourse.run(
      code,
      item.name,
      item.credits,
      item.dept,
      item.type,
      `${item.name}（${item.credits} 学分，${item.type === 'required' ? '必修' : item.type === 'limited_elective' ? '限选' : item.type === 'general' ? '通识' : '任选'}）`,
      now,
    );
    const id = Number(info.lastInsertRowid);
    courseIds.push(id);
    if (item.type === 'required' && item.credits >= 3) requiredCourses.push(id);
  });

  // 教学班：50 个，覆盖 28 门课，其中毕业必要课程给 3 个班（体现“名额紧张”）
  const classCourseIds: number[] = [];
  const requiredWithMoreClasses = [courseIds[0], courseIds[4], courseIds[5], courseIds[6], courseIds[8], courseIds[22]];
  for (const cid of requiredWithMoreClasses) {
    classCourseIds.push(cid, cid, cid);
  }
  let cursor = 0;
  while (classCourseIds.length < classCount) {
    const cid = courseIds[cursor % courseIds.length];
    cursor += 1;
    // 必修课排完后再补充其它课程，避免同一门课班次过多
    const occurrences = classCourseIds.filter((c) => c === cid).length;
    if (occurrences >= 3) continue;
    classCourseIds.push(cid);
  }
  const limitedClassCourses = classCourseIds.slice(0, classCount);

  const classIds: number[] = [];
  const occupiedSlots = new Map<string, number>();
  limitedClassCourses.forEach((courseId, idx) => {
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
      idx % 7 === 0 ? '含实验环节' : null,
      now,
    );
    const classId = Number(info.lastInsertRowid);
    classIds.push(classId);

    // 时段：1-3 个时段；每 5 个班出现一个单双周班
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
        parity === 'all' ? 1 : 1,
        parity === 'all' ? 16 : 16,
        parity,
        `教${rng.int(1, 6)}-${rng.int(100, 499)}`,
      );
      occupiedSlots.set(`${classId}-${day}-${period[0]}`, classId);
    }
  });

  // ---------------- 培养方案 ----------------
  const insertProgram = db.prepare(
    `INSERT INTO programs (code, name, grade, major, total_credits, version, published_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?)`,
  );
  const programInfo = insertProgram.run('CS-2024', '计算机科学与技术（2024 级）', '2024', '计算机科学与技术', 160, 'v1', now, now);
  const programId = Number(programInfo.lastInsertRowid);

  const insertRequirement = db.prepare(
    `INSERT INTO curriculum_requirements (program_id, code, name, category, required_credits, min_courses, priority, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCurriculumCourse = db.prepare(
    'INSERT INTO curriculum_courses (requirement_id, course_id, relation, priority) VALUES (?, ?, ?, ?)',
  );

  const requirementDefs: Array<{
    code: string;
    name: string;
    category: string;
    credits: number;
    minCourses: number;
    priority: number;
    courses: Array<{ name: string; relation: 'direct' | 'substitute' }>;
  }> = [
    {
      code: 'REQ-MATH',
      name: '数学与自然科学基础',
      category: '必修',
      credits: 14,
      minCourses: 3,
      priority: 1,
      courses: [
        { name: '高等数学A', relation: 'direct' },
        { name: '线性代数', relation: 'direct' },
        { name: '概率论与数理统计', relation: 'direct' },
        { name: '离散数学', relation: 'direct' },
        { name: '数值分析', relation: 'substitute' },
      ],
    },
    {
      code: 'REQ-CORE',
      name: '专业核心课程',
      category: '必修',
      credits: 22,
      minCourses: 5,
      priority: 1,
      courses: [
        { name: '程序设计基础', relation: 'direct' },
        { name: '数据结构', relation: 'direct' },
        { name: '计算机组成原理', relation: 'direct' },
        { name: '操作系统', relation: 'direct' },
        { name: '数据库系统原理', relation: 'direct' },
        { name: '计算机网络', relation: 'direct' },
        { name: '软件工程', relation: 'direct' },
      ],
    },
    {
      code: 'REQ-ELEC',
      name: '专业限选课程',
      category: '限选',
      credits: 9,
      minCourses: 3,
      priority: 2,
      courses: [
        { name: '编译原理', relation: 'direct' },
        { name: '人工智能导论', relation: 'direct' },
        { name: '机器学习', relation: 'direct' },
        { name: 'Web 应用开发', relation: 'direct' },
        { name: '信息安全基础', relation: 'direct' },
        { name: '数据可视化', relation: 'substitute' },
      ],
    },
    {
      code: 'REQ-LANG',
      name: '外语能力',
      category: '必修',
      credits: 3,
      minCourses: 1,
      priority: 2,
      courses: [
        { name: '大学英语', relation: 'direct' },
        { name: '学术英语写作', relation: 'substitute' },
      ],
    },
    {
      code: 'REQ-IDEO',
      name: '思想政治理论',
      category: '必修',
      credits: 6,
      minCourses: 2,
      priority: 2,
      courses: [
        { name: '中国近现代史纲要', relation: 'direct' },
        { name: '马克思主义基本原理', relation: 'direct' },
      ],
    },
    {
      code: 'REQ-GEN',
      name: '通识与体育',
      category: '通识',
      credits: 9,
      minCourses: 3,
      priority: 3,
      courses: [
        { name: '体育（一）', relation: 'direct' },
        { name: '艺术鉴赏', relation: 'direct' },
        { name: '科技写作', relation: 'direct' },
        { name: '微观经济学', relation: 'direct' },
        { name: '管理学原理', relation: 'direct' },
      ],
    },
  ];

  const courseIdByName = new Map<string, number>();
  const courseRows = db.prepare('SELECT id, name FROM courses').all() as Array<{ id: number; name: string }>;
  for (const row of courseRows) courseIdByName.set(row.name, row.id);
  const courseNameById = new Map<number, string>();
  for (const row of courseRows) courseNameById.set(row.id, row.name);

  const requirementIds: number[] = [];
  const requirementCourseMap = new Map<number, Array<{ courseId: number; name: string; relation: 'direct' | 'substitute' }>>();
  for (const def of requirementDefs) {
    const info = insertRequirement.run(
      programId,
      def.code,
      def.name,
      def.category,
      def.credits,
      def.minCourses,
      def.priority,
      null,
    );
    const reqId = Number(info.lastInsertRowid);
    requirementIds.push(reqId);
    const list: Array<{ courseId: number; name: string; relation: 'direct' | 'substitute' }> = [];
    def.courses.forEach((c, i) => {
      const courseId = courseIdByName.get(c.name);
      if (!courseId) return;
      insertCurriculumCourse.run(reqId, courseId, c.relation, i + 1);
      list.push({ courseId, name: c.name, relation: c.relation });
    });
    requirementCourseMap.set(reqId, list);
  }

  // ---------------- 学生 ----------------
  const insertStudentUser = db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, status, created_at, last_login_at)
     VALUES (?, ?, ?, 'student', 'active', ?, NULL)`,
  );
  const insertStudent = db.prepare(
    `INSERT INTO students (user_id, student_no, name, grade, major, program_id, admitted_year, expected_graduate_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRecord = db.prepare(
    `INSERT INTO student_course_records (student_id, course_id, status, term, credits, source, verified, version_id, updated_at)
     VALUES (?, ?, ?, ?, ?, 'school', 1, NULL, ?)`,
  );

  const studentIds: number[] = [];
  const studentNos: string[] = [];
  const studentHash = hashPassword(studentPassword);
  for (let i = 0; i < studentCount; i += 1) {
    const no = `2024${String(1001 + i).padStart(4, '0')}`;
    studentNos.push(no);
    const name = `${rng.pick(surnames)}${rng.pick(given)}${rng.bool(0.3) ? rng.pick(given) : ''}`;
    const userInfo = insertStudentUser.run(no, studentHash, name, now);
    const userId = Number(userInfo.lastInsertRowid);
    insertStudent.run(userId, no, name, '2024', '计算机科学与技术', programId, 2024, '2028-07-01', now);
    studentIds.push(userId);
  }

  // 修读记录：随机一部分课程已通过 / 正在修读
  let recordCount = 0;
  for (const studentId of studentIds) {
    for (const courseId of courseIds) {
      const roll = rng.next();
      const credits = (db.prepare('SELECT credits FROM courses WHERE id = ?').get(courseId) as { credits: number }).credits;
      if (roll < 0.18) {
        insertRecord.run(studentId, courseId, 'passed', rng.pick(['2024-2025-1', '2024-2025-2', '2025-2026-1', '2025-2026-2']), credits, now);
        recordCount += 1;
      } else if (roll < 0.24) {
        insertRecord.run(studentId, courseId, 'in_progress', '2026-2027-1', credits, now);
        recordCount += 1;
      } else if (roll < 0.28) {
        insertRecord.run(studentId, courseId, 'failed', '2025-2026-2', 0, now);
        recordCount += 1;
      }
    }
  }

  // ---------------- 专业课预分配（占用正式容量） ----------------
  const insertPrealloc = db.prepare(
    `INSERT INTO preallocation_results (student_id, class_id, batch_id, status, margin, created_at, applied_at)
     VALUES (?, ?, NULL, 'applied', ?, ?, ?)`,
  );
  // 为 30 名学生预分配高数/程序设计等专业课
  const preallocCourses = [courseIds[0], courseIds[4], courseIds[5]];
  let preallocCount = 0;
  for (let i = 0; i < Math.min(30, studentIds.length); i += 1) {
    const studentId = studentIds[i];
    const courseId = preallocCourses[i % preallocCourses.length];
    const candidates = db
      .prepare('SELECT id, capacity, reserved_seats FROM teaching_classes WHERE course_id = ? AND status = ?')
      .all(courseId, 'open') as Array<{ id: number; capacity: number; reserved_seats: number }>;
    if (candidates.length === 0) continue;
    const target = candidates[i % candidates.length];
    insertPrealloc.run(studentId, target.id, 2, now, now);
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
      '演示数据自带的批次：可以直接提交志愿、冻结、试算与发布',
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
  };
}

/** 便捷校验：演示数据的稳定摘要（用于 README 与测试断言） */
export function seedFingerprint(db: SqliteDb): string {
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM courses) AS courses,
              (SELECT COUNT(*) FROM teaching_classes) AS classes,
              (SELECT COUNT(*) FROM students) AS students`,
    )
    .get() as { courses: number; classes: number; students: number };
  return sha256(stableStringify(counts));
}
