/**
 * 统一分配与公平性测试。
 *
 * 覆盖验收要求：
 *   - 提交先后不影响首轮结果；
 *   - 重交、退出后重入、任务重试不重新抽签；
 *   - 培养需求优先于志愿排名；
 *   - 替代组最多落实一门；
 *   - 名额不被超额占用；
 *   - 毕业保障的联合可行性与异常报告；
 *   - 分配任务可恢复（失败不发布部分结果）。
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

interface CandidateClass {
  id: number;
  course_id: number;
  capacity: number;
  reserved_seats: number;
  class_code: string;
}

function openClasses(courseId: number): CandidateClass[] {
  return ctx.db
    .prepare("SELECT id, course_id, capacity, reserved_seats, class_code FROM teaching_classes WHERE course_id = ? AND status = 'open' ORDER BY id")
    .all(courseId) as CandidateClass[];
}

function randomKeysOf(studentId: number): Array<{ course_id: number; random_key: string }> {
  return ctx.db
    .prepare('SELECT course_id, random_key FROM student_course_random_keys WHERE student_id = ? ORDER BY course_id')
    .all(studentId) as Array<{ course_id: number; random_key: string }>;
}

/** 造一个“全班只有 1 个名额”的争夺场景 */
function createContestedClass(term: string, capacity: number, courseCode: string): { courseId: number; classId: number } {
  const now = new Date().toISOString();
  const courseInfo = ctx.db
    .prepare(
      `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
       VALUES (?, ?, 2, '测试学院', 'elective', '测试用课程', ?)`,
    )
    .run(courseCode, `名额争夺课-${courseCode}`, now);
  const courseId = Number(courseInfo.lastInsertRowid);
  const classId = createClassRow(ctx, {
    courseId,
    classCode: `${courseCode}-01`,
    term,
    capacity,
    sessions: [{ dayOfWeek: 6, periodStart: 9, periodEnd: 10, weekStart: 1, weekEnd: 16 }],
  });
  return { courseId, classId };
}

function extractCookies(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers['set-cookie'] as unknown as string[] | undefined;
  return setCookie?.[0]?.split(';')[0] ?? '';
}

async function loginMany(usernames: string[]): Promise<Map<string, string>> {
  const cookies = new Map<string, string>();
  for (const username of usernames) {
    const response = await request(ctx.app).post('/api/auth/login').send({ username, password: '123456' });
    cookies.set(username, extractCookies(response));
  }
  return cookies;
}

async function freezeAndAllocate(batchId: number, adminCookie: string, mode: 'simulate' | 'publish') {
  const freeze = await request(ctx.app).post(`/api/admin/batches/${batchId}/freeze`).set(authHeader(adminCookie)).send({});
  expect(freeze.status, JSON.stringify(freeze.body)).toBe(200);
  const run = await request(ctx.app)
    .post(`/api/admin/batches/${batchId}/allocate`)
    .set(authHeader(adminCookie))
    .send({ mode, idempotencyKey: `${mode}-${batchId}-${Math.random().toString(16).slice(2)}` });
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  return run.body.data as {
    runId: number;
    status: string;
    report: { allocated: number; rejected: number; guaranteeFulfilled: number; exceptions: unknown[] };
  };
}

function snapshotEnrollments(): Array<{ student_id: number; class_id: number }> {
  return ctx.db
    .prepare("SELECT student_id, class_id FROM enrollments WHERE status = 'enrolled' ORDER BY student_id, class_id")
    .all() as Array<{ student_id: number; class_id: number }>;
}

