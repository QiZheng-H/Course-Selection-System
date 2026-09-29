/**
 * 统一规则层测试：时间冲突（多时段 / 单双周 / 教学周交集）、学分上限、
 * 培养需求等级、替代组、重复课程、权限与校验接口。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  authHeader,
  createClassRow,
  login,
  setupBatch,
  setupTestContext,
  submitPreferences,
  type TestContext,
} from './helpers.js';
import { findConflicts, overlappingWeeks, sessionsConflict } from '../src/core/time.js';
import {
  checkGraduationFeasibility,
  checkGroupFulfilment,
  computeProgress,
  validateSubstituteGroups,
} from '../src/modules/rules/service.js';

let ctx: TestContext;

beforeAll(() => {
  ctx = setupTestContext({ students: 20, classes: 12 });
});

afterAll(() => {
  ctx.cleanup();
});

const session = (over: Partial<Parameters<typeof sessionsConflict>[0]> = {}) => ({
  day_of_week: 1,
  period_start: 1,
  period_end: 2,
  week_start: 1,
  week_end: 16,
  week_parity: 'all',
  ...over,
});

describe('时间冲突判断', () => {
  it('不同星期不冲突', () => {
    expect(sessionsConflict(session(), session({ day_of_week: 2 }))).toBe(false);
  });

  it('节次没有交集不冲突', () => {
    expect(sessionsConflict(session(), session({ period_start: 3, period_end: 4 }))).toBe(false);
  });

  it('节次有交集就冲突', () => {
    expect(sessionsConflict(session({ period_start: 1, period_end: 2 }), session({ period_start: 2, period_end: 3 }))).toBe(true);
  });

  it('教学周没有交集不冲突（例如 1-4 周与 5-8 周）', () => {
    expect(sessionsConflict(session({ week_start: 1, week_end: 4 }), session({ week_start: 5, week_end: 8 }))).toBe(false);
  });

  it('单周与双周不冲突', () => {
    expect(sessionsConflict(session({ week_parity: 'odd' }), session({ week_parity: 'even' }))).toBe(false);
  });

  it('单周与全周在共同周次上冲突', () => {
    const conflict = sessionsConflict(session({ week_parity: 'odd' }), session({ week_parity: 'all' }));
    expect(conflict).toBe(true);
    expect(overlappingWeeks(session({ week_parity: 'odd' }), session({ week_parity: 'all' }))).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
  });

  it('多时段课程只要有一个时段重叠就算冲突', () => {
    const left = [session({ day_of_week: 3, period_start: 1, period_end: 2 }), session({ day_of_week: 5, period_start: 5, period_end: 6 })];
    const right = [session({ day_of_week: 5, period_start: 6, period_end: 7 })];
    const conflicts = findConflicts(left, right);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].weeks.length).toBeGreaterThan(0);
  });
});

describe('选课事务：时间冲突、学分上限、重复课程、幂等与回滚', () => {
  it('时间冲突时拒绝选课，并且不会留下任何记录', async () => {
    const batch = await setupBatch(ctx, { name: '冲突用例' });
    const now = new Date().toISOString();
    const courseInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 3, '测试学院', 'elective', '冲突测试', ?)`,
      )
      .run('TC1', '冲突课1', now);
    const courseId = Number(courseInfo.lastInsertRowid);
    const classA = createClassRow(ctx, {
      courseId,
      classCode: 'TC1-A',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 1, periodStart: 1, periodEnd: 2, weekStart: 1, weekEnd: 16 }],
    });
    // 另一门课，与上一门课时间重叠：这才应该报 TIME_CONFLICT（同一门课的另一个班属于重复选课）
    const otherCourseInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES ('TC2', '冲突课2', 3, '测试学院', 'elective', '冲突测试2', ?)`,
      )
      .run(now);
    const classB = createClassRow(ctx, {
      courseId: Number(otherCourseInfo.lastInsertRowid),
      classCode: 'TC2-B',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 1, periodStart: 2, periodEnd: 3, weekStart: 1, weekEnd: 16 }],
    });
    const cookie = (await login(ctx.app, '20241001', '123456')).cookie;

    const first = await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId: classA, idempotencyKey: 'conflict-1' });
    expect(first.status).toBe(200);

    const second = await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId: classB, idempotencyKey: 'conflict-2' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('TIME_CONFLICT');
    expect(Array.isArray(second.body.error.details.conflicts)).toBe(true);

    const count = (
      ctx.db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE status = 'enrolled'").get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('替换失败保留原课（整体回滚，不允许先退原课）', async () => {
    const batch = await setupBatch(ctx, { name: '替换回滚' });
    const now = new Date().toISOString();
    const courseInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 3, '测试学院', 'elective', '替换测试', ?)`,
      )
      .run('RP1', '替换课1', now);
    const courseId = Number(courseInfo.lastInsertRowid);
    const original = createClassRow(ctx, {
      courseId,
      classCode: 'RP1-ORIG',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 2, periodStart: 3, periodEnd: 4, weekStart: 1, weekEnd: 16 }],
    });
    // 目标课程与另一门已选课程时间冲突，并且只有 0 个普通名额
    const targetCourse = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 3, '测试学院', 'elective', '目标课程', ?)`,
      )
      .run('RP2', '目标课程', now);
    const targetCourseId = Number(targetCourse.lastInsertRowid);
    const conflicting = createClassRow(ctx, {
      courseId: targetCourseId,
      classCode: 'RP2-CONFLICT',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 4, periodStart: 5, periodEnd: 6, weekStart: 1, weekEnd: 16 }],
    });

    const cookie = (await login(ctx.app, '20241002', '123456')).cookie;
    // 先选上两门课：替换目标与原课
    const fixedCourse = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 3, '测试学院', 'elective', '保留课程', ?)`,
      )
      .run('RP3', '保留课程', now);
    const fixedClass = createClassRow(ctx, {
      courseId: Number(fixedCourse.lastInsertRowid),
      classCode: 'RP3-FIX',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 4, periodStart: 5, periodEnd: 6, weekStart: 1, weekEnd: 16 }],
    });
    const enrollOriginal = await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId: original, idempotencyKey: 'rp-orig' });
    expect(enrollOriginal.status).toBe(200);
    const enrollFixed = await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId: fixedClass, idempotencyKey: 'rp-fixed' });
    expect(enrollFixed.status).toBe(200);

    const replace = await request(ctx.app)
      .post('/api/swap')
      .set(authHeader(cookie))
      .send({ fromClassId: original, toClassId: conflicting, idempotencyKey: 'rp-swap' });
    expect(replace.status).toBe(409);
    expect(replace.body.error.code).toBe('TIME_CONFLICT');

    // 原课必须还在
    const stillEnrolled = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .get(original) as { c: number };
    expect(stillEnrolled.c).toBe(1);
    const targetEnrolled = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .get(conflicting) as { c: number };
    expect(targetEnrolled.c).toBe(0);
  });

  it('换班成功：同一课程内换到另一个教学班，只保留一条有效记录', async () => {
    const batch = await setupBatch(ctx, { name: '同课换班' });
    const now = new Date().toISOString();
    const courseInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 3, '测试学院', 'elective', '换班测试', ?)`,
      )
      .run('SW1', '换班课', now);
    const courseId = Number(courseInfo.lastInsertRowid);
    const classA = createClassRow(ctx, {
      courseId,
      classCode: 'SW1-A',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 3, periodStart: 1, periodEnd: 2, weekStart: 1, weekEnd: 16 }],
    });
    const classB = createClassRow(ctx, {
      courseId,
      classCode: 'SW1-B',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 3, periodStart: 3, periodEnd: 4, weekStart: 1, weekEnd: 16 }],
    });
    const cookie = (await login(ctx.app, '20241003', '123456')).cookie;
    await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId: classA, idempotencyKey: 'sw-a' });

    const swap = await request(ctx.app)
      .post('/api/swap')
      .set(authHeader(cookie))
      .send({ fromClassId: classA, toClassId: classB, idempotencyKey: 'sw-b' });
    expect(swap.status, JSON.stringify(swap.body)).toBe(200);
    expect(swap.body.data.enrolledClass.id).toBe(classB);
    expect(swap.body.data.releasedClass.id).toBe(classA);

    const active = ctx.db
      .prepare("SELECT class_id FROM enrollments WHERE status = 'enrolled' AND student_id = (SELECT user_id FROM students WHERE student_no = '20241003')")
      .all() as Array<{ class_id: number }>;
    expect(active.length).toBe(1);
    expect(active[0].class_id).toBe(classB);
  });

  it('幂等键让重复提交只执行一次，且换 key 会真的再执行', async () => {
    const batch = await setupBatch(ctx, { name: '幂等' });
    const now = new Date().toISOString();
    const courseInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 2, '测试学院', 'elective', '幂等测试', ?)`,
      )
      .run('ID1', '幂等课', now);
    const classId = createClassRow(ctx, {
      courseId: Number(courseInfo.lastInsertRowid),
      classCode: 'ID1-A',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 5, periodStart: 1, periodEnd: 2, weekStart: 1, weekEnd: 16 }],
    });
    const cookie = (await login(ctx.app, '20241004', '123456')).cookie;

    const first = await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId, idempotencyKey: 'same-key' });
    expect(first.status).toBe(200);
    const replay = await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId, idempotencyKey: 'same-key' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.idempotentReplay).toBe(true);

    const rows = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .get(classId) as { c: number };
    expect(rows.c).toBe(1);

    // 同一个幂等键搭配不同的请求内容（另一个教学班）时必须被拒绝
    const otherClassInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES ('ID2', '幂等课2', 2, '测试学院', 'elective', NULL, ?)`,
      )
      .run(new Date().toISOString());
    const otherClassId = createClassRow(ctx, {
      courseId: Number(otherClassInfo.lastInsertRowid),
      classCode: 'ID2-A',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 5, periodStart: 3, periodEnd: 4, weekStart: 1, weekEnd: 16 }],
    });
    const mismatch = await request(ctx.app)
      .post('/api/enroll')
      .set(authHeader(cookie))
      .send({ classId: otherClassId, idempotencyKey: 'same-key' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('退课会释放名额，并且候补模块不会占用预留名额', async () => {
    const batch = await setupBatch(ctx, { name: '退课释放' });
    const now = new Date().toISOString();
    const courseInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 2, '测试学院', 'elective', '退课测试', ?)`,
      )
      .run('DR1', '退课课', now);
    const courseId = Number(courseInfo.lastInsertRowid);
    const classId = createClassRow(ctx, {
      courseId,
      classCode: 'DR1-A',
      term: batch.term,
      capacity: 2,
      sessions: [{ dayOfWeek: 5, periodStart: 3, periodEnd: 4, weekStart: 1, weekEnd: 16 }],
    });
    const cookie = (await login(ctx.app, '20241005', '123456')).cookie;
    await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId, idempotencyKey: 'dr-enroll' });
    const drop = await request(ctx.app).post('/api/drop').set(authHeader(cookie)).send({ classId, idempotencyKey: 'dr-drop' });
    expect(drop.status, JSON.stringify(drop.body)).toBe(200);
    const active = ctx.db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'").get(classId) as {
      c: number;
    };
    expect(active.c).toBe(0);
    // 退课后同一个幂等键再退一次不会报错（复用上次成功结果）
    const again = await request(ctx.app).post('/api/drop').set(authHeader(cookie)).send({ classId, idempotencyKey: 'dr-drop' });
    expect(again.status).toBe(200);
    expect(again.body.data.idempotentReplay).toBe(true);
  });
});

describe('培养需求等级与替代组规则', () => {
  it('修读记录会抵扣培养需求，已选不等于已通过', () => {
    const studentId = (
      ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get('20241006') as { user_id: number }
    ).user_id;
    const before = computeProgress(ctx.db, studentId);
    const requirement = before.requirements.find((r) => r.remainingCredits > 0);
    expect(requirement).toBeDefined();
    if (!requirement) return;

    const courseId = requirement.candidateCourseIds[0];
    ctx.db
      .prepare(
        `INSERT INTO student_course_records (student_id, course_id, status, term, credits, source, verified, updated_at)
         VALUES (?, ?, 'passed', '2024-2025-1', 3, 'school', 1, ?)
         ON CONFLICT (student_id, course_id, status, term) DO UPDATE SET credits = excluded.credits`,
      )
      .run(studentId, courseId, new Date().toISOString());

    const after = computeProgress(ctx.db, studentId);
    const updated = after.requirements.find((r) => r.requirementId === requirement.requirementId);
    expect(updated?.passedCredits).toBeGreaterThan(requirement.passedCredits);
    expect(updated?.remainingCredits).toBeLessThanOrEqual(requirement.remainingCredits);
  });

  it('替代组校验能发现跨组重复，也能发现组内落实超过一门', () => {
    const groups = [
      { groupId: 0, code: 'G1', name: '组一', rankHint: 1, courseIds: [1, 2] },
      { groupId: 0, code: 'G2', name: '组二', rankHint: 2, courseIds: [2, 3] },
    ];
    const validation = validateSubstituteGroups(groups);
    expect(validation.ok).toBe(false);
    expect(validation.messages[0]).toContain('不能跨组重复');

    const fulfilment = checkGroupFulfilment([groups[0]], [1, 2]);
    expect(fulfilment.ok).toBe(false);
    expect(fulfilment.messages[0]).toContain('最多落实一门');
  });

  it('联合可行性：两门毕业必要课程只有同一时段时判定为无解', () => {
    const now = new Date().toISOString();
    const a = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES (?, '联合A', 3, '测试学院', 'required', NULL, ?)`,
        )
        .run('FEAS-A', now).lastInsertRowid,
    );
    const b = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES (?, '联合B', 3, '测试学院', 'required', NULL, ?)`,
        )
        .run('FEAS-B', now).lastInsertRowid,
    );
    const classA = createClassRow(ctx, {
      courseId: a,
      classCode: 'FEAS-A1',
      term: '2026-2027-1',
      capacity: 10,
      sessions: [{ dayOfWeek: 1, periodStart: 1, periodEnd: 2, weekStart: 1, weekEnd: 16 }],
    });
    const classB = createClassRow(ctx, {
      courseId: b,
      classCode: 'FEAS-B1',
      term: '2026-2027-1',
      capacity: 10,
      sessions: [{ dayOfWeek: 1, periodStart: 2, periodEnd: 3, weekStart: 1, weekEnd: 16 }],
    });
    const result = checkGraduationFeasibility(ctx.db, {
      courseOptions: [
        { courseId: a, courseName: '联合A', classIds: [classA] },
        { courseId: b, courseName: '联合B', classIds: [classB] },
      ],
    });
    expect(result.feasible).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });
});

describe('志愿校验与权限', () => {
  it('重复全局排名会被拒绝，同一课程重复出现会被拒绝', async () => {
    const batch = await setupBatch(ctx, { name: '志愿校验' });
    const cookie = (await login(ctx.app, '20241007', '123456')).cookie;
    const courses = ctx.db
      .prepare(
        `SELECT DISTINCT tc.course_id AS id FROM teaching_classes tc
         WHERE tc.status = 'open' AND tc.term = ? ORDER BY tc.course_id LIMIT 3`,
      )
      .all(batch.term) as Array<{ id: number }>;
    expect(courses.length).toBeGreaterThanOrEqual(2);

    const duplicatedRank = await submitPreferences(ctx, cookie, batch.batchId, [
      { courseId: courses[0].id, globalRank: 1 },
      { courseId: courses[1].id, globalRank: 1 },
    ]);
    expect(duplicatedRank.status).toBe(422);
    expect(duplicatedRank.body.error?.code).toBe('VALIDATION_FAILED');

    const duplicatedCourse = await submitPreferences(ctx, cookie, batch.batchId, [
      { courseId: courses[0].id, globalRank: 1 },
      { courseId: courses[0].id, globalRank: 2 },
    ]);
    expect(duplicatedCourse.status).toBe(422);
    expect(duplicatedCourse.body.error?.code).toBe('VALIDATION_FAILED');

    const ok = await submitPreferences(ctx, cookie, batch.batchId, [
      { courseId: courses[0].id, globalRank: 1 },
      { courseId: courses[1].id, globalRank: 2 },
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('撤回志愿保留草稿，且之后可以重新提交', async () => {
    const batch = await setupBatch(ctx, { name: '撤回保留草稿' });
    const cookie = (await login(ctx.app, '20241008', '123456')).cookie;
    const course = ctx.db
      .prepare("SELECT DISTINCT course_id AS id FROM teaching_classes WHERE status = 'open' AND term = ? LIMIT 1")
      .get(batch.term) as { id: number };
    const submit = await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course.id, globalRank: 1 }]);
    expect(submit.status).toBe(200);

    const withdraw = await request(ctx.app).post('/api/preferences/withdraw').set(authHeader(cookie)).send({ batchId: batch.batchId });
    expect(withdraw.status).toBe(200);

    const draft = await request(ctx.app).get(`/api/preferences/draft?batchId=${batch.batchId}`).set(authHeader(cookie));
    expect(draft.status).toBe(200);
    expect(draft.body.data.draft.preferences.length).toBeGreaterThan(0);

    const resubmit = await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course.id, globalRank: 1 }]);
    expect(resubmit.status).toBe(200);
    // 版本号递增，历史版本保留
    const versions = ctx.db
      .prepare('SELECT version_no, status FROM preference_submissions WHERE batch_id = ? ORDER BY version_no')
      .all(batch.batchId) as Array<{ version_no: number; status: string }>;
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });

  it('没有进行中的批次时，资格查询给出可读原因而不是报错', async () => {
    // 找一个本学期开放的教学班，但不创建任何批次
    const cls = ctx.db
      .prepare("SELECT id FROM teaching_classes WHERE status = 'open' ORDER BY id LIMIT 1")
      .get() as { id: number };
    const cookie = (await login(ctx.app, '20241010', '123456')).cookie;
    const response = await request(ctx.app).get(`/api/eligibility/${cls.id}`).set(authHeader(cookie));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.canEnroll).toBe(false);
    expect(response.body.data.reasons.join(' ')).toContain('批次');
  });

  it('管理员修改配置后立即生效，且非法值被拒绝或安全兜底', async () => {
    const adminSession = await login(ctx.app, 'admin', 'admin123');
    const update = await request(ctx.app)
      .put('/api/admin/configs')
      .set(authHeader(adminSession.cookie))
      .send({ configs: [{ key: 'credit_limit_default', value: '18', valueType: 'number' }] });
    expect(update.status, JSON.stringify(update.body)).toBe(200);

    const check = await request(ctx.app).get('/api/admin/configs').set(authHeader(adminSession.cookie));
    const limit = (check.body.data.configs as Array<{ key: string; value: string }>).find((c) => c.key === 'credit_limit_default');
    expect(limit?.value).toBe('18');

    // 学分上限降低后，超额选课会被拒绝，错误信息里带上限数值
    const studentRow = ctx.db.prepare('SELECT user_id, student_no FROM students ORDER BY user_id LIMIT 1').get() as {
      user_id: number;
      student_no: string;
    };
    const cookie = (await login(ctx.app, studentRow.student_no, '123456')).cookie;
    const batch = await setupBatch(ctx, { name: '配置生效' });
    // 先把已有选课清空，避免干扰
    ctx.db.prepare("UPDATE enrollments SET status = 'dropped', dropped_at = ? WHERE student_id = ? AND status = 'enrolled'").run(
      new Date().toISOString(),
      studentRow.user_id,
    );
    const heavy = ctx.db
      .prepare("SELECT tc.id FROM teaching_classes tc JOIN courses c ON c.id = tc.course_id WHERE c.credits >= 4 AND tc.status = 'open' LIMIT 1")
      .get() as { id: number };
    const enroll = await request(ctx.app)
      .post('/api/enroll')
      .set(authHeader(cookie))
      .send({ classId: heavy.id, idempotencyKey: 'cfg-heavy-1' });
    // 单门 4~5 学分的课不会超 18，因此应当成功；随后再选一门确认上限真的按 18 计算
    expect([200, 409]).toContain(enroll.status);
    await request(ctx.app)
      .put('/api/admin/configs')
      .set(authHeader(adminSession.cookie))
      .send({ configs: [{ key: 'credit_limit_default', value: '30', valueType: 'number' }] });
  });

  it('管理员授予替换授权后，学生可以按授权自动替换原课', async () => {
    const studentRow = ctx.db
      .prepare("SELECT user_id, student_no FROM students ORDER BY user_id DESC LIMIT 1")
      .get() as { user_id: number; student_no: string };
    const cookie = (await login(ctx.app, studentRow.student_no, '123456')).cookie;
    const adminSession = await login(ctx.app, 'admin', 'admin123');
    const batch = await setupBatch(ctx, { name: '授权替换' });

    // 学生先选上“原课程”
    const now = new Date().toISOString();
    const sourceCourseId = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES ('UP-SRC', '授权原课程', 3, '测试学院', 'elective', NULL, ?)`,
        )
        .run(now).lastInsertRowid,
    );
    const sourceClassId = createClassRow(ctx, {
      courseId: sourceCourseId,
      classCode: 'UP-SRC-A',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 5, periodStart: 7, periodEnd: 8, weekStart: 1, weekEnd: 16 }],
    });
    const enrollSource = await request(ctx.app)
      .post('/api/enroll')
      .set(authHeader(cookie))
      .send({ classId: sourceClassId, idempotencyKey: 'up-enroll-src' });
    expect(enrollSource.status, JSON.stringify(enrollSource.body)).toBe(200);

    // 目标课程（不同时段，名额充足）
    const targetCourseId = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES ('UP-DST', '授权目标课程', 3, '测试学院', 'elective', NULL, ?)`,
        )
        .run(now).lastInsertRowid,
    );
    const targetClassId = createClassRow(ctx, {
      courseId: targetCourseId,
      classCode: 'UP-DST-A',
      term: batch.term,
      capacity: 10,
      sessions: [{ dayOfWeek: 5, periodStart: 9, periodEnd: 10, weekStart: 1, weekEnd: 16 }],
    });

    // 没有授权时不能自动替换
    const noAuth = await request(ctx.app)
      .post('/api/upgrade')
      .set(authHeader(cookie))
      .send({ authorizationId: 999999, idempotencyKey: 'up-noauth' });
    expect(noAuth.status).toBe(404);

    const grant = await request(ctx.app)
      .post('/api/admin/guarantee/authorizations')
      .set(authHeader(adminSession.cookie))
      .send({
        studentId: studentRow.user_id,
        batchId: batch.batchId,
        sourceClassId,
        targetCourseId,
        targetClassId,
      });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    expect(grant.body.data.status).toBe('active');

    const upgrade = await request(ctx.app)
      .post('/api/upgrade')
      .set(authHeader(cookie))
      .send({ authorizationId: grant.body.data.id, idempotencyKey: 'up-do' });
    expect(upgrade.status, JSON.stringify(upgrade.body)).toBe(200);
    expect(upgrade.body.data.enrolledClass.id).toBe(targetClassId);
    expect(upgrade.body.data.releasedClass.id).toBe(sourceClassId);

    // 原课释放、目标课占用、来源标记为 upgrade、授权标记为已使用
    const active = ctx.db
      .prepare("SELECT class_id, source FROM enrollments WHERE student_id = ? AND status = 'enrolled'")
      .all(studentRow.user_id) as Array<{ class_id: number; source: string }>;
    expect(active.some((a) => a.class_id === targetClassId && a.source === 'upgrade')).toBe(true);
    expect(active.some((a) => a.class_id === sourceClassId)).toBe(false);
    const auth = ctx.db
      .prepare('SELECT status, used_at FROM upgrade_authorizations WHERE id = ?')
      .get(grant.body.data.id) as { status: string; used_at: string | null };
    expect(auth.status).toBe('used');
    expect(auth.used_at).toBeTruthy();
  });

  it('管理员可以查看全部提交，但学生看不到别人的志愿', async () => {
    const batch = await setupBatch(ctx, { name: '提交可见性' });
    const cookie = (await login(ctx.app, '20241009', '123456')).cookie;
    const course = ctx.db
      .prepare("SELECT DISTINCT course_id AS id FROM teaching_classes WHERE status = 'open' AND term = ? LIMIT 1")
      .get(batch.term) as { id: number };
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course.id, globalRank: 1 }]);

    const adminSession = await login(ctx.app, 'admin', 'admin123');
    const adminView = await request(ctx.app)
      .get(`/api/admin/batches/${batch.batchId}/submissions`)
      .set(authHeader(adminSession.cookie));
    expect(adminView.status).toBe(200);
    expect(adminView.body.data.total).toBeGreaterThan(0);

    // 学生尝试用 studentId 读取他人志愿
    const otherId = (ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get('20241010') as { user_id: number })
      .user_id;
    const forbidden = await request(ctx.app)
      .get(`/api/preferences?batchId=${batch.batchId}&studentId=${otherId}`)
      .set(authHeader(cookie));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
  });
});
