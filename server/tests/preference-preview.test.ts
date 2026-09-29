/**
 * 志愿预演与备选关系的端到端验收。
 *
 * 覆盖答辩演示要走的那条路径：
 *   勾课 → 存草稿 → 预演（课表 + 冲突归因）→ 提交 → 备选只落一门。
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { authHeader, login, setupBatch, setupTestContext, studentIds, studentNo, submitPreferences } from './helpers.js';

/** 演示数据里的第一个学生（用户名为学号，密码固定 123456） */
async function loginFirstStudent(ctx: ReturnType<typeof setupTestContext>) {
  const [studentId] = studentIds(ctx, 1);
  return login(ctx.app, studentNo(ctx, studentId), '123456');
}

function firstCourseId(ctx: ReturnType<typeof setupTestContext>): { courseId: number; classId: number; term: string } {
  const row = ctx.db
    .prepare(
      `SELECT tc.course_id AS courseId, tc.id AS classId, tc.term AS term
       FROM teaching_classes tc WHERE tc.status = 'open' ORDER BY tc.id LIMIT 1`,
    )
    .get() as { courseId: number; classId: number; term: string };
  return row;
}

describe('志愿预演', () => {
  it('预演返回课表、逐条结论与累计学分，且不写任何正式数据', async () => {
    const ctx = setupTestContext({ students: 6, classes: 12 });
    try {
      const { batchId } = await setupBatch(ctx, { status: 'open' });
      const student = await loginFirstStudent(ctx);

      const courses = ctx.db
        .prepare(
          `SELECT DISTINCT tc.course_id AS courseId, tc.id AS classId FROM teaching_classes tc
           WHERE tc.status = 'open' ORDER BY tc.id LIMIT 3`,
        )
        .all() as Array<{ courseId: number; classId: number }>;
      expect(courses.length).toBeGreaterThanOrEqual(2);

      const payload = {
        batchId,
        preferences: courses.map((course, index) => ({
          courseId: course.courseId,
          globalRank: index + 1,
          classIds: [course.classId],
          note: null,
          groupCode: null,
        })),
        groups: [],
      };

      const before = ctx.db.prepare('SELECT COUNT(*) AS c FROM enrollments').get() as { c: number };
      const preview = await request(ctx.app)
        .post('/api/preferences/preview')
        .set(authHeader(student.cookie))
        .send(payload);

      expect(preview.status).toBe(200);
      const data = preview.body.data as {
        attempts: Array<{ rank: number; status: string; reason: string; demandText: string }>;
        entries: unknown[];
        credits: number;
        creditLimit: number;
        summary: { total: number; feasible: number };
        notes: string[];
      };

      expect(data.summary.total).toBe(courses.length);
      expect(data.attempts.map((a) => a.rank)).toEqual([1, 2, 3]);
      expect(data.attempts[0].status).toBe('feasible');
      // 需求等级必须已经翻译成人话，界面不再出现 D2/D1/D0
      expect(data.attempts[0].demandText).not.toMatch(/D[012]/);
      expect(data.entries.length).toBeGreaterThan(0);
      expect(data.credits).toBeGreaterThan(0);
      expect(data.creditLimit).toBeGreaterThan(0);
      expect(data.notes.length).toBeGreaterThan(0);

      // 预演是只读的：不产生正式选课
      const after = ctx.db.prepare('SELECT COUNT(*) AS c FROM enrollments').get() as { c: number };
      expect(after.c).toBe(before.c);
    } finally {
      ctx.cleanup();
    }
  });

  it('时间冲突时归因到具体是第几志愿挡住了它', async () => {
    const ctx = setupTestContext({ students: 4, classes: 8 });
    try {
      const { batchId } = await setupBatch(ctx, { status: 'open' });
      const student = await loginFirstStudent(ctx);
      const term = firstCourseId(ctx).term;
      const now = new Date().toISOString();

      // 造两门全新课程，各自只有一个教学班，且时段相同 —— 这样“换班也躲不开冲突”。
      // （若沿用演示课程，同一门课往往还有别的时段的教学班，预演会合理地改选别的班。）
      const makeCourse = (code: string, name: string): number => {
        const info = ctx.db
          .prepare(
            `INSERT INTO courses (code, name, credits, course_type, department, created_at)
             VALUES (?, ?, 3, 'elective', '测试院系', ?)`,
          )
          .run(code, name, now);
        return Number(info.lastInsertRowid);
      };
      const makeSingleClass = (courseId: number, code: string): number => {
        const info = ctx.db
          .prepare(
            `INSERT INTO teaching_classes (course_id, class_code, term, capacity, reserved_seats, status, created_at)
             VALUES (?, ?, ?, 50, 0, 'open', ?)`,
          )
          .run(courseId, code, term, now);
        const classId = Number(info.lastInsertRowid);
        ctx.db
          .prepare(
            `INSERT INTO class_sessions (class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity)
             VALUES (?, 1, 1, 2, 1, 16, 'all')`,
          )
          .run(classId);
        return classId;
      };
      const stamp = Date.now();
      const courseA = makeCourse(`CLASH-A-${stamp}`, '冲突测试课A');
      const courseB = makeCourse(`CLASH-B-${stamp}`, '冲突测试课B');
      const clashA = makeSingleClass(courseA, `CLASH-A-${stamp}`);
      const clashB = makeSingleClass(courseB, `CLASH-B-${stamp}`);

      const preview = await request(ctx.app)
        .post('/api/preferences/preview')
        .set(authHeader(student.cookie))
        .send({
          batchId,
          preferences: [
            { courseId: courseA, globalRank: 1, classIds: [clashA], note: null, groupCode: null },
            { courseId: courseB, globalRank: 2, classIds: [clashB], note: null, groupCode: null },
          ],
          groups: [],
        });

      expect(preview.status).toBe(200);
      const attempts = preview.body.data.attempts as Array<{
        rank: number;
        status: string;
        reason: string;
        conflictRank: number | null;
        conflictText: string | null;
      }>;
      const second = attempts.find((a) => a.rank === 2)!;
      expect(second.status).toBe('conflict');
      expect(second.conflictRank).toBe(1);
      expect(second.reason).toContain('第 1 志愿');
      expect(second.conflictText).toBeTruthy();
    } finally {
      ctx.cleanup();
    }
  });
});