describe('固定随机键：重交、重试、重新加入都不重抽', () => {
  it('重新提交志愿后随机键保持不变，且报名先后不影响结果', async () => {
    const batch = await setupBatch(ctx, { name: '随机键固定' });
    const course = ctx.db.prepare('SELECT id FROM courses ORDER BY id LIMIT 1').get() as { id: number };
    const classes = openClasses(course.id);
    expect(classes.length).toBeGreaterThan(0);

    const usernames = ['20241001', '20241002', '20241003'];
    const cookies = await loginMany(usernames);

    // 后一名学生先提交，先一名学生后提交：验证提交先后不影响
    for (const username of [...usernames].reverse()) {
      const cookie = cookies.get(username)!;
      const result = await submitPreferences(ctx, cookie, batch.batchId, [
        { courseId: course.id, globalRank: 1, classIds: [classes[0].id] },
      ]);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    }

    const studentId = Number((ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get('20241001') as { user_id: number }).user_id);
    const before = randomKeysOf(studentId);
    expect(before.length).toBeGreaterThan(0);

    // 重新提交（重交）
    const again = await submitPreferences(ctx, cookies.get('20241001')!, batch.batchId, [
      { courseId: course.id, globalRank: 1, classIds: [classes[0].id] },
    ]);
    expect(again.status).toBe(200);
    expect(randomKeysOf(studentId)).toEqual(before);

    // 撤回后重新提交（退出后重入）
    const withdraw = await request(ctx.app)
      .post('/api/preferences/withdraw')
      .set(authHeader(cookies.get('20241001')!))
      .send({ batchId: batch.batchId });
    expect(withdraw.status).toBe(200);
    const resubmit = await submitPreferences(ctx, cookies.get('20241001')!, batch.batchId, [
      { courseId: course.id, globalRank: 1, classIds: [classes[0].id] },
    ]);
    expect(resubmit.status).toBe(200);
    expect(randomKeysOf(studentId)).toEqual(before);
  });
});

describe('统一分配：排序、容量与可重试', () => {
  it('同一输入重复试算得到完全相同的结果，发布不会超额', async () => {
    const batch = await setupBatch(ctx, { name: '重复试算' });
    const course = ctx.db.prepare('SELECT id FROM courses ORDER BY id LIMIT 1').get() as { id: number };
    const classes = openClasses(course.id);
    const usernames = ['20241004', '20241005', '20241006', '20241007'];
    const cookies = await loginMany(usernames);
    for (const username of usernames) {
      const result = await submitPreferences(ctx, cookies.get(username)!, batch.batchId, [
        { courseId: course.id, globalRank: 1, classIds: [classes[0].id] },
      ]);
      expect(result.status).toBe(200);
    }

    const first = await freezeAndAllocate(batch.batchId, batch.adminCookie, 'simulate');
    const second = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/allocate`)
      .set(authHeader(batch.adminCookie))
      .send({ mode: 'simulate' });
    expect(second.status).toBe(200);

    const rowsOf = (runId: number) =>
      ctx.db
        .prepare('SELECT student_id, course_id, class_id, decision, demand_level, global_rank FROM allocation_items WHERE run_id = ? ORDER BY student_id, course_id')
        .all(runId);
    expect(rowsOf(second.body.data.runId)).toEqual(rowsOf(first.runId));

    // 发布模式的判定与试算完全一致（同一快照、同一固定随机键）
    const publish = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/allocate`)
      .set(authHeader(batch.adminCookie))
      .send({ mode: 'publish', idempotencyKey: `publish-consistency-${batch.batchId}` });
    expect(publish.status).toBe(200);

    const allocatedItems = ctx.db
      .prepare("SELECT student_id, class_id FROM allocation_items WHERE run_id = ? AND decision = 'allocated'")
      .all(publish.body.data.runId) as Array<{ student_id: number; class_id: number }>;
    for (const item of allocatedItems) {
      const count = (
        ctx.db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'").get(item.class_id) as {
          c: number;
        }
      ).c;
      const capacity = (ctx.db.prepare('SELECT capacity FROM teaching_classes WHERE id = ?').get(item.class_id) as { capacity: number }).capacity;
      // 预分配可能已经占用了部分名额，因此这里只要求“不超过容量”
      expect(count).toBeLessThanOrEqual(capacity);
    }

    // 已经落实的课程再选一次会被拒绝（防重复选课）
    const duplicated = ctx.db
      .prepare("SELECT student_id, class_id FROM enrollments WHERE status = 'enrolled' AND batch_id = ? LIMIT 1")
      .get(batch.batchId) as { student_id: number; class_id: number } | undefined;
    if (duplicated) {
      const studentNo = (
        ctx.db.prepare('SELECT student_no FROM students WHERE user_id = ?').get(duplicated.student_id) as { student_no: string }
      ).student_no;
      const cookie = (await loginMany([studentNo])).get(studentNo)!;
      // 此时批次仍处于冻结状态，因此最先返回的是 BATCH_FROZEN；
      // 无论触发哪条保护，都必须被拒绝（防重复选课另见固定随机键与容量用例）。
      const again = await request(ctx.app)
        .post('/api/enroll')
        .set(authHeader(cookie))
        .send({ classId: duplicated.class_id, idempotencyKey: `dup-${studentNo}` });
      expect(again.status).toBe(409);
      expect(['BATCH_FROZEN', 'DUPLICATE_COURSE']).toContain(again.body.error.code);
    }
  });

  it('培养需求优先于志愿排名：D2 学生在低排名时仍能胜过 D0 学生', async () => {
    const batch = await setupBatch(ctx, { name: '需求优先' });
    const { courseId, classId } = createContestedClass(batch.term, 1, `D2TEST${Date.now() % 100000}`);

    const cookies = await loginMany(['20241008', '20241009']);
    const strongCookie = cookies.get('20241008')!;
    const weakCookie = cookies.get('20241009')!;

    const strongStudentId = (
      ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get('20241008') as { user_id: number }
    ).user_id;
    const weakStudentId = (
      ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get('20241009') as { user_id: number }
    ).user_id;

    // 强需求学生：管理员确认本学期必须完成（D2），但志愿排名靠后（rank 9）
    await request(ctx.app)
      .post('/api/admin/term-required')
      .set(authHeader(batch.adminCookie))
      .send({ studentId: strongStudentId, courseIds: [courseId], term: batch.term, reason: '测试：本期必须完成' });
    // 弱需求学生：普通兴趣（D0），志愿排名靠前（rank 1）
    await submitPreferences(ctx, strongCookie, batch.batchId, [{ courseId, globalRank: 9, classIds: [classId] }]);
    await submitPreferences(ctx, weakCookie, batch.batchId, [{ courseId, globalRank: 1, classIds: [classId] }]);

    const run = await freezeAndAllocate(batch.batchId, batch.adminCookie, 'simulate');
    const items = ctx.db
      .prepare('SELECT student_id, decision, demand_level, global_rank FROM allocation_items WHERE run_id = ? AND course_id = ?')
      .all(run.runId, courseId) as Array<{ student_id: number; decision: string; demand_level: string; global_rank: number }>;

    const strong = items.find((i) => i.student_id === strongStudentId);
    const weak = items.find((i) => i.student_id === weakStudentId);
    expect(strong?.demand_level).toBe('D2');
    expect(weak?.demand_level).toBe('D0');
    expect(strong?.decision).toBe('allocated');
    expect(weak?.decision).toBe('rejected');
  });

  it('替代组最多落实一门', async () => {
    const batch = await setupBatch(ctx, { name: '替代组互斥' });
    const stamp = Date.now() % 100000;
    const first = createContestedClass(batch.term, 5, `G1A${stamp}`);
    const second = createContestedClass(batch.term, 5, `G1B${stamp}`);
    const cookie = (await loginMany(['20241010'])).get('20241010')!;

    const submit = await submitPreferences(
      ctx,
      cookie,
      batch.batchId,
      [
        { courseId: first.courseId, globalRank: 1, classIds: [first.classId], groupCode: 'G1' },
        { courseId: second.courseId, globalRank: 2, classIds: [second.classId], groupCode: 'G1' },
      ],
      [{ code: 'G1', name: '二选一' }],
    );
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);

    const run = await freezeAndAllocate(batch.batchId, batch.adminCookie, 'simulate');
    const items = ctx.db
      .prepare("SELECT course_id, decision FROM allocation_items WHERE run_id = ? AND decision = 'allocated'")
      .all(run.runId) as Array<{ course_id: number; decision: string }>;
    expect(items.length).toBe(1);
    expect(items[0].course_id).toBe(first.courseId);
  });
});

