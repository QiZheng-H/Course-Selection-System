/**
 * 管理端流程简化回归测试。
 *
 * 对应《选课系统管理员页面简化实施计划》的验收场景：
 *   1. 发布结果与开放退改选是两个独立动作：发布后学生只能查看，候补不自动递补；
 *   2. 管理员开放退改选后，学生才能选退换，候补恢复递补；
 *   3. 未发布结果前可以重新开放志愿提交，保留志愿与固定随机键、作废旧快照与旧方案；
 *   4. 晚到的计算结果不能发布过期结果；
 *   5. 已发布/已结束没有“强制回到首轮”的入口，通用流转也不再支持 force；
 *   6. 工作台统一返回阶段、下一步动作与阻塞原因。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  authHeader,
  createClassRow,
  login,
  runAllocationTask,
  setupBatch,
  setupTestContext,
  submitPreferences,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let seq = 0;

beforeAll(() => {
  ctx = setupTestContext({ students: 40, classes: 20 });
});

afterAll(() => {
  ctx.cleanup();
});

function nowIso(): string {
  return new Date().toISOString();
}

function makeCourse(name: string, credits = 3): number {
  seq += 1;
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, ?, '测试学院', 'elective', NULL, ?)`,
      )
      .run(`WF${seq}${Date.now() % 10000}`, name, credits, nowIso()).lastInsertRowid,
  );
}

function makeClass(
  courseId: number,
  term: string,
  capacity: number,
  periodStart: number,
): number {
  seq += 1;
  return createClassRow(ctx, {
    courseId,
    classCode: `WF${seq}-A`,
    term,
    capacity,
    sessions: [{ dayOfWeek: 6, periodStart, periodEnd: periodStart + 1, weekStart: 1, weekEnd: 16 }],
  });
}

async function studentCookie(studentNo: string): Promise<string> {
  return (await login(ctx.app, studentNo, '123456')).cookie;
}

function studentIdOf(studentNo: string): number {
  return (ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get(studentNo) as { user_id: number }).user_id;
}

/** 学生本人确认个人修读记录；“结束提交并检查”要求已提交志愿的学生都确认过 */
async function confirmRecords(cookie: string): Promise<void> {
  const response = await request(ctx.app).post('/api/student/records/confirm').set(authHeader(cookie)).send({});
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function runAction(
  adminCookie: string,
  batchId: number,
  action: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } }> {
  const response = await request(ctx.app)
    .post(`/api/admin/batches/${batchId}/actions/${action}`)
    .set(authHeader(adminCookie))
    .send(body);
  return { status: response.status, body: response.body };
}

async function workbench(adminCookie: string, batchId: number) {
  const response = await request(ctx.app)
    .get(`/api/admin/workbench?batchId=${batchId}`)
    .set(authHeader(adminCookie));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    stage: { key: string; label: string; admissionOpen: boolean };
    primaryAction: { key: string; enabled: boolean; blockers: Array<{ code: string; severity: string }> } | null;
    blockers: Array<{ code: string }>;
    todos: Array<{ key: string; count: number; severity: string }>;
    steps: Array<{ key: string; label: string; state: string }>;
    checklist: Array<{ key: string; label: string; value: string; done: boolean }>;
    recentActivity: Array<{ id: number; summary: string }>;
    stats: { totalStudents: number; submittedStudents: number; notSubmittedStudents: number };
    batch: { status: string; stageRevision: number };
  };
}

// ---------------------------------------------------------------------------
// ① 发布结果 ≠ 开放退改选
// ---------------------------------------------------------------------------

