/**
 * 官方培养方案回归测试。
 *
 * 依据：上海理工大学 计算机科学与技术（080901 / 培养计划编号 1208）2024 级本科培养计划，
 * 原始文件为《上海理工大学本科培养计划（2024级）》上册（见 server/src/db/official-plan.ts
 * 与 docs/培养方案来源核对.md 中的来源网址与页码）。
 *
 * 覆盖：
 *   - 培养方案能追溯到原文件、来源网址与具体页码；
 *   - 课程代码 / 名称 / 学分 / 必修选修属性 / 建议修读学年学期与官方表格一致；
 *   - 类别（模块）学分要求与官方一致；
 *   - 演示学生绑定该方案，教师 / 教学班 / 容量等模拟数据有明确演示标记；
 *   - Agent 按“官方建议学期 + 个人修读记录 + 本学期开课情况”规划；
 *   - 官方未给出课程号的模块不编造课程号。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authHeader, login, setupTestContext, type TestContext } from './helpers.js';
import { USST_CS_2024_COURSES, USST_CS_2024_SOURCE, officialCourseCount } from '../src/db/official-plan.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = setupTestContext({ students: 30, classes: 40 });
});

afterAll(() => {
  ctx.cleanup();
});

function courseIdOf(code: string): number {
  const row = ctx.db.prepare('SELECT id FROM courses WHERE code = ?').get(code) as { id: number } | undefined;
  if (!row) throw new Error(`找不到官方课程 ${code}`);
  return row.id;
}

async function studentCookie(studentNo = '20241001'): Promise<string> {
  return (await login(ctx.app, studentNo, '123456')).cookie;
}

function studentIdOf(studentNo: string): number {
  return (ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get(studentNo) as { user_id: number }).user_id;
}

/** 清掉某门课的修读记录，让测试场景不受随机种子影响 */
function clearRecords(studentId: number, courseId: number): void {
  ctx.db.prepare('DELETE FROM student_course_records WHERE student_id = ? AND course_id = ?').run(studentId, courseId);
}

