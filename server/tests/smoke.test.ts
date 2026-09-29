/**
 * 冒烟测试：确认服务能启动、能登录、能读到演示数据。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authHeader, login, setupTestContext, type TestContext } from './helpers.js';
import { USST_CS_2024_SOURCE, officialCourseCount } from '../src/db/official-plan.js';
import { CLASS_ROSTER_STUDENTS } from '../src/db/class-roster.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = setupTestContext({ students: 20, classes: 12 });
});

afterAll(() => {
  ctx.cleanup();
});

describe('基础可用性', () => {
  it('健康检查可用', async () => {
    const response = await request(ctx.app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.status).toBe('ok');
  });

  it('未登录访问受保护接口返回 UNAUTHENTICATED', async () => {
    const response = await request(ctx.app).get('/api/student/profile');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('管理员可以用 admin/admin123 登录', async () => {
    const response = await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    expect(response.status).toBe(200);
    expect(response.body.data.user.role).toBe('admin');
  });

  it('错误口令返回 BAD_CREDENTIALS', async () => {
    const response = await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('BAD_CREDENTIALS');
  });

  it('学生登录后可以读取自己的资料与培养进度', async () => {
    const session = await login(ctx.app, '20241001', '123456');
    const profile = await request(ctx.app).get('/api/student/profile').set(authHeader(session.cookie));
    expect(profile.status).toBe(200);
    expect(profile.body.data.profile.studentNo).toBe('20241001');

    const progress = await request(ctx.app).get('/api/student/progress').set(authHeader(session.cookie));
    expect(progress.status).toBe(200);
    expect(Array.isArray(progress.body.data.progress.requirements)).toBe(true);
    expect(progress.body.data.progress.requirements.length).toBeGreaterThan(0);
  });

  it('学生不能访问管理员接口', async () => {
    const session = await login(ctx.app, '20241001', '123456');
    const response = await request(ctx.app).get('/api/admin/users').set(authHeader(session.cookie));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('演示数据规模符合预期', async () => {
    const courses = ctx.db.prepare('SELECT COUNT(*) AS c FROM courses').get() as { c: number };
    const classes = ctx.db.prepare('SELECT COUNT(*) AS c FROM teaching_classes').get() as { c: number };
    const students = ctx.db.prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number };
    // 课程全部来自官方培养计划（见 db/official-plan.ts）
    expect(courses.c).toBe(officialCourseCount());
    expect(classes.c).toBe(12);
    // 20 名演示学生 + 随种子写入的真实班级名单（见 db/class-roster.ts）
    expect(students.c).toBe(20 + CLASS_ROSTER_STUDENTS.length);
  });

  it('演示学生绑定官方培养方案，且模拟数据有明确标记', async () => {
    const program = ctx.db
      .prepare('SELECT code, name, grade, major, total_credits AS totalCredits, source_url AS sourceUrl, source_pages AS sourcePages FROM programs')
      .get() as { code: string; name: string; grade: string; major: string; totalCredits: number; sourceUrl: string; sourcePages: string };
    expect(program.code).toBe(USST_CS_2024_SOURCE.majorCode);
    expect(program.grade).toBe('2024');
    expect(program.major).toBe('计算机科学与技术');
    expect(program.totalCredits).toBe(163.5);
    expect(program.sourceUrl).toContain('usst.edu.cn');
    expect(program.sourcePages).toContain('138');

    // 所有学生都绑定该方案
    const unbound = (
      ctx.db.prepare('SELECT COUNT(*) AS c FROM students WHERE program_id IS NULL').get() as { c: number }
    ).c;
    expect(unbound).toBe(0);

    // 模块学分要求与课程属性来自官方表格
    const ideology = ctx.db
      .prepare("SELECT required_credits AS credits, nature, source_pages AS pages FROM curriculum_requirements WHERE code = 'GE-IDEOLOGY'")
      .get() as { credits: number; nature: string; pages: string };
    expect(ideology.credits).toBe(17);
    expect(ideology.nature).toBe('必修');

    const course = ctx.db
      .prepare('SELECT code, name, credits FROM courses WHERE code = ?')
      .get('12002920') as { code: string; name: string; credits: number };
    expect(course.name).toBe('数据结构');
    expect(course.credits).toBe(3);

    const planCourse = ctx.db
      .prepare(
        `SELECT cc.suggested_term AS suggestedTerm, cc.course_nature AS nature
         FROM curriculum_courses cc JOIN courses c ON c.id = cc.course_id WHERE c.code = '12002920'`,
      )
      .get() as { suggestedTerm: string; nature: string };
    expect(planCourse.suggestedTerm).toBe('二/1');
    expect(planCourse.nature).toBe('必修');

    // 教师 / 教学班属于演示模拟配置
    const demoClasses = (
      ctx.db.prepare('SELECT COUNT(*) AS c FROM teaching_classes WHERE is_demo = 1').get() as { c: number }
    ).c;
    const allClasses = (ctx.db.prepare('SELECT COUNT(*) AS c FROM teaching_classes').get() as { c: number }).c;
    expect(demoClasses).toBe(allClasses);
    const demoTeachers = (ctx.db.prepare('SELECT COUNT(*) AS c FROM teachers WHERE is_demo = 1').get() as { c: number }).c;
    const rosterTeachers = (
      ctx.db.prepare('SELECT COUNT(*) AS c FROM teachers WHERE is_demo = 0').get() as { c: number }
    ).c;
    const allTeachers = (ctx.db.prepare('SELECT COUNT(*) AS c FROM teachers').get() as { c: number }).c;
    // 只有演示教师与名单教师两类，不允许出现来源不明的教师
    expect(demoTeachers + rosterTeachers).toBe(allTeachers);
    expect(rosterTeachers).toBe(1);
  });
});