describe('发布结果与开放退改选分离', () => {
  it('发布后学生只能查看，管理员开放退改选后才能选退课并恢复候补递补', async () => {
    const batch = await setupBatch(ctx, { name: '阶段分离' });
    const course = makeCourse('阶段分离课');
    const classId = makeClass(course, batch.term, 1, 1);
    const winnerCookie = await studentCookie('20241001');
    const loserCookie = await studentCookie('20241002');
    await submitPreferences(ctx, winnerCookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);
    await submitPreferences(ctx, loserCookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);
    await confirmRecords(winnerCookie);
    await confirmRecords(loserCookie);

    const close = await runAction(batch.adminCookie, batch.batchId, 'close-submission');
    expect(close.status, JSON.stringify(close.body)).toBe(200);

    const plan = await runAction(batch.adminCookie, batch.batchId, 'generate-plan');
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const taskId = plan.body.data!.taskId as number;
    for (;;) {
      const task = await request(ctx.app).get(`/api/admin/tasks/${taskId}`).set(authHeader(batch.adminCookie));
      const status = task.body.data.task.status as string;
      if (!['queued', 'running'].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const publish = await runAction(batch.adminCookie, batch.batchId, 'publish-result');
    expect(publish.status, JSON.stringify(publish.body)).toBe(200);

    const stageAfterPublish = await workbench(batch.adminCookie, batch.batchId);
    expect(stageAfterPublish.stage.key).toBe('result_published');
    expect(stageAfterPublish.stage.admissionOpen).toBe(false);
    expect(stageAfterPublish.primaryAction?.key).toBe('open_change');

    const enrolled = ctx.db
      .prepare("SELECT student_id FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .all(classId) as Array<{ student_id: number }>;
    expect(enrolled.length).toBe(1);
    const queued = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM waitlist_entries WHERE batch_id = ? AND status = 'queued'")
      .get(batch.batchId) as { c: number };
    expect(queued.c).toBe(1);

    // 固定随机键决定谁中签，所以按实际结果选择退课人
    const enrolledStudentNo = (
      ctx.db.prepare('SELECT student_no FROM students WHERE user_id = ?').get(enrolled[0].student_id) as {
        student_no: string;
      }
    ).student_no;
    const enrolledCookie = await studentCookie(enrolledStudentNo);
    // 另一位学生（未中签）用于验证候补编辑权限
    const otherCookie = enrolledStudentNo === '20241001' ? loserCookie : winnerCookie;

    // 退改选未开放：退课被阶段限制拒绝，学生也不能修改候补
    const dropBefore = await request(ctx.app)
      .post('/api/drop')
      .set(authHeader(enrolledCookie))
      .send({ classId, idempotencyKey: 'wf-drop-before' });
    expect(dropBefore.status).toBe(409);
    expect(dropBefore.body.error.code).toBe('BATCH_STATE_INVALID');
    const waitlistBefore = await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(otherCookie))
      .send({ batchId: batch.batchId, courseId: course, classIds: [classId], globalRank: 1 });
    expect(waitlistBefore.status).toBe(409);

    // 管理员开放退改选：阶段变化后同一批请求即可通过
    const openChange = await runAction(batch.adminCookie, batch.batchId, 'open-change');
    expect(openChange.status, JSON.stringify(openChange.body)).toBe(200);
    const stageAfterOpen = await workbench(batch.adminCookie, batch.batchId);
    expect(stageAfterOpen.stage.key).toBe('change_open');
    expect(stageAfterOpen.stage.admissionOpen).toBe(true);

    const dropAfter = await request(ctx.app)
      .post('/api/drop')
      .set(authHeader(enrolledCookie))
      .send({ classId, idempotencyKey: 'wf-drop-after' });
    expect(dropAfter.status, JSON.stringify(dropAfter.body)).toBe(200);

    // 退课释放名额后候补恢复自动递补
    const promoted = ctx.db
      .prepare("SELECT status, source FROM waitlist_entries WHERE batch_id = ?")
      .get(batch.batchId) as { status: string; source: string | null };
    expect(promoted.status).toBe('promoted');
    const promotedEnrollment = ctx.db
      .prepare("SELECT source FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .get(classId) as { source: string } | undefined;
    expect(promotedEnrollment?.source).toBe('waitlist');
  });

  it('学生端阶段接口与后端写接口保持一致', async () => {
    const batch = await setupBatch(ctx, { name: '学生阶段视图' });
    const cookie = await studentCookie('20241005');
    const before = await request(ctx.app).get('/api/student/active-stage').set(authHeader(cookie));
    expect(before.status).toBe(200);
    expect(before.body.data.stage.batchId).toBe(batch.batchId);
    expect(before.body.data.stage.canSubmitPreference).toBe(true);
    expect(before.body.data.stage.admissionOpen).toBe(false);
    expect(before.body.data.stage.canUseWaitlist).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ② 重新开放志愿提交
// ---------------------------------------------------------------------------

describe('重新开放志愿提交', () => {
  it('保留志愿与固定随机键、作废旧快照与旧方案，并阻止过期结果发布', async () => {
    const batch = await setupBatch(ctx, { name: '重新开放' });
    const course = makeCourse('重新开放课');
    const classId = makeClass(course, batch.term, 5, 3);
    const cookie = await studentCookie('20241003');
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);
    await confirmRecords(cookie);

    const close = await runAction(batch.adminCookie, batch.batchId, 'close-submission');
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    const plan = await runAction(batch.adminCookie, batch.batchId, 'generate-plan');
    const taskId = plan.body.data!.taskId as number;
    let runId = 0;
    for (;;) {
      const task = await request(ctx.app).get(`/api/admin/tasks/${taskId}`).set(authHeader(batch.adminCookie));
      const taskRow = task.body.data.task as { status: string; result: { runId?: number } | null; runId: number | null };
      if (!['queued', 'running'].includes(taskRow.status)) {
        runId = taskRow.result?.runId ?? taskRow.runId ?? 0;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runId).toBeGreaterThan(0);

    const studentId = (
      ctx.db.prepare("SELECT user_id FROM students WHERE student_no = '20241003'").get() as { user_id: number }
    ).user_id;
    const keysBefore = ctx.db
      .prepare('SELECT course_id, random_key FROM student_course_random_keys WHERE student_id = ? AND term = ? ORDER BY course_id')
      .all(studentId, batch.term);

    const closeAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const reopen = await runAction(batch.adminCookie, batch.batchId, 'reopen-submission', {
      closeAt,
      reason: '学生反馈漏选课程',
    });
    expect(reopen.status, JSON.stringify(reopen.body)).toBe(200);
    const reopenStage = await workbench(batch.adminCookie, batch.batchId);
    expect(reopenStage.batch.status).toBe('open');
    expect(reopenStage.batch.stageRevision).toBe(2);

    // 旧快照与旧方案被标记失效
    const snapshot = ctx.db
      .prepare('SELECT invalidated_at AS invalidatedAt, invalidated_reason AS reason FROM batch_snapshots WHERE batch_id = ?')
      .get(batch.batchId) as { invalidatedAt: string | null; reason: string | null };
    expect(snapshot.invalidatedAt).toBeTruthy();
    const run = ctx.db
      .prepare('SELECT status, invalidated_at AS invalidatedAt FROM allocation_runs WHERE id = ?')
      .get(runId) as { status: string; invalidatedAt: string | null };
    expect(run.invalidatedAt).toBeTruthy();

    // 固定随机信息保留：不因重新开放而重新抽签
    const keysAfter = ctx.db
      .prepare('SELECT course_id, random_key FROM student_course_random_keys WHERE student_id = ? AND term = ? ORDER BY course_id')
      .all(studentId, batch.term);
    expect(keysAfter).toEqual(keysBefore);

    // 旧方案不能发布
    const stalePublish = await runAction(batch.adminCookie, batch.batchId, 'publish-result', { runId });
    expect(stalePublish.status).toBe(409);

    // 模拟“晚到的计算任务”：本轮生成的、属于旧阶段版本的成功方案也不能发布
    const lateRun = ctx.db
      .prepare(
        `INSERT INTO allocation_runs (batch_id, attempt, mode, status, snapshot_hash, started_at, finished_at, timeout_ms, created_by, created_at, stage_revision)
         VALUES (?, 999, 'simulate', 'succeeded', NULL, ?, ?, 60000, 1, ?, 1)`,
      )
      .run(batch.batchId, nowIso(), nowIso(), nowIso());
    const latePublish = await runAction(batch.adminCookie, batch.batchId, 'publish-result', {
      runId: Number(lateRun.lastInsertRowid),
    });
    expect(latePublish.status).toBe(409);

    // 重新截止后会生成新的有效快照，并可以按新版本生成方案与发布
    const student = await request(ctx.app).get(`/api/preferences?batchId=${batch.batchId}`).set(authHeader(cookie));
    expect(student.status).toBe(200);
    expect(student.body.data.view.status).toBe('submitted');
    // 重新开放后学生可以继续修改志愿
    const resubmit = await submitPreferences(ctx, cookie, batch.batchId, [
      { courseId: course, globalRank: 1, classIds: [classId] },
    ]);
    expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);

    const closeAgain = await runAction(batch.adminCookie, batch.batchId, 'close-submission');
    expect(closeAgain.status, JSON.stringify(closeAgain.body)).toBe(200);
    const freshSnapshot = ctx.db
      .prepare('SELECT invalidated_at AS invalidatedAt, stage_revision AS stageRevision FROM batch_snapshots WHERE batch_id = ?')
      .get(batch.batchId) as { invalidatedAt: string | null; stageRevision: number };
    expect(freshSnapshot.invalidatedAt).toBeNull();
    expect(freshSnapshot.stageRevision).toBe(2);

    const planAgain = await runAction(batch.adminCookie, batch.batchId, 'generate-plan');
    expect(planAgain.status, JSON.stringify(planAgain.body)).toBe(200);
    const publishAgain = await runAction(batch.adminCookie, batch.batchId, 'publish-result');
    expect(publishAgain.status, JSON.stringify(publishAgain.body)).toBe(200);
  });

  it('已经发布结果后没有普通入口回到首轮', async () => {
    const batch = await setupBatch(ctx, { name: '发布后不可回退' });
    const course = makeCourse('不可回退课');
    const classId = makeClass(course, batch.term, 5, 5);
    const cookie = await studentCookie('20241004');
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);
    await confirmRecords(cookie);
    await runAction(batch.adminCookie, batch.batchId, 'close-submission');
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    const publish = await runAction(batch.adminCookie, batch.batchId, 'publish-result', { runId: run.runId });
    expect(publish.status, JSON.stringify(publish.body)).toBe(200);

    const reopen = await runAction(batch.adminCookie, batch.batchId, 'reopen-submission', {
      closeAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error?.message).toContain('撤销整轮发布');

    const backToOpen = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/transition`)
      .set(authHeader(batch.adminCookie))
      .send({ status: 'open', force: true });
    expect(backToOpen.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// ③ 通用流转不再支持强制执行
// ---------------------------------------------------------------------------

describe('通用状态流转不再支持强制执行', () => {
  it('结束提交后不能用通用接口改状态，结束后也不能回到发布', async () => {
    const batch = await setupBatch(ctx, { name: '无强制执行' });
    const course = makeCourse('无强制课');
    const classId = makeClass(course, batch.term, 5, 7);
    const cookie = await studentCookie('20241006');
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);
    await confirmRecords(cookie);
    await runAction(batch.adminCookie, batch.batchId, 'close-submission');

    // 即使带 force:true，也不能从 frozen 直接改状态或跳过生成方案发布
    const forcedOpen = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/transition`)
      .set(authHeader(batch.adminCookie))
      .send({ status: 'open', force: true });
    expect(forcedOpen.status).toBe(409);
    const forcedPublish = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/transition`)
      .set(authHeader(batch.adminCookie))
      .send({ status: 'published', force: true });
    expect(forcedPublish.status).toBe(409);

    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    await runAction(batch.adminCookie, batch.batchId, 'publish-result', { runId: run.runId });
    await runAction(batch.adminCookie, batch.batchId, 'open-change');
    const close = await runAction(batch.adminCookie, batch.batchId, 'close-activity');
    expect(close.status, JSON.stringify(close.body)).toBe(200);

    const reopenClosed = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/transition`)
      .set(authHeader(batch.adminCookie))
      .send({ status: 'published' });
    expect(reopenClosed.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// ④ 选课工作台
// ---------------------------------------------------------------------------

describe('选课工作台', () => {
  it('缺少必需配置时工作台给出阻塞原因与处理入口', async () => {
    const creditLimit = ctx.db.prepare("SELECT value FROM app_configs WHERE key = 'credit_limit_default'").get() as
      | { value: string }
      | undefined;
    ctx.db.prepare("DELETE FROM app_configs WHERE key = 'credit_limit_default'").run();
    try {
      const create = await request(ctx.app)
        .post('/api/admin/batches')
        .set(authHeader((await login(ctx.app, 'admin', 'admin123')).cookie))
        .send({ term: '2099-2100-1', name: `缺配置-${Date.now()}` });
      const batchId = create.body.data.id as number;
      const adminCookie = (await login(ctx.app, 'admin', 'admin123')).cookie;

      const view = await workbench(adminCookie, batchId);
      expect(view.stage.key).toBe('materials');
      expect(view.primaryAction?.key).toBe('open_preference');
      expect(view.primaryAction?.enabled).toBe(false);
      expect(view.primaryAction?.blockers.some((item) => item.code === 'BATCH_CONFIG_MISSING')).toBe(true);
      expect(view.todos.some((todo) => todo.key === 'config' && todo.severity === 'critical')).toBe(true);

      // 管理员实际点击“检查并开放预选”也会被后端拒绝，说明不是只隐藏了按钮
      const open = await runAction(adminCookie, batchId, 'open-preference', {
        closeAt: new Date(Date.now() + 86400_000).toISOString(),
      });
      expect(open.status).toBe(409);
      expect(open.body.error?.code).toBe('BATCH_CONFIG_MISSING');
    } finally {
      if (creditLimit) {
        ctx.db
          .prepare(
            `INSERT INTO app_configs (key, value, value_type, description, updated_at)
             VALUES ('credit_limit_default', ?, 'number', '学分上限', ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          )
          .run(creditLimit.value, nowIso());
      }
    }
  });

  it('预选进行中时能直接看到提交情况与未提交名单，且统计不受分页影响', async () => {
    const batch = await setupBatch(ctx, { name: '工作台统计' });
    const course = makeCourse('工作台统计课');
    const classId = makeClass(course, batch.term, 5, 9);
    const cookie = await studentCookie('20241007');
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);

    const view = await workbench(batch.adminCookie, batch.batchId);
    expect(view.stage.key).toBe('preference_open');
    expect(view.primaryAction?.key).toBe('close_submission');
    expect(view.stats.totalStudents).toBeGreaterThan(0);
    expect(view.stats.submittedStudents).toBe(1);
    expect(view.stats.notSubmittedStudents).toBe(view.stats.totalStudents - 1);

    // 设计稿需要的三块数据：五段进度、本轮准备情况、最近操作
    expect(view.steps.map((step) => step.key)).toEqual(['materials', 'preference', 'allocation', 'change', 'closed']);
    expect(view.steps.filter((step) => step.state === 'active')).toHaveLength(1);
    expect(view.steps.find((step) => step.state === 'active')?.key).toBe('preference');
    expect(view.checklist.map((item) => item.key)).toEqual(['classes', 'program', 'preallocation', 'guarantee']);
    expect(view.checklist.find((item) => item.key === 'classes')?.done).toBe(true);
    expect(Array.isArray(view.recentActivity)).toBe(true);

    const notSubmitted = await request(ctx.app)
      .get(`/api/admin/batches/${batch.batchId}/not-submitted?page=1&pageSize=5`)
      .set(authHeader(batch.adminCookie));
    expect(notSubmitted.status).toBe(200);
    expect(notSubmitted.body.data.total).toBe(view.stats.notSubmittedStudents);
    expect(notSubmitted.body.data.items.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 毕业保护名单：缺兜底授权的服务端统计
// ---------------------------------------------------------------------------

describe('毕业保护名单', () => {
  it('返回按“学生 × 课程”统计的缺兜底授权名单，不受前端分页影响', async () => {
    const batch = await setupBatch(ctx, { name: '兜底授权统计' });
    const course = makeCourse('兜底统计课');
    makeClass(course, batch.term, 5, 11);

    const confirm = await request(ctx.app)
      .post('/api/admin/guarantee')
      .set(authHeader(batch.adminCookie))
      .send({ batchId: batch.batchId, courseId: course, studentIds: [studentIdOf('20241008')], reason: '毕业必要课程' });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);

    const view = await request(ctx.app)
      .get(`/api/admin/guarantee?batchId=${batch.batchId}`)
      .set(authHeader(batch.adminCookie));
    expect(view.status).toBe(200);
    const gaps = view.body.data.authorizationGaps as {
      studentCount: number;
      courseCount: number;
      students: Array<{ studentNo: string; courses: string[] }>;
    };
    expect(gaps.studentCount).toBe(1);
    expect(gaps.courseCount).toBe(1);
    expect(gaps.students[0].studentNo).toBe('20241008');
    expect(gaps.students[0].courses).toContain('兜底统计课');
  });
});