describe('培养方案来源与官方课程数据', () => {
  it('课程代码、名称、学分与官方培养计划一致（抽样核对）', () => {
    const samples: Array<{ code: string; name: string; credits: number }> = [
      { code: '22000210', name: '高等数学 A(1)', credits: 6 },
      { code: '12002920', name: '数据结构', credits: 3 },
      { code: '12004529', name: '操作系统 D', credits: 3 },
      { code: '12003550', name: 'Web 应用开发', credits: 3 },
      { code: '12003540', name: '软件协同设计 A', credits: 3 },
      { code: '12004544', name: '分布式计算', credits: 2 },
      { code: '12102992', name: '专业综合技能实习', credits: 6 },
      { code: '12102920', name: '毕业设计', credits: 10 },
      { code: '39000083', name: '思想道德与法治', credits: 3 },
    ];
    for (const sample of samples) {
      const row = ctx.db
        .prepare('SELECT code, name, credits FROM courses WHERE code = ?')
        .get(sample.code) as { code: string; name: string; credits: number } | undefined;
      expect(row, `官方课程 ${sample.code} 应存在`).toBeTruthy();
      expect(row?.name).toBe(sample.name);
      expect(row?.credits).toBe(sample.credits);
    }
    // 种子库中的课程数等于官方有课程号的课程数（不额外编造课程）
    const total = (ctx.db.prepare('SELECT COUNT(*) AS c FROM courses').get() as { c: number }).c;
    expect(total).toBe(officialCourseCount());
    expect(total).toBe(82);
  });

  it('必修/选修属性与建议修读学年学期与官方一致', () => {
    const samples: Array<{ code: string; nature: string; suggestedTerm: string; module: string }> = [
      { code: '22000210', nature: '必修', suggestedTerm: '一/1', module: '大类基础理论' },
      { code: '12002920', nature: '必修', suggestedTerm: '二/1', module: '专业基础理论' },
      { code: '12102660', nature: '必修', suggestedTerm: '二/2(短 3)', module: '专业基础实践' },
      { code: '12003550', nature: '必修', suggestedTerm: '三/1', module: '专业核心课程' },
      { code: '12004544', nature: '选修', suggestedTerm: '三/2', module: '专业选修模块 2' },
      { code: '12102920', nature: '必修', suggestedTerm: '四/2', module: '实践必修' },
      { code: '12002240', nature: '选修', suggestedTerm: '三/1', module: '本研贯通' },
    ];
    for (const sample of samples) {
      const row = ctx.db
        .prepare(
          `SELECT cc.course_nature AS nature, cc.suggested_term AS suggestedTerm, cr.name AS module
           FROM curriculum_courses cc
           JOIN courses c ON c.id = cc.course_id
           JOIN curriculum_requirements cr ON cr.id = cc.requirement_id
           WHERE c.code = ?`,
        )
        .get(sample.code) as { nature: string; suggestedTerm: string; module: string } | undefined;
      expect(row, `课程 ${sample.code} 应有培养方案明细`).toBeTruthy();
      expect(row?.nature).toBe(sample.nature);
      expect(row?.suggestedTerm).toBe(sample.suggestedTerm);
      expect(row?.module).toBe(sample.module);
    }
  });

  it('类别学分要求与官方表格一致', () => {
    const expected: Array<{ code: string; credits: number; nature: string }> = [
      { code: 'GE-IDEOLOGY', credits: 17, nature: '必修' },
      { code: 'GE-MILITARY-1', credits: 2.5, nature: '必修' },
      { code: 'GE-MILITARY-2', credits: 4, nature: '必修' },
      { code: 'GE-LANGUAGE', credits: 8, nature: '必修' },
      { code: 'GE-COMPUTER', credits: 3, nature: '必修' },
      { code: 'BASE-GENERAL-THEORY', credits: 26, nature: '必修' },
      { code: 'BASE-GENERAL-PRACTICE', credits: 2.5, nature: '必修' },
      { code: 'BASE-MAJOR-THEORY', credits: 24, nature: '必修' },
      { code: 'BASE-MAJOR-PRACTICE', credits: 5.5, nature: '必修' },
      { code: 'MAJOR-CORE', credits: 6, nature: '必修' },
      { code: 'MAJOR-ELECTIVE-1', credits: 9, nature: '选修' },
      { code: 'MAJOR-ELECTIVE-2', credits: 8, nature: '选修' },
      { code: 'MAJOR-PRACTICE-REQUIRED', credits: 23, nature: '必修' },
      { code: 'MAJOR-PRACTICE-ELECTIVE', credits: 3, nature: '选修' },
      { code: 'MAJOR-GRADUATE-LINK', credits: 6, nature: '选修' },
      { code: 'FREE-ELECTIVE', credits: 2, nature: '选修' },
    ];
    for (const item of expected) {
      const row = ctx.db
        .prepare('SELECT required_credits AS credits, nature FROM curriculum_requirements WHERE code = ?')
        .get(item.code) as { credits: number; nature: string } | undefined;
      expect(row, `模块 ${item.code} 应存在`).toBeTruthy();
      expect(row?.credits).toBe(item.credits);
      expect(row?.nature).toBe(item.nature);
    }
  });

  it('培养方案能追溯到原文件、来源网址与具体页码', () => {
    const program = ctx.db
      .prepare(
        `SELECT code, name, grade, major, total_credits AS totalCredits, version,
                source_file AS sourceFile, source_url AS sourceUrl, source_pages AS sourcePages,
                source_sha256 AS sourceSha256, source_note AS sourceNote
         FROM programs`,
      )
      .get() as {
      code: string;
      name: string;
      grade: string;
      major: string;
      totalCredits: number;
      version: string;
      sourceFile: string;
      sourceUrl: string;
      sourcePages: string;
      sourceSha256: string;
      sourceNote: string;
    };
    expect(program.code).toBe('080901');
    expect(program.grade).toBe('2024');
    expect(program.major).toBe('计算机科学与技术');
    expect(program.totalCredits).toBe(163.5);
    expect(program.version).toBe('2024版');
    expect(program.sourceFile).toContain('上海理工大学本科培养计划（2024级）');
    expect(program.sourceUrl).toBe(USST_CS_2024_SOURCE.fileUrl);
    expect(program.sourceUrl).toContain('usst.edu.cn');
    expect(program.sourcePages).toContain('138–149');
    expect(program.sourcePages).toContain('IV–VII');
    expect(program.sourceSha256).toBe(USST_CS_2024_SOURCE.fileSha256);
    expect(program.sourceNote).toBeTruthy();
  });

  it('官方未给出课程号的模块只记录学分要求，不编造课程号', () => {
    for (const code of ['GE-MILITARY-2', 'GE-LITERACY-INNOVATION', 'GE-LITERACY-LABOR', 'FREE-ELECTIVE']) {
      const count = (
        ctx.db
          .prepare(
            `SELECT COUNT(*) AS c FROM curriculum_courses cc
             JOIN curriculum_requirements cr ON cr.id = cc.requirement_id WHERE cr.code = ?`,
          )
          .get(code) as { c: number }
      ).c;
      expect(count, `模块 ${code} 不应有编造的课程号`).toBe(0);
    }
  });

  it('官方课程清单与数据库一一对应（代码不重复、不缺失）', () => {
    const dbCodes = (ctx.db.prepare('SELECT code FROM courses ORDER BY code').all() as Array<{ code: string }>).map(
      (r) => r.code,
    );
    const officialCodes = USST_CS_2024_COURSES.map((c) => c.code).sort();
    expect(dbCodes).toEqual(officialCodes);
    expect(new Set(dbCodes).size).toBe(dbCodes.length);
  });
});

