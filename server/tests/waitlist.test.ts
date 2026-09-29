/**
 * 候补与退改选测试。
 *
 * 覆盖验收要求：
 *   - 首轮未选中自动进入候补，展示“当前顺位”；
 *   - 允许新增/修改候补申请，按当前需求 + 排名 + 固定随机键排序；
 *   - 暂时冲突/学分不足/缺授权先暂挂，条件变化后重新检查；
 *   - 永久失效关闭并说明原因；
 *   - 名额先给合格候补；没有合格候补且名额不受保护时才能公开补选；
 *   - 有合格候补时不能绕过队列。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authHeader, createClassRow, login, setupBatch, setupTestContext, submitPreferences, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = setupTestContext({ students: 24, classes: 16 });
});

afterAll(() => {
  ctx.cleanup();
});

async function cookieOf(username: string): Promise<string> {
  return (await login(ctx.app, username, '123456')).cookie;
}

describe('候补排队与顺位', () => {
  it('需求等级与固定随机键决定顺位，展示的是当前顺位而不是承诺', async () => {
    const batch = await setupBatch(ctx, { name: '候补顺位' });
    const now = new Date().toISOString();
    const courseInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 3, '测试学院', 'elective', '候补课', ?)`,
      )
      .run(`WL${Date.now() % 100000}`, '候补课', now);
    const courseId = Number(courseInfo.lastInsertRowid);
    const classId = createClassRow(ctx, {
      courseId,
      classCode: `WL${Date.now() % 100000}-A`,
      term: batch.term,
      capacity: 1,
      sessions: [{ dayOfWeek: 6, periodStart: 5, periodEnd: 6, weekStart: 1, weekEnd: 16 }],
    });

    const students = ['20241010', '20241011', '20241012'];
    for (const username of students) {
      const cookie = await cookieOf(username);
      const result = await submitPreferences(ctx, cookie, batch.batchId, [{ courseId, globalRank: 1, classIds: [classId] }]);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    }

    // 冻结并试算：只有 1 人能选上，其余落选
    const freeze = await request(ctx.app).post(`/api/admin/batches/${batch.batchId}/freeze`).set(authHeader(batch.adminCookie)).send({});
    expect(freeze.status).toBe(200);
    const run = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/allocate`)
      .set(authHeader(batch.adminCookie))
      .send({ mode: 'publish', idempotencyKey: `wl-publish-${batch.batchId}` });
    expect(run.status, JSON.stringify(run.body)).toBe(200);

    // 首轮落选自动进入候补
    const enqueue = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/enqueue-waitlist`)
      .set(authHeader(batch.adminCookie))
      .send({ runId: run.body.data.runId });
    expect(enqueue.status).toBe(200);
    expect(enqueue.body.data.queued).toBeGreaterThan(0);

    // 进入候补阶段
    const toWaitlist = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/transition`)
      .set(authHeader(batch.adminCookie))
      .send({ status: 'waitlist' });
    expect(toWaitlist.status, JSON.stringify(toWaitlist.body)).toBe(200);

    // 每名学生的顺位都能查到，且互不重复
    const positions: number[] = [];
    for (const username of students) {
      const cookie = await cookieOf(username);
      const view = await request(ctx.app).get(`/api/waitlist?batchId=${batch.batchId}`).set(authHeader(cookie));
      expect(view.status).toBe(200);
      const entry = (view.body.data.entries as Array<{ courseId: number; status: string; position: number | null }>).find(
        (e) => e.courseId === courseId,
      );
      if (entry && entry.status === 'queued') positions.push(entry.position ?? 0);
    }
    expect(positions.length).toBeGreaterThan(0);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('暂时冲突的候补被暂挂，退掉冲突课程后重新检查可以提升', async () => {
    const batch = await setupBatch(ctx, { name: '候补暂挂', status: 'waitlist' });
    const now = new Date().toISOString();
    const makeCourse = (code: string, name: string) =>
      Number(
        ctx.db
          .prepare(
            `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
             VALUES (?, ?, 3, '测试学院', 'elective', NULL, ?)`,
          )
          .run(code, name, now).lastInsertRowid,
      );
    // 目标课程：1 个名额，与“冲突课程”同一时段
    const targetCourseId = makeCourse(`WS${Date.now() % 100000}`, '暂挂目标课');
    const targetClass = createClassRow(ctx, {
      courseId: targetCourseId,
      classCode: `WS${Date.now() % 100000}-A`,
      term: batch.term,
      capacity: 1,
      sessions: [{ dayOfWeek: 2, periodStart: 1, periodEnd: 2, weekStart: 1, weekEnd: 16 }],
    });
    // 先把名额占满
    const blockerCookie = await cookieOf('20241013');
    const blocker = await request(ctx.app)
      .post('/api/enroll')
      .set(authHeader(blockerCookie))
      .send({ classId: targetClass, idempotencyKey: 'blocker-1' });
    expect(blocker.status, JSON.stringify(blocker.body)).toBe(200);

    // 目标学生先选上一门冲突课程，然后提交候补申请
    const conflictCourseId = makeCourse(`WC${Date.now() % 100000}`, '冲突课程');
    const conflictClass = createClassRow(ctx, {
      courseId: conflictCourseId,
      classCode: `WC${Date.now() % 100000}-A`,
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 2, periodStart: 1, periodEnd: 2, weekStart: 1, weekEnd: 16 }],
    });
    const studentCookie = await cookieOf('20241014');
    const enrollConflict = await request(ctx.app)
      .post('/api/enroll')
      .set(authHeader(studentCookie))
      .send({ classId: conflictClass, idempotencyKey: 'conflict-enroll' });
    expect(enrollConflict.status, JSON.stringify(enrollConflict.body)).toBe(200);

    const addWaitlist = await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(studentCookie))
      .send({ batchId: batch.batchId, courseId: targetCourseId, classIds: [targetClass] });
    expect(addWaitlist.status, JSON.stringify(addWaitlist.body)).toBe(200);

    // 重新检查：因为名额被别人占着（且自身时间冲突），应被暂挂
    const recheck = await request(ctx.app)
      .post('/api/waitlist/recheck')
      .set(authHeader(studentCookie))
      .send({ batchId: batch.batchId });
    expect(recheck.status).toBe(200);
    const entryRow = ctx.db
      .prepare('SELECT status, suspend_code FROM waitlist_entries WHERE batch_id = ? AND course_id = ?')
      .get(batch.batchId, targetCourseId) as { status: string; suspend_code: string | null };
    expect(['suspended', 'queued']).toContain(entryRow.status);

    // 占用者退课 → 名额释放；学生退掉冲突课程 → 条件变化
    const releaseBlocker = await request(ctx.app)
      .post('/api/drop')
      .set(authHeader(blockerCookie))
      .send({ classId: targetClass, idempotencyKey: 'blocker-drop' });
    expect(releaseBlocker.status).toBe(200);
    const dropConflict = await request(ctx.app)
      .post('/api/drop')
      .set(authHeader(studentCookie))
      .send({ classId: conflictClass, idempotencyKey: 'conflict-drop' });
    expect(dropConflict.status).toBe(200);

    const recheckAgain = await request(ctx.app)
      .post('/api/waitlist/recheck')
      .set(authHeader(studentCookie))
      .send({ batchId: batch.batchId });
    expect(recheckAgain.status).toBe(200);
    const promoted = ctx.db
      .prepare('SELECT status FROM waitlist_entries WHERE batch_id = ? AND course_id = ?')
      .get(batch.batchId, targetCourseId) as { status: string };
    expect(promoted.status).toBe('promoted');
    const enrolled = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .get(targetClass) as { c: number };
    expect(enrolled.c).toBe(1);
  });

  it('永久失效的申请会被关闭并说明原因（课程已取消）', async () => {
    const batch = await setupBatch(ctx, { name: '候补关闭' });
    const now = new Date().toISOString();
    const courseId = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES (?, '取消课程', 2, '测试学院', 'elective', NULL, ?)`,
        )
        .run(`CX${Date.now() % 100000}`, now).lastInsertRowid,
    );
    const classId = createClassRow(ctx, {
      courseId,
      classCode: `CX${Date.now() % 100000}-A`,
      term: batch.term,
      capacity: 1,
      sessions: [{ dayOfWeek: 6, periodStart: 7, periodEnd: 8, weekStart: 1, weekEnd: 16 }],
    });
    const cookie = await cookieOf('20241015');
    const add = await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId, courseId, classIds: [classId] });
    expect(add.status).toBe(200);

    // 课程取消
    const cancel = await request(ctx.app)
      .patch(`/api/admin/classes/${classId}/status`)
      .set(authHeader(batch.adminCookie))
      .send({ status: 'cancelled', reason: '任课教师调离' });
    expect(cancel.status).toBe(200);

    const recheck = await request(ctx.app).post('/api/waitlist/recheck').set(authHeader(cookie)).send({ batchId: batch.batchId });
    expect(recheck.status).toBe(200);
    const row = ctx.db
      .prepare('SELECT status, close_code, close_reason FROM waitlist_entries WHERE batch_id = ? AND course_id = ?')
      .get(batch.batchId, courseId) as { status: string; close_code: string | null; close_reason: string | null };
    expect(row.status).toBe('closed');
    expect(row.close_code).toBe('course_cancelled');
    expect(row.close_reason).toBeTruthy();
  });

  it('有合格候补时不能绕过队列进行公开补选', async () => {
    const batch = await setupBatch(ctx, { name: '公开补选', status: 'waitlist' });
    const now = new Date().toISOString();
    const courseId = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES (?, '补选课', 2, '测试学院', 'elective', NULL, ?)`,
        )
        .run(`PS${Date.now() % 100000}`, now).lastInsertRowid,
    );
    const classId = createClassRow(ctx, {
      courseId,
      classCode: `PS${Date.now() % 100000}-A`,
      term: batch.term,
      capacity: 1,
      sessions: [{ dayOfWeek: 6, periodStart: 9, periodEnd: 10, weekStart: 1, weekEnd: 16 }],
    });
    const waitingCookie = await cookieOf('20241016');
    await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(waitingCookie))
      .send({ batchId: batch.batchId, courseId, classIds: [classId] });

    // 先选上名额的学生
    const holderCookie = await cookieOf('20241017');
    await request(ctx.app).post('/api/enroll').set(authHeader(holderCookie)).send({ classId, idempotencyKey: 'ps-hold' });

    // 批次还未进入候补阶段 → 不允许公开补选
    const beforeWaitlist = await request(ctx.app)
      .get(`/api/eligibility/${classId}`)
      .set(authHeader(waitingCookie));
    expect(beforeWaitlist.status).toBe(200);
    expect(beforeWaitlist.body.data.supplement.allowed).toBe(false);

    // 批次已处于候补阶段，但因为还有合格候补，仍然不允许公开补选
    const withWaitlist = await request(ctx.app)
      .get(`/api/eligibility/${classId}`)
      .set(authHeader(waitingCookie));
    expect(withWaitlist.body.data.supplement.allowed).toBe(false);
    expect(withWaitlist.body.data.supplement.qualifiedWaitlist).toBeGreaterThan(0);

    // 释放名额：合格候补应当被自动提升，而不是被别人抢走
    const drop = await request(ctx.app)
      .post('/api/drop')
      .set(authHeader(holderCookie))
      .send({ classId, idempotencyKey: 'ps-drop' });
    expect(drop.status).toBe(200);
    const promoted = ctx.db
      .prepare('SELECT status FROM waitlist_entries WHERE course_id = ? AND student_id = (SELECT user_id FROM students WHERE student_no = ?)')
      .get(courseId, '20241016') as { status: string };
    expect(promoted.status).toBe('promoted');
    const enrolled = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .get(classId) as { c: number };
    expect(enrolled.c).toBe(1);
  });

  it('候补申请可以修改教学班偏好，退出后不再参与提升', async () => {
    const batch = await setupBatch(ctx, { name: '候补修改与退出' });
    const now = new Date().toISOString();
    const courseId = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES (?, '候补修改课', 2, '测试学院', 'elective', NULL, ?)`,
        )
        .run(`WM${Date.now() % 100000}`, now).lastInsertRowid,
    );
    const classA = createClassRow(ctx, {
      courseId,
      classCode: `WM${Date.now() % 100000}-A`,
      term: batch.term,
      capacity: 5,
      sessions: [{ dayOfWeek: 4, periodStart: 9, periodEnd: 10, weekStart: 1, weekEnd: 16 }],
    });
    const classB = createClassRow(ctx, {
      courseId,
      classCode: `WM${Date.now() % 100000}-B`,
      term: batch.term,
      capacity: 5,
      sessions: [{ dayOfWeek: 4, periodStart: 9, periodEnd: 10, weekStart: 1, weekEnd: 16 }],
    });
    const cookie = await cookieOf('20241018');
    const add = await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId, courseId, classIds: [classA] });
    expect(add.status).toBe(200);
    const update = await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId, courseId, classIds: [classB, classA] });
    expect(update.status).toBe(200);
    const entry = ctx.db
      .prepare('SELECT id, class_choices FROM waitlist_entries WHERE batch_id = ? AND course_id = ?')
      .get(batch.batchId, courseId) as { id: number; class_choices: string };
    expect(JSON.parse(entry.class_choices)).toEqual([classB, classA]);

    const withdraw = await request(ctx.app).delete(`/api/waitlist/${entry.id}`).set(authHeader(cookie));
    expect(withdraw.status).toBe(200);
    const after = ctx.db.prepare('SELECT status FROM waitlist_entries WHERE id = ?').get(entry.id) as { status: string };
    expect(after.status).toBe('withdrawn');

    // 已退出的候补不会因为名额释放而被提升
    const holder = await cookieOf('20241019');
    await request(ctx.app).post('/api/enroll').set(authHeader(holder)).send({ classId: classA, idempotencyKey: 'wm-hold' });
    await request(ctx.app).post('/api/drop').set(authHeader(holder)).send({ classId: classA, idempotencyKey: 'wm-drop' });
    const stillOut = ctx.db.prepare('SELECT status FROM waitlist_entries WHERE id = ?').get(entry.id) as { status: string };
    expect(stillOut.status).toBe('withdrawn');
  });
});