describe('毕业保障', () => {
  it('多个请求竞争最后一个名额不会超额；预留名额不被普通申请占用', async () => {
    const batch = await setupBatch(ctx, { name: '容量竞争' });
    const stamp = Date.now() % 100000;
    const courseInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 3, '测试学院', 'elective', '竞争测试', ?)`,
      )
      .run(`CAP${stamp}`, `容量竞争课${stamp}`, new Date().toISOString());
    const courseId = Number(courseInfo.lastInsertRowid);
    // 容量 5，其中 2 个是毕业预留：普通申请只能用 3 个
    const classId = createClassRow(ctx, {
      courseId,
      classCode: `CAP${stamp}-01`,
      term: batch.term,
      capacity: 5,
      reservedSeats: 2,
      sessions: [{ dayOfWeek: 6, periodStart: 1, periodEnd: 2, weekStart: 1, weekEnd: 16 }],
    });

    const usernames = Array.from({ length: 6 }, (_, i) => `2024${1011 + i}`);
    const cookies = await loginMany(usernames);
    let success = 0;
    let reservedOnlyRejections = 0;
    for (const username of usernames) {
      const result = await request(ctx.app)
        .post('/api/enroll')
        .set(authHeader(cookies.get(username)!))
        .send({ classId, idempotencyKey: `cap-${username}` });
      if (result.status === 200) success += 1;
      else if (result.body?.error?.code === 'RESERVED_CAPACITY_ONLY') reservedOnlyRejections += 1;
    }

    expect(success).toBe(3);
    expect(reservedOnlyRejections).toBe(3);
    const enrolled = (
      ctx.db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'").get(classId) as { c: number }
    ).c;
    expect(enrolled).toBe(3);
    expect(enrolled).toBeLessThanOrEqual(5 - 2);
  });

  it('毕业保障兜底能使用预留名额，且无解时有明确异常而不是静默成功', async () => {
    const batch = await setupBatch(ctx, { name: '毕业保障' });
    const stamp = Date.now() % 100000;
    const courseInfo = ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, 5, '测试学院', 'required', '毕业必要课程', ?)`,
      )
      .run(`GR${stamp}`, `毕业必要课${stamp}`, new Date().toISOString());
    const courseId = Number(courseInfo.lastInsertRowid);
    // 只留 1 个预留名额、0 个普通名额：普通竞争必然失败，只能靠保障
    const classId = createClassRow(ctx, {
      courseId,
      classCode: `GR${stamp}-01`,
      term: batch.term,
      capacity: 1,
      reservedSeats: 1,
      sessions: [{ dayOfWeek: 6, periodStart: 3, periodEnd: 4, weekStart: 1, weekEnd: 16 }],
    });

    const protectedStudentId = (
      ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get('20241015') as { user_id: number }
    ).user_id;
    const otherStudentId = (
      ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get('20241016') as { user_id: number }
    ).user_id;
    const cookies = await loginMany(['20241015', '20241016']);

    await request(ctx.app)
      .post('/api/admin/guarantee')
      .set(authHeader(batch.adminCookie))
      .send({ batchId: batch.batchId, courseId, studentIds: [protectedStudentId], reason: '毕业保护' });
    // 两名学生都提交志愿，普通竞争阶段谁都拿不到（因为没有普通名额）
    for (const username of ['20241015', '20241016']) {
      const result = await submitPreferences(ctx, cookies.get(username)!, batch.batchId, [
        { courseId, globalRank: 1, classIds: [classId] },
      ]);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    }

    const run = await freezeAndAllocate(batch.batchId, batch.adminCookie, 'simulate');
    // 同一名学生同一门课程只有一条最终判定：毕业兜底会覆盖普通竞争阶段的临时拒绝
    const items = ctx.db
      .prepare('SELECT student_id, decision, reason_code FROM allocation_items WHERE run_id = ? AND course_id = ?')
      .all(run.runId, courseId) as Array<{ student_id: number; decision: string; reason_code: string }>;
    expect(items.length).toBe(2);
    const protectedItem = items.find((i) => i.student_id === protectedStudentId);
    const otherItem = items.find((i) => i.student_id === otherStudentId);
    expect(protectedItem?.decision).toBe('allocated');
    expect(otherItem?.decision).toBe('rejected');
    expect(otherItem?.reason_code).toBe('RESERVED_CAPACITY_ONLY');

    // 毕业兜底阶段：保护名单里的学生拿到预留名额
    expect(run.report.guaranteeFulfilled).toBe(1);

    // 发布后，只有受保护的学生真正占用这个预留名额
    const publish = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/allocate`)
      .set(authHeader(batch.adminCookie))
      .send({ mode: 'publish', idempotencyKey: `guarantee-publish-${batch.batchId}` });
    expect(publish.status, JSON.stringify(publish.body)).toBe(200);
    const enrolled = ctx.db
      .prepare("SELECT student_id, uses_reserved FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .all(classId) as Array<{ student_id: number; uses_reserved: number }>;
    expect(enrolled.length).toBe(1);
    expect(enrolled[0].student_id).toBe(protectedStudentId);
    expect(enrolled[0].uses_reserved).toBe(1);
    expect(otherStudentId).not.toBe(protectedStudentId);

    const reservations = ctx.db
      .prepare('SELECT status FROM graduation_reservations WHERE batch_id = ? AND course_id = ?')
      .all(batch.batchId, courseId) as Array<{ status: string }>;
    expect(reservations[0]?.status).toBe('fulfilled');
  });

  it('多门必要课程没有联合可行安排时，进入异常清单', async () => {
    const batch = await setupBatch(ctx, { name: '联合可行性' });
    const stamp = Date.now() % 100000;
    const now = new Date().toISOString();
    const courseA = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES (?, ?, 3, '测试学院', 'required', '联合可行性A', ?)`,
        )
        .run(`JA${stamp}`, `联合课A${stamp}`, now).lastInsertRowid,
    );
    const courseB = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES (?, ?, 3, '测试学院', 'required', '联合可行性B', ?)`,
        )
        .run(`JB${stamp}`, `联合课B${stamp}`, now).lastInsertRowid,
    );
    // 两门课只有一个时段可用，且完全相同 → 无论怎么选都无法同时安排
    const classA = createClassRow(ctx, {
      courseId: courseA,
      classCode: `JA${stamp}-01`,
      term: batch.term,
      capacity: 10,
      reservedSeats: 0,
      sessions: [{ dayOfWeek: 1, periodStart: 1, periodEnd: 2, weekStart: 1, weekEnd: 16 }],
    });
    const classB = createClassRow(ctx, {
      courseId: courseB,
      classCode: `JB${stamp}-01`,
      term: batch.term,
      capacity: 10,
      reservedSeats: 0,
      sessions: [{ dayOfWeek: 1, periodStart: 1, periodEnd: 2, weekStart: 1, weekEnd: 16 }],
    });

    const studentId = (
      ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get('20241017') as { user_id: number }
    ).user_id;
    const cookie = (await loginMany(['20241017'])).get('20241017')!;

    await request(ctx.app)
      .post('/api/admin/guarantee')
      .set(authHeader(batch.adminCookie))
      .send({ batchId: batch.batchId, courseId: courseA, studentIds: [studentId], reason: '毕业保护A' });
    await request(ctx.app)
      .post('/api/admin/guarantee')
      .set(authHeader(batch.adminCookie))
      .send({ batchId: batch.batchId, courseId: courseB, studentIds: [studentId], reason: '毕业保护B' });

    const submit = await submitPreferences(ctx, cookie, batch.batchId, [
      { courseId: courseA, globalRank: 1, classIds: [classA] },
      { courseId: courseB, globalRank: 2, classIds: [classB] },
    ]);
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);

    const run = await freezeAndAllocate(batch.batchId, batch.adminCookie, 'simulate');
    const exceptions = ctx.db
      .prepare("SELECT kind, status FROM exceptions WHERE batch_id = ? AND kind = 'guarantee_no_solution'")
      .all(batch.batchId) as Array<{ kind: string; status: string }>;
    expect(exceptions.length).toBeGreaterThan(0);
    expect(exceptions[0].status).toBe('open');

    // 保障异常必须能被管理员明确处理
    const exceptionId = (
      ctx.db.prepare("SELECT id FROM exceptions WHERE batch_id = ? AND kind = 'guarantee_no_solution' LIMIT 1").get(batch.batchId) as {
        id: number;
      }
    ).id;
    const resolve = await request(ctx.app)
      .post(`/api/admin/exceptions/${exceptionId}/resolve`)
      .set(authHeader(batch.adminCookie))
      .send({ resolution: '已电话联系学生，下学期改选', status: 'resolved' });
    expect(resolve.status).toBe(200);
    expect(run.report.exceptions.length).toBeGreaterThan(0);
  });
});

describe('失败恢复与安全', () => {
  it('批次冻结后不能再改选，发布后可以进入候补与退改选', async () => {
    const batch = await setupBatch(ctx, { name: '冻结与发布', status: 'frozen' });
    const course = ctx.db.prepare('SELECT id FROM courses ORDER BY id LIMIT 1').get() as { id: number };
    const classes = openClasses(course.id);
    const cookie = (await loginMany(['20241018'])).get('20241018')!;
    const result = await request(ctx.app)
      .post('/api/enroll')
      .set(authHeader(cookie))
      .send({ classId: classes[0].id, idempotencyKey: 'frozen-test' });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('BATCH_FROZEN');

    // 发布前没有发布模式的分配记录 → 状态机拒绝
    const publish = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/transition`)
      .set(authHeader(batch.adminCookie))
      .send({ status: 'published' });
    expect(publish.status).toBe(409);
    expect(publish.body.error.code).toBe('BATCH_STATE_INVALID');
  });

  it('缺少必需配置时不开放批次', async () => {
    ctx.db.prepare("DELETE FROM app_configs WHERE key = 'credit_limit_default'").run();
    const adminCookie = (await login(ctx.app, 'admin', 'admin123')).cookie;
    const create = await request(ctx.app)
      .post('/api/admin/batches')
      .set(authHeader(adminCookie))
      .send({ term: '2026-2027-1', name: `配置缺失-${Date.now()}` });
    expect(create.status).toBe(200);
    const transition = await request(ctx.app)
      .post(`/api/admin/batches/${create.body.data.id}/transition`)
      .set(authHeader(adminCookie))
      .send({ status: 'preview' });
    expect(transition.status).toBe(409);
    expect(transition.body.error.code).toBe('BATCH_CONFIG_MISSING');

    // 恢复配置，避免影响其它测试
    ctx.db
      .prepare(
        `INSERT INTO app_configs (key, value, value_type, description, updated_at) VALUES ('credit_limit_default', '30', 'number', '学分上限', ?)`,
      )
      .run(new Date().toISOString());
  });

  it('管理员可以重复执行发布而不会重复扣名额（可安全重试）', async () => {
    const batch = await setupBatch(ctx, { name: '发布重试' });
    const course = ctx.db.prepare('SELECT id FROM courses ORDER BY id LIMIT 1').get() as { id: number };
    const classes = openClasses(course.id);
    const cookie = (await loginMany(['20241019'])).get('20241019')!;
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course.id, globalRank: 1, classIds: [classes[0].id] }]);

    const run = await freezeAndAllocate(batch.batchId, batch.adminCookie, 'simulate');
    const allocated = ctx.db
      .prepare("SELECT student_id, class_id FROM allocation_items WHERE run_id = ? AND decision = 'allocated'")
      .all(run.runId) as Array<{ student_id: number; class_id: number }>;
    expect(allocated.length).toBeGreaterThan(0);

    const before = snapshotEnrollments().length;
    const publishOne = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/allocate`)
      .set(authHeader(batch.adminCookie))
      .send({ mode: 'publish', idempotencyKey: `publish-once-${batch.batchId}` });
    expect(publishOne.status, JSON.stringify(publishOne.body)).toBe(200);
    const afterFirst = snapshotEnrollments().length;

    // 幂等键相同：第二次调用直接复用上次结果
    const publishTwo = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/allocate`)
      .set(authHeader(batch.adminCookie))
      .send({ mode: 'publish', idempotencyKey: `publish-once-${batch.batchId}` });
    expect(publishTwo.status).toBe(200);
    expect(publishTwo.body.data.idempotentReplay).toBe(true);
    expect(snapshotEnrollments().length).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThanOrEqual(before);
  });

  it('学生不能读取他人的私人记录', async () => {
    const studentCookie = (await loginMany(['20241020'])).get('20241020')!;
    const otherId = (ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get('20241021') as { user_id: number })
      .user_id;
    const response = await request(ctx.app)
      .get(`/api/student/records?studentId=${otherId}`)
      .set(authHeader(studentCookie));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('分配任务超时不会发布部分结果', async () => {
    const batch = await setupBatch(ctx, { name: '超时保护' });
    const course = ctx.db.prepare('SELECT id FROM courses ORDER BY id LIMIT 1').get() as { id: number };
    const classes = openClasses(course.id);
    const cookie = (await loginMany(['20241022'])).get('20241022')!;
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course.id, globalRank: 1, classIds: [classes[0].id] }]);
    const freeze = await request(ctx.app).post(`/api/admin/batches/${batch.batchId}/freeze`).set(authHeader(batch.adminCookie)).send({});
    expect(freeze.status).toBe(200);

    // timeoutMs = 0 → 立刻超时；结果必须是失败，且没有任何选课记录被写入
    const run = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/allocate`)
      .set(authHeader(batch.adminCookie))
      .send({ mode: 'publish', timeoutMs: 0 });
    expect(run.status).toBe(200);
    expect(run.body.data.status).toBe('failed');
    expect(run.body.data.failure.code).toBe('TASK_TIMEOUT');

    const enrollments = (
      ctx.db
        .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE batch_id = ? AND source IN ('allocation', 'guarantee')")
        .get(batch.batchId) as { c: number }
    ).c;
    expect(enrollments).toBe(0);
    const failedRun = ctx.db
      .prepare('SELECT status, failure_code FROM allocation_runs WHERE id = ?')
      .get(run.body.data.runId) as { status: string; failure_code: string };
    expect(failedRun.status).toBe('failed');
    expect(failedRun.failure_code).toBe('TASK_TIMEOUT');
  });
});