describe('学生端培养方案与演示数据标记', () => {
  it('学生可以读取自己绑定的官方培养方案（含来源与页码）', async () => {
    const cookie = await studentCookie();
    const response = await request(ctx.app).get('/api/student/program-plan').set(authHeader(cookie));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const data = response.body.data as {
      program: { code: string; sourceUrl: string; sourcePages: string; totalCredits: number };
      modules: Array<{ code: string; requiredCredits: number; nature: string; sourcePages: string; courses: Array<{ code: string; nature: string; suggestedTerm: string }> }>;
      demoNotice: string;
    };
    expect(data.program.code).toBe('080901');
    expect(data.program.totalCredits).toBe(163.5);
    expect(data.program.sourcePages).toContain('138');
    expect(data.modules.length).toBeGreaterThan(10);
    const core = data.modules.find((m) => m.code === 'MAJOR-CORE');
    expect(core?.requiredCredits).toBe(6);
    expect(core?.courses.map((c) => c.code)).toContain('12003550');
    expect(data.demoNotice).toContain('演示数据');
  });

  it('学生资料与教学班返回演示数据标记', async () => {
    const cookie = await studentCookie();
    const profile = await request(ctx.app).get('/api/student/profile').set(authHeader(cookie));
    expect(profile.status).toBe(200);
    expect(profile.body.data.profile.isDemo).toBe(1);
    expect(profile.body.data.profile.programSourceUrl).toContain('usst.edu.cn');

    const cls = ctx.db
      .prepare("SELECT tc.id FROM teaching_classes tc JOIN courses c ON c.id = tc.course_id WHERE c.code = '12003550' LIMIT 1")
      .get() as { id: number };
    const detail = await request(ctx.app).get(`/api/classes/${cls.id}`).set(authHeader(cookie));
    expect(detail.status).toBe(200);
    expect(detail.body.data.class.isDemo).toBe(true);
    expect(detail.body.data.class.note).toContain('演示数据');
    expect(detail.body.data.class.teacher.isDemo).toBe(true);
  });
});