describe('备选关系（替代组）', () => {
  it('备选只落一门：主课程落实后，备选判为组内已落实', async () => {
    const ctx = setupTestContext({ students: 4, classes: 8 });
    try {
      const { batchId } = await setupBatch(ctx, { status: 'open' });
      const student = await loginFirstStudent(ctx);

      const courses = ctx.db
        .prepare("SELECT id AS courseId FROM courses ORDER BY id LIMIT 2")
        .all() as Array<{ courseId: number }>;

      // 主课程（第 1）不进入组，备选（第 2）进入组 —— 这正是界面「加备选」提交的形态
      const preview = await request(ctx.app)
        .post('/api/preferences/preview')
        .set(authHeader(student.cookie))
        .send({
          batchId,
          preferences: [
            { courseId: courses[0].courseId, globalRank: 1, classIds: [], note: null, groupCode: null },
            { courseId: courses[1].courseId, globalRank: 2, classIds: [], note: null, groupCode: 'ALT1' },
          ],
          groups: [{ code: 'ALT1', name: '' }],
        });

      expect(preview.status).toBe(200);
      const attempts = preview.body.data.attempts as Array<{ rank: number; status: string; reason: string; groupCode: string | null }>;
      // 主课程先尝试并成功；备选属于同一组，因此被关闭。
      // 这正是“组内最多落实一门”的预期表现，也是主课程不会挡住自己的证明。
      expect(attempts[0].status).toBe('feasible');
      expect(attempts[0].groupCode).toBe('ALT1');
      expect(attempts[1].status).toBe('conflict');
      expect(attempts[1].reason).toContain('ALT1');
    } finally {
      ctx.cleanup();
    }
  });

  it('组名由服务端生成，主课程不会因为“组内只落一门”而被自己挡住', async () => {
    const ctx = setupTestContext({ students: 4, classes: 8 });
    try {
      const { batchId } = await setupBatch(ctx, { status: 'open' });
      const student = await loginFirstStudent(ctx);
      const courses = ctx.db
        .prepare("SELECT id AS courseId, name FROM courses ORDER BY id LIMIT 2")
        .all() as Array<{ courseId: number; name: string }>;

      const submit = await submitPreferences(
        ctx,
        student.cookie,
        batchId,
        [
          { courseId: courses[0].courseId, globalRank: 1, classIds: [], groupCode: null },
          { courseId: courses[1].courseId, globalRank: 2, classIds: [], groupCode: 'ALT1' },
        ],
        [{ code: 'ALT1', name: '' }],
      );
      expect(submit.status).toBe(200);

      const group = ctx.db
        .prepare("SELECT id, name FROM preference_groups WHERE code = 'ALT1' ORDER BY id DESC LIMIT 1")
        .get() as { id: number; name: string };
      // 组名自动拼出来，学生不需要自己命名
      expect(group.name).toContain(' 或 ');

      // 组里只有备选课程：主课程不属于该组，因此不会被“组内只落一门”挡住
      const members = ctx.db
        .prepare('SELECT course_id FROM preference_group_courses WHERE group_id = ?')
        .all(group.id) as Array<{ course_id: number }>;
      expect(members.map((m) => m.course_id)).toEqual([courses[1].courseId]);
    } finally {
      ctx.cleanup();
    }
  });
});