describe('Agent 按官方方案、个人修读记录与本学期开课情况规划', () => {
  it('规划结果带出官方方案来源，并优先安排当前教学阶段的课程', async () => {
    const cookie = await studentCookie();
    const response = await request(ctx.app).post('/api/agent/plan').set(authHeader(cookie)).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const data = response.body.data as {
      stage: string;
      term: string;
      program: { sourceUrl: string; sourcePages: string } | null;
      plans: Array<{ items: Array<{ courseCode: string; suggestedTerm: string | null; termAdvice: string | null; nature: string | null }> }>;
    };
    // 2024 级 + 2026-2027-1 学期 → 三/1
    expect(data.term).toBe('2026-2027-1');
    expect(data.stage).toBe('三/1');
    expect(data.program?.sourceUrl).toContain('usst.edu.cn');
    expect(data.program?.sourcePages).toContain('138');

    const recommended = data.plans[0];
    expect(recommended.items.length).toBeGreaterThan(0);
    // 推荐方案的课程应来自官方培养计划，并带出官方建议学期与属性
    for (const item of recommended.items) {
      expect(item.suggestedTerm).toBeTruthy();
      expect(item.nature).toBeTruthy();
    }
    // 当前阶段的课程应排在推荐方案里
    expect(recommended.items.some((item) => item.suggestedTerm?.startsWith('三/1'))).toBe(true);
    expect(recommended.items.some((item) => item.termAdvice?.includes('当前阶段'))).toBe(true);
  });

  it('早于当前阶段的课程被标记为“补修”，晚于当前阶段的被标记为“提前修读”', async () => {
    const cookie = await studentCookie();
    // 电路原理（一/2，必修，演示数据里有教学班）→ 补修
    // 演示种子按概率预置修读记录，这里先清掉，保证“尚未修读”的场景确定
    clearRecords(studentIdOf('20241001'), courseIdOf('12002050'));
    const catchUp = await request(ctx.app)
      .post('/api/agent/plan')
      .set(authHeader(cookie))
      .send({ targetCourseIds: [courseIdOf('12002050')] });
    expect(catchUp.status).toBe(200);
    const catchUpItem = (catchUp.body.data.plans[0].items as Array<{ courseCode: string; termAdvice: string | null }>).find(
      (item) => item.courseCode === '12002050',
    );
    expect(catchUpItem?.termAdvice).toContain('补修');

    // 毕业设计（四/2）→ 提前修读
    const early = await request(ctx.app)
      .post('/api/agent/plan')
      .set(authHeader(cookie))
      .send({ targetCourseIds: [courseIdOf('12102920')] });
    expect(early.status).toBe(200);
    const earlyItem = (early.body.data.plans[0].items as Array<{ courseCode: string; termAdvice: string | null }>).find(
      (item) => item.courseCode === '12102920',
    );
    expect(earlyItem?.termAdvice).toContain('提前修读');
  });

  it('本学期没有开放教学班的课程会给出带官方建议学期的未满足原因', async () => {
    const cookie = await studentCookie();
    clearRecords(studentIdOf('20241001'), courseIdOf('12004100'));
    // 通识-计算机类的“数据科学通识导论”在演示数据里没有教学班
    const missing = ctx.db
      .prepare(
        `SELECT c.code FROM courses c
         LEFT JOIN teaching_classes tc ON tc.course_id = c.id
         WHERE c.code = '12004100' AND tc.id IS NULL`,
      )
      .get() as { code: string } | undefined;
    expect(missing?.code).toBe('12004100');

    const response = await request(ctx.app)
      .post('/api/agent/plan')
      .set(authHeader(cookie))
      .send({ targetCourseIds: [courseIdOf('12004100')] });
    expect(response.status).toBe(200);
    const unmet = response.body.data.plans[0].unmet as Array<{ courseName: string; reasons: string[] }>;
    const item = unmet.find((u) => u.courseName === '数据科学通识导论');
    expect(item, JSON.stringify(unmet)).toBeTruthy();
    expect(item?.reasons.join(' ')).toContain('本学期没有开放的教学班');
    expect(item?.reasons.join(' ')).toContain('一/1-一/2');
  });

  it('个人修读记录会改变规划的需求等级（已通过不重复安排）', async () => {
    const studentRow = ctx.db
      .prepare("SELECT user_id, student_no FROM students WHERE student_no = '20241002'")
      .get() as { user_id: number; student_no: string };
    // 给该学生补一条“已通过”记录：软件工程（本研贯通，三/1，选修）
    const softwareEngineering = courseIdOf('12002240');
    ctx.db
      .prepare(
        `INSERT INTO student_course_records (student_id, course_id, status, term, credits, source, verified, updated_at, is_demo)
         VALUES (?, ?, 'passed', '2026-2027-1', 3, 'school', 1, ?, 1)`,
      )
      .run(studentRow.user_id, softwareEngineering, new Date().toISOString());

    const cookie = (await login(ctx.app, studentRow.student_no, '123456')).cookie;
    const response = await request(ctx.app).post('/api/agent/plan').set(authHeader(cookie)).send({});
    expect(response.status).toBe(200);
    const items = response.body.data.plans[0].items as Array<{ courseCode: string }>;
    expect(items.some((item) => item.courseCode === '12002240')).toBe(false);
  });
});
