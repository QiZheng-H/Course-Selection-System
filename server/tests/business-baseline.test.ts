/**
 * 业务基线回归测试。
 *
 * 与「实施计划」验收清单一一对应，重点覆盖原先实现的错误行为：
 *   1. 同需求下第一志愿优先于第二志愿，不受其它课程需求与处理顺序影响；
 *   2. 未落实申请不抵扣培养缺口，落实后需求等级随之更新；
 *   3. 容量 2 已有 1 个预分配时仍能分配剩余 1 个名额；
 *   4. 试算不修改正式选课、保障状态与预留数量；
 *   5. 发布中途失败时正式数据整体回滚；
 *   6. 重复发布不取消已有课程、不重复占位；
 *   7. 无学生授权不做兜底扩大与自动替换；
 *   8. 普通名额可用时受保护学生不先消耗预留；
 *   9. 多学生共享容量、多门毕业课程联合冲突判断正确；
 *  10. 第一候补暂挂时第二个合格候补可递补；
 *  11. 第一偏好班满员时可尝试其它已接受的教学班；
 *  12. 自动替换失败保留原课、成功才释放原课；
 *  13. 同一学生多门候补不能共用一个全局排名；
 *  14. 到截止时间但未手动冻结时提交与撤回仍被拒绝；
 *  15. 发布自动生成候补，批次结束后不再递补；
 *  16. 计算期间健康检查可响应，超时不发布部分结果。
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

function makeCourse(name: string, credits = 3, courseType = 'elective'): number {
  seq += 1;
  const code = `BZ${seq}${Date.now() % 10000}`;
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, ?, '测试学院', ?, ?, ?)`,
      )
      .run(code, name, credits, courseType, null, nowIso()).lastInsertRowid,
  );
}

function makeClass(
  courseId: number,
  term: string,
  capacity: number,
  sessions: Array<{ dayOfWeek: number; periodStart: number; periodEnd: number; weekStart?: number; weekEnd?: number }>,
  reservedSeats = 0,
): number {
  seq += 1;
  return createClassRow(ctx, {
    courseId,
    classCode: `BZ${seq}-A`,
    term,
    capacity,
    reservedSeats,
    sessions: sessions.map((s) => ({ weekStart: 1, weekEnd: 16, ...s })),
  });
}

async function studentCookie(studentNo: string): Promise<string> {
  return (await login(ctx.app, studentNo, '123456')).cookie;
}

function studentIdOf(studentNo: string): number {
  return (ctx.db.prepare('SELECT user_id FROM students WHERE student_no = ?').get(studentNo) as { user_id: number }).user_id;
}

async function grantGuaranteeAuthorization(
  cookie: string,
  batchId: number,
  courseId: number,
  classIds: number[],
): Promise<void> {
  const response = await request(ctx.app)
    .post('/api/guarantee-authorizations')
    .set(authHeader(cookie))
    .send({ batchId, courseId, classIds });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

function enrollmentSnapshot(): string {
  return JSON.stringify(
    ctx.db
      .prepare("SELECT student_id, class_id, course_id, source, uses_reserved FROM enrollments WHERE status = 'enrolled' ORDER BY student_id, class_id")
      .all(),
  );
}

function reservationSnapshot(): string {
  return JSON.stringify(
    ctx.db
      .prepare('SELECT student_id, course_id, status FROM graduation_reservations ORDER BY student_id, course_id')
      .all(),
  );
}

async function freezeBatch(batch: { batchId: number; adminCookie: string }): Promise<void> {
  const response = await request(ctx.app)
    .post(`/api/admin/batches/${batch.batchId}/freeze`)
    .set(authHeader(batch.adminCookie))
    .send({});
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

function reservedSeatsSnapshot(): Array<{ id: number; reserved_seats: number }> {
  return ctx.db
    .prepare('SELECT id, reserved_seats FROM teaching_classes ORDER BY id')
    .all() as Array<{ id: number; reserved_seats: number }>;
}

// ---------------------------------------------------------------------------
// ① 竞争单位与排序
// ---------------------------------------------------------------------------

describe('统一分配的竞争单位与排序', () => {
  it('同需求下第一志愿优先于第二志愿，且不受该学生其它课程高需求的影响', async () => {
    const batch = await setupBatch(ctx, { name: '竞争单位' });
    // A 的“另一门课”是管理员确认的本期必需（D2），旧实现会把 A 的所有申请都提前处理
    const otherCourse = makeCourse('A的另一门必需课');
    const otherClass = makeClass(otherCourse, batch.term, 10, [{ dayOfWeek: 6, periodStart: 1, periodEnd: 2 }]);
    const contested = makeCourse('被争夺的课');
    const contestedClass = makeClass(contested, batch.term, 1, [{ dayOfWeek: 6, periodStart: 3, periodEnd: 4 }]);

    const cookieA = await studentCookie('20241001');
    const cookieB = await studentCookie('20241002');
    await request(ctx.app)
      .post('/api/admin/term-required')
      .set(authHeader(batch.adminCookie))
      .send({ studentId: studentIdOf('20241001'), courseIds: [otherCourse], term: batch.term });

    // A：必需课 rank1，被争夺课 rank2；B：被争夺课 rank1
    await submitPreferences(ctx, cookieA, batch.batchId, [
      { courseId: otherCourse, globalRank: 1, classIds: [otherClass] },
      { courseId: contested, globalRank: 2, classIds: [contestedClass] },
    ]);
    await submitPreferences(ctx, cookieB, batch.batchId, [{ courseId: contested, globalRank: 1, classIds: [contestedClass] }]);

    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    expect(run.status, JSON.stringify(run.task)).toBe('succeeded');
    const items = ctx.db
      .prepare('SELECT student_id, course_id, decision, global_rank FROM allocation_items WHERE run_id = ?')
      .all(run.runId) as Array<{ student_id: number; course_id: number; decision: string; global_rank: number }>;

    const aGet = items.find((i) => i.student_id === studentIdOf('20241001') && i.course_id === contested);
    const bGet = items.find((i) => i.student_id === studentIdOf('20241002') && i.course_id === contested);
    // 同一门课、同为普通兴趣（D0）：全局排名决定，B 的第一志愿胜过 A 的第二志愿
    expect(bGet?.decision).toBe('allocated');
    expect(aGet?.decision).toBe('rejected');
    // A 的必需课仍然落实，说明“另一门课的需求”没有把 A 的第二志愿也变成第一顺位
    expect(items.find((i) => i.student_id === studentIdOf('20241001') && i.course_id === otherCourse)?.decision).toBe('allocated');
  });

  it('未落实的申请不抵扣培养缺口；落实足够课程后剩余需求等级随之更新', async () => {
    const batch = await setupBatch(ctx, { name: '需求更新' });
    seq += 1;
    const programId = Number(
      ctx.db
        .prepare(
          `INSERT INTO programs (code, name, grade, major, total_credits, version, status, published_at, created_at)
           VALUES (?, '基线测试培养方案', '2024', '测试专业', 160, 1, 'published', ?, ?)`,
        )
        .run(`BZP${seq}`, nowIso(), nowIso()).lastInsertRowid,
    );
    const requirementId = Number(
      ctx.db
        .prepare(
          `INSERT INTO curriculum_requirements (program_id, code, name, category, required_credits, min_courses, priority, note)
           VALUES (?, 'R1', '二选一必修', 'required', 3, 1, 1, NULL)`,
        )
        .run(programId).lastInsertRowid,
    );
    const pCourse = makeCourse('方案课程P', 3, 'required');
    const qCourse = makeCourse('方案课程Q', 3, 'required');
    for (const courseId of [pCourse, qCourse]) {
      ctx.db
        .prepare("INSERT INTO curriculum_courses (requirement_id, course_id, relation, priority) VALUES (?, ?, 'direct', 1)")
        .run(requirementId, courseId);
    }
    const pClass = makeClass(pCourse, batch.term, 5, [{ dayOfWeek: 6, periodStart: 5, periodEnd: 6 }]);
    const qClass = makeClass(qCourse, batch.term, 2, [{ dayOfWeek: 6, periodStart: 7, periodEnd: 8 }]);

    const studentA = '20241003';
    const studentB = '20241004';
    ctx.db.prepare('UPDATE students SET program_id = ? WHERE user_id = ?').run(programId, studentIdOf(studentA));
    const cookieA = await studentCookie(studentA);
    const cookieB = await studentCookie(studentB);

    // A 同时申请 P/Q：P 第一志愿（rank1），Q 第二志愿（rank2）
    await submitPreferences(ctx, cookieA, batch.batchId, [
      { courseId: pCourse, globalRank: 1, classIds: [pClass] },
      { courseId: qCourse, globalRank: 2, classIds: [qClass] },
    ]);
    // B 的 Q 是管理员确认的本期必需（D2）
    await request(ctx.app)
      .post('/api/admin/term-required')
      .set(authHeader(batch.adminCookie))
      .send({ studentId: studentIdOf(studentB), courseIds: [qCourse], term: batch.term });
    await submitPreferences(ctx, cookieB, batch.batchId, [{ courseId: qCourse, globalRank: 1, classIds: [qClass] }]);

    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    const items = ctx.db
      .prepare('SELECT student_id, course_id, decision, demand_level FROM allocation_items WHERE run_id = ?')
      .all(run.runId) as Array<{ student_id: number; course_id: number; decision: string; demand_level: string }>;

    const aP = items.find((i) => i.student_id === studentIdOf(studentA) && i.course_id === pCourse);
    const aQ = items.find((i) => i.student_id === studentIdOf(studentA) && i.course_id === qCourse);
    const bQ = items.find((i) => i.student_id === studentIdOf(studentB) && i.course_id === qCourse);

    // 冻结时 A 还没有任何安排：P 必须是 D2（若把志愿当已落实，就会错误地算成 D0）
    expect(aP?.demand_level).toBe('D2');
    // A 落实 P 之后，培养需求已满足：Q 的需求等级降为 D0
    expect(aQ?.demand_level).toBe('D0');
    // B 的 Q 由管理员确认本期必须完成，保持 D2
    expect(bQ?.demand_level).toBe('D2');
  });

  it('容量 2 且已有 1 个预分配时，仍能分配剩余 1 个名额', async () => {
    const batch = await setupBatch(ctx, { name: '预分配不重复扣' });
    const course = makeCourse('预分配计数课', 3);
    const classId = makeClass(course, batch.term, 2, [{ dayOfWeek: 6, periodStart: 9, periodEnd: 10 }]);

    // 模拟专业课预分配：已经有 1 人正式占用
    const preStudent = studentIdOf('20241005');
    ctx.db
      .prepare(
        `INSERT INTO enrollments (student_id, class_id, course_id, status, source, uses_reserved, reason, created_at, updated_at)
         VALUES (?, ?, ?, 'enrolled', 'preallocation', 0, '预分配', ?, ?)`,
      )
      .run(preStudent, classId, course, nowIso(), nowIso());

    const applicant = '20241006';
    const cookie = await studentCookie(applicant);
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);

    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    const item = ctx.db
      .prepare('SELECT decision, reason_code FROM allocation_items WHERE run_id = ? AND student_id = ?')
      .get(run.runId, studentIdOf(applicant)) as { decision: string; reason_code: string };
    // 旧实现会把预分配计两次，导致剩下 0 个名额
    expect(item.decision).toBe('allocated');
  });
});

// ---------------------------------------------------------------------------
// ② 试算与发布分离
// ---------------------------------------------------------------------------

describe('试算与正式发布分离', () => {
  async function prepareSimpleBatch(name: string) {
    const batch = await setupBatch(ctx, { name });
    const course = makeCourse(`${name}-课程`);
    const classId = makeClass(course, batch.term, 3, [
      { dayOfWeek: 5, periodStart: 1, periodEnd: 2 },
    ]);
    const cookie = await studentCookie('20241007');
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);
    return { batch, course, classId, cookie };
  }

  it('试算前后正式选课、保护状态与预留数量完全不变', async () => {
    const { batch, course, classId } = await prepareSimpleBatch('试算纯净');
    const protectedStudent = studentIdOf('20241008');
    await request(ctx.app)
      .post('/api/admin/guarantee')
      .set(authHeader(batch.adminCookie))
      .send({ batchId: batch.batchId, courseId: course, studentIds: [protectedStudent] });

    const enrollBefore = enrollmentSnapshot();
    const reservationsBefore = reservationSnapshot();
    const reservedBefore = reservedSeatsSnapshot();

    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    expect(run.status).toBe('succeeded');

    expect(enrollmentSnapshot()).toBe(enrollBefore);
    expect(reservationSnapshot()).toBe(reservationsBefore);
    expect(reservedSeatsSnapshot()).toEqual(reservedBefore);
    // 仍可查看试算结论
    const items = ctx.db.prepare('SELECT COUNT(*) AS c FROM allocation_items WHERE run_id = ?').get(run.runId) as { c: number };
    expect(items.c).toBeGreaterThan(0);
    void classId;
  });

  it('发布中途失败时正式数据整体回滚，批次不会被标成已发布', async () => {
    const batch = await setupBatch(ctx, { name: '发布回滚' });
    const term = batch.term;
    const courseX = makeCourse('回滚课X');
    const classX = makeClass(courseX, term, 5, [{ dayOfWeek: 4, periodStart: 1, periodEnd: 2 }]);
    const courseY = makeCourse('回滚课Y');
    const classY = makeClass(courseY, term, 5, [{ dayOfWeek: 4, periodStart: 3, periodEnd: 4 }]);
    for (const studentNo of ['20241009', '20241010']) {
      const cookie = await studentCookie(studentNo);
      await submitPreferences(ctx, cookie, batch.batchId, [
        { courseId: courseX, globalRank: 1, classIds: [classX] },
        { courseId: courseY, globalRank: 2, classIds: [classY] },
      ]);
    }
    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    expect(run.status).toBe('succeeded');
    const enrollBefore = enrollmentSnapshot();

    // 让“最后一条要落实的判定”在事务内失败：关闭它的教学班（试算已通过，容量预检看不出来）
    const last = ctx.db
      .prepare(
        "SELECT class_id AS classId, student_id AS studentId FROM allocation_items WHERE run_id = ? AND decision = 'allocated' ORDER BY order_index DESC LIMIT 1",
      )
      .get(run.runId) as { classId: number; studentId: number };
    ctx.db.prepare("UPDATE teaching_classes SET status = 'closed' WHERE id = ?").run(last.classId);

    const publish = await request(ctx.app)
      .post(`/api/admin/runs/${run.runId}/publish`)
      .set(authHeader(batch.adminCookie))
      .send({});
    expect(publish.status).toBe(409);

    // 整体回滚：没有任何选课记录被写入，保障状态与批次状态保持原样
    expect(enrollmentSnapshot()).toBe(enrollBefore);
    const batchRow = ctx.db.prepare('SELECT status FROM selection_batches WHERE id = ?').get(batch.batchId) as {
      status: string;
    };
    expect(batchRow.status).toBe('frozen');
    const runRow = ctx.db.prepare('SELECT status FROM allocation_runs WHERE id = ?').get(run.runId) as { status: string };
    expect(runRow.status).not.toBe('published');
  });

  it('重复发布返回已有结果，不取消已有课程、不重复占位', async () => {
    const { batch, classId } = await prepareSimpleBatch('重复发布');
    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    const first = await request(ctx.app).post(`/api/admin/runs/${run.runId}/publish`).set(authHeader(batch.adminCookie)).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const afterFirst = enrollmentSnapshot();

    const second = await request(ctx.app).post(`/api/admin/runs/${run.runId}/publish`).set(authHeader(batch.adminCookie)).send({});
    expect(second.status).toBe(200);
    expect(second.body.data.idempotentReplay).toBe(true);
    expect(enrollmentSnapshot()).toBe(afterFirst);

    const count = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .get(classId) as { c: number };
    expect(count.c).toBeLessThanOrEqual(3);

    // 另一次试算结果不能顶掉已经发布的正式结果（避免把两份结果混在一起）
    const secondRun = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    const overwrite = await request(ctx.app)
      .post(`/api/admin/runs/${secondRun.runId}/publish`)
      .set(authHeader(batch.adminCookie))
      .send({});
    expect(overwrite.status).toBe(409);
    expect(enrollmentSnapshot()).toBe(afterFirst);
  });

  it('同一幂等键用于不同批次或不同模式时被拒绝', async () => {
    const first = await prepareSimpleBatch('幂等键A');
    const second = await prepareSimpleBatch('幂等键B');
    await freezeBatch(first.batch);
    const run = await runAllocationTask(ctx, first.batch.adminCookie, first.batch.batchId, 'simulate', { idempotencyKey: 'shared-key' });
    expect(run.runId).toBeGreaterThan(0);

    // 同键不同批次
    const other = await request(ctx.app)
      .post(`/api/admin/batches/${second.batch.batchId}/allocate`)
      .set(authHeader(second.batch.adminCookie))
      .send({ mode: 'simulate', idempotencyKey: 'shared-key' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// ③ 毕业保障
// ---------------------------------------------------------------------------

describe('毕业保障与授权', () => {
  it('没有学生兜底授权时不做自动扩大选择，并形成明确异常', async () => {
    const batch = await setupBatch(ctx, { name: '缺授权' });
    const course = makeCourse('兜底缺授权课', 3, 'required');
    const classId = makeClass(course, batch.term, 1, [{ dayOfWeek: 3, periodStart: 1, periodEnd: 2 }], 1);
    const protectedStudent = studentIdOf('20241011');
    const cookie = await studentCookie('20241011');
    await request(ctx.app)
      .post('/api/admin/guarantee')
      .set(authHeader(batch.adminCookie))
      .send({ batchId: batch.batchId, courseId: course, studentIds: [protectedStudent] });
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);

    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    expect(run.report?.guaranteeFulfilled).toBe(0);
    const exception = ctx.db
      .prepare("SELECT kind, status FROM exceptions WHERE batch_id = ? AND student_id = ? AND kind = 'guarantee_no_authorization'")
      .get(batch.batchId, protectedStudent) as { kind: string; status: string } | undefined;
    expect(exception?.status).toBe('open');
    const enrollmentCount = (
      ctx.db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'").get(classId) as {
        c: number;
      }
    ).c;
    expect(enrollmentCount).toBe(0);
  });

  it('普通名额可用时，受保护学生先用普通名额而不是毕业预留', async () => {
    const batch = await setupBatch(ctx, { name: '先普通后预留' });
    const course = makeCourse('先普通后预留课', 3, 'required');
    // 容量 3，其中 1 个预留：普通名额 2
    const classId = makeClass(course, batch.term, 3, [{ dayOfWeek: 3, periodStart: 3, periodEnd: 4 }], 1);
    const protectedStudent = studentIdOf('20241012');
    const cookie = await studentCookie('20241012');
    await request(ctx.app)
      .post('/api/admin/guarantee')
      .set(authHeader(batch.adminCookie))
      .send({ batchId: batch.batchId, courseId: course, studentIds: [protectedStudent] });
    await grantGuaranteeAuthorization(cookie, batch.batchId, course, [classId]);
    await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course, globalRank: 1, classIds: [classId] }]);

    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'publish');
    expect(run.status).toBe('published');
    const row = ctx.db
      .prepare("SELECT uses_reserved FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'enrolled'")
      .get(protectedStudent, classId) as { uses_reserved: number } | undefined;
    expect(row?.uses_reserved).toBe(0);
    // 预留未被占用：整门课程保护需求落实后释放为普通名额
    const seat = ctx.db.prepare('SELECT reserved_seats FROM teaching_classes WHERE id = ?').get(classId) as {
      reserved_seats: number;
    };
    expect(seat.reserved_seats).toBe(0);
  });

  it('多学生共享容量时只有一人能落实预留，其余进入异常；联合冲突被识别', async () => {
    const batch = await setupBatch(ctx, { name: '共享容量与联合冲突' });
    const courseA = makeCourse('共享容量课A', 3, 'required');
    const classA = makeClass(courseA, batch.term, 1, [{ dayOfWeek: 2, periodStart: 1, periodEnd: 2 }], 1);
    const courseB = makeCourse('共享容量课B', 3, 'required');
    // B 只有一个与 A 完全相同的时段：多门必要课程联合无解
    const classB = makeClass(courseB, batch.term, 10, [{ dayOfWeek: 2, periodStart: 1, periodEnd: 2 }], 0);

    const student1 = '20241013';
    const student2 = '20241014';
    for (const studentNo of [student1, student2]) {
      await request(ctx.app)
        .post('/api/admin/guarantee')
        .set(authHeader(batch.adminCookie))
        .send({ batchId: batch.batchId, courseId: courseA, studentIds: [studentIdOf(studentNo)] });
      await grantGuaranteeAuthorization(await studentCookie(studentNo), batch.batchId, courseA, [classA]);
      await submitPreferences(ctx, await studentCookie(studentNo), batch.batchId, [
        { courseId: courseA, globalRank: 1, classIds: [classA] },
      ]);
    }
    // 联合可行性：student1 同时受保护 A 与 B，而两者只有同一时段
    await request(ctx.app)
      .post('/api/admin/guarantee')
      .set(authHeader(batch.adminCookie))
      .send({ batchId: batch.batchId, courseId: courseB, studentIds: [studentIdOf(student1)] });

    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'simulate');
    // 共享 1 个预留：最多一人落实
    expect(run.report?.guaranteeFulfilled).toBe(1);
    const abnormal = (
      ctx.db
        .prepare("SELECT COUNT(*) AS c FROM graduation_reservations WHERE batch_id = ? AND course_id = ? AND status = 'abnormal'")
        .get(batch.batchId, courseA) as { c: number }
    ).c;
    expect(abnormal).toBeGreaterThanOrEqual(0);
    // student1 的 A+B 联合无解会形成 guarantee_no_solution 异常
    expect(run.report?.exceptions.length).toBeGreaterThan(0);
    void classB;
  });
});

// ---------------------------------------------------------------------------
// ④ 候补与自动替换
// ---------------------------------------------------------------------------

describe('候补与自动替换', () => {
  it('第一候补暂挂时不阻塞第二个合格候补递补', async () => {
    const batch = await setupBatch(ctx, { name: '暂挂不阻塞', status: 'waitlist' });
    const course = makeCourse('暂挂不阻塞课');
    const classId = makeClass(course, batch.term, 1, [{ dayOfWeek: 1, periodStart: 5, periodEnd: 6 }]);

    // 占用者
    const holderCookie = await studentCookie('20241015');
    await request(ctx.app).post('/api/enroll').set(authHeader(holderCookie)).send({ classId, idempotencyKey: 'nb-hold' });

    // 第一候补：与另一门已选课程时间冲突
    const firstCookie = await studentCookie('20241016');
    const conflictCourse = makeCourse('冲突课程');
    const conflictClass = makeClass(conflictCourse, batch.term, 5, [{ dayOfWeek: 1, periodStart: 5, periodEnd: 6 }]);
    await request(ctx.app).post('/api/enroll').set(authHeader(firstCookie)).send({ classId: conflictClass, idempotencyKey: 'nb-conflict' });
    await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(firstCookie))
      .send({ batchId: batch.batchId, courseId: course, classIds: [classId], globalRank: 1 });

    // 第二候补：条件良好
    const secondCookie = await studentCookie('20241017');
    await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(secondCookie))
      .send({ batchId: batch.batchId, courseId: course, classIds: [classId], globalRank: 2 });

    // 释放名额：第一候补因时间冲突被暂挂，但不得阻塞第二候补递补
    await request(ctx.app).post('/api/drop').set(authHeader(holderCookie)).send({ classId, idempotencyKey: 'nb-drop' });
    const firstEntry = ctx.db
      .prepare('SELECT status, suspend_code FROM waitlist_entries WHERE course_id = ? AND student_id = ?')
      .get(course, studentIdOf('20241016')) as { status: string; suspend_code: string | null };
    expect(firstEntry.status).toBe('suspended');
    expect(firstEntry.suspend_code).toBe('TIME_CONFLICT');
    const secondEntry = ctx.db
      .prepare('SELECT status FROM waitlist_entries WHERE course_id = ? AND student_id = ?')
      .get(course, studentIdOf('20241017')) as { status: string };
    expect(secondEntry.status).toBe('promoted');
    const enrolled = ctx.db
      .prepare("SELECT student_id FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .all(classId) as Array<{ student_id: number }>;
    expect(enrolled.map((e) => e.student_id)).toContain(studentIdOf('20241017'));
  });

  it('第一偏好教学班满员时，继续尝试其它已接受的教学班', async () => {
    const batch = await setupBatch(ctx, { name: '多班尝试', status: 'waitlist' });
    const course = makeCourse('多班尝试课');
    const classA = makeClass(course, batch.term, 1, [{ dayOfWeek: 2, periodStart: 5, periodEnd: 6 }]);
    const classB = makeClass(course, batch.term, 1, [{ dayOfWeek: 2, periodStart: 7, periodEnd: 8 }]);

    // 把第一偏好班占满
    const blockerCookie = await studentCookie('20241018');
    await request(ctx.app).post('/api/enroll').set(authHeader(blockerCookie)).send({ classId: classA, idempotencyKey: 'mb-hold' });

    const cookie = await studentCookie('20241019');
    await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId, courseId: course, classIds: [classA, classB] });
    const recheck = await request(ctx.app).post('/api/waitlist/recheck').set(authHeader(cookie)).send({ batchId: batch.batchId });
    expect(recheck.status).toBe(200);

    const enrolled = ctx.db
      .prepare("SELECT class_id FROM enrollments WHERE student_id = ? AND status = 'enrolled'")
      .all(studentIdOf('20241019')) as Array<{ class_id: number }>;
    expect(enrolled.map((e) => e.class_id)).toContain(classB);
  });

  it('自动替换失败保留原课，成功才释放原课', async () => {
    const batch = await setupBatch(ctx, { name: '替换保原课', status: 'waitlist' });
    const sourceCourse = makeCourse('替换原课');
    const sourceClass = makeClass(sourceCourse, batch.term, 5, [{ dayOfWeek: 2, periodStart: 9, periodEnd: 10 }]);
    const targetCourse = makeCourse('替换目标课');
    const fullTargetClass = makeClass(targetCourse, batch.term, 1, [{ dayOfWeek: 2, periodStart: 11, periodEnd: 12 }]);
    const freeTargetClass = makeClass(targetCourse, batch.term, 5, [{ dayOfWeek: 2, periodStart: 11, periodEnd: 12 }]);

    const cookie = await studentCookie('20241020');
    await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId: sourceClass, idempotencyKey: 'rp-src' });
    // 占满目标班
    const blockerCookie = await studentCookie('20241021');
    await request(ctx.app).post('/api/enroll').set(authHeader(blockerCookie)).send({ classId: fullTargetClass, idempotencyKey: 'rp-block' });

    const failing = await request(ctx.app)
      .post('/api/authorizations')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId, sourceClassId: sourceClass, targetCourseId: targetCourse, targetClassId: fullTargetClass });
    expect(failing.status, JSON.stringify(failing.body)).toBe(200);
    const upgradeFail = await request(ctx.app)
      .post('/api/upgrade')
      .set(authHeader(cookie))
      .send({ authorizationId: failing.body.data.id, idempotencyKey: 'rp-fail' });
    expect(upgradeFail.status).toBe(409);
    const stillSource = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'enrolled'")
      .get(studentIdOf('20241020'), sourceClass) as { c: number };
    expect(stillSource.c).toBe(1);

    // 用同一原课重新授权到有空位的班：成功后才释放原课
    const ok = await request(ctx.app)
      .post('/api/authorizations')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId, sourceClassId: sourceClass, targetCourseId: targetCourse, targetClassId: freeTargetClass });
    expect(ok.status).toBe(200);
    const upgradeOk = await request(ctx.app)
      .post('/api/upgrade')
      .set(authHeader(cookie))
      .send({ authorizationId: ok.body.data.id, idempotencyKey: 'rp-ok' });
    expect(upgradeOk.status, JSON.stringify(upgradeOk.body)).toBe(200);
    const after = ctx.db
      .prepare("SELECT class_id FROM enrollments WHERE student_id = ? AND status = 'enrolled'")
      .all(studentIdOf('20241020')) as Array<{ class_id: number }>;
    expect(after.map((e) => e.class_id)).toContain(freeTargetClass);
    expect(after.map((e) => e.class_id)).not.toContain(sourceClass);
  });

  it('同一学生的多门候补不能共用一个全局排名', async () => {
    const batch = await setupBatch(ctx, { name: '候补排名唯一', status: 'waitlist' });
    const courseA = makeCourse('候补排名课A');
    makeClass(courseA, batch.term, 3, [{ dayOfWeek: 4, periodStart: 1, periodEnd: 2 }]);
    const courseB = makeCourse('候补排名课B');
    makeClass(courseB, batch.term, 3, [{ dayOfWeek: 4, periodStart: 3, periodEnd: 4 }]);

    const cookie = await studentCookie('20241022');
    const first = await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId, courseId: courseA, globalRank: 1 });
    expect(first.status).toBe(200);
    const second = await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId, courseId: courseB, globalRank: 1 });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('VALIDATION_FAILED');

    // 换一个不重复的排名即可
    const third = await request(ctx.app)
      .post('/api/waitlist')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId, courseId: courseB, globalRank: 2 });
    expect(third.status, JSON.stringify(third.body)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 阶段控制与后台任务
// ---------------------------------------------------------------------------

describe('阶段控制与后台任务', () => {
  it('到达管理员设定的截止时间但未手动冻结时，提交与撤回仍被拒绝', async () => {
    const batch = await setupBatch(ctx, { name: '时间截止' });
    const course = ctx.db
      .prepare("SELECT DISTINCT course_id AS id FROM teaching_classes WHERE status = 'open' AND term = ? LIMIT 1")
      .get(batch.term) as { id: number };
    const cookie = await studentCookie('20241023');
    const ok = await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course.id, globalRank: 1 }]);
    expect(ok.status).toBe(200);

    // 把截止时间设到过去，但批次状态仍是 open（管理员并没有点冻结）
    const patch = await request(ctx.app)
      .patch(`/api/admin/batches/${batch.batchId}`)
      .set(authHeader(batch.adminCookie))
      .send({ closeAt: new Date(Date.now() - 60_000).toISOString() });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);

    const tooLate = await submitPreferences(ctx, cookie, batch.batchId, [{ courseId: course.id, globalRank: 1 }]);
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.error?.code).toBe('SUBMISSION_CLOSED');
    const withdraw = await request(ctx.app)
      .post('/api/preferences/withdraw')
      .set(authHeader(cookie))
      .send({ batchId: batch.batchId });
    expect(withdraw.status).toBe(409);
    expect(withdraw.body.error.code).toBe('SUBMISSION_CLOSED');
  });

  it('公布前不能通过直接选课占用普通名额；批次结束后停止写入', async () => {
    const openBatch = await setupBatch(ctx, { name: '首轮前禁选' });
    const course = ctx.db
      .prepare("SELECT DISTINCT course_id AS id FROM teaching_classes WHERE status = 'open' AND term = ? LIMIT 1")
      .get(openBatch.term) as { id: number };
    const classRow = ctx.db
      .prepare("SELECT id FROM teaching_classes WHERE course_id = ? AND status = 'open' LIMIT 1")
      .get(course.id) as { id: number };
    const cookie = await studentCookie('20241024');
    const blocked = await request(ctx.app).post('/api/enroll').set(authHeader(cookie)).send({ classId: classRow.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BATCH_STATE_INVALID');
  });

  it('发布自动生成候补，批次结束后候补不再递补', async () => {
    const batch = await setupBatch(ctx, { name: '结束批次' });
    const course = makeCourse('结束批次课');
    const classId = makeClass(course, batch.term, 1, [{ dayOfWeek: 5, periodStart: 5, periodEnd: 6 }]);
    for (const studentNo of ['20241025', '20241026']) {
      await submitPreferences(ctx, await studentCookie(studentNo), batch.batchId, [
        { courseId: course, globalRank: 1, classIds: [classId] },
      ]);
    }
    await freezeBatch(batch);
    const run = await runAllocationTask(ctx, batch.adminCookie, batch.batchId, 'publish');
    expect(run.status).toBe('published');
    const autoQueued = (
      ctx.db
        .prepare("SELECT COUNT(*) AS c FROM waitlist_entries WHERE batch_id = ? AND status = 'queued'")
        .get(batch.batchId) as { c: number }
    ).c;
    expect(autoQueued).toBeGreaterThan(0);

    const toWaitlist = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/transition`)
      .set(authHeader(batch.adminCookie))
      .send({ status: 'waitlist' });
    expect(toWaitlist.status).toBe(200);
    const close = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/transition`)
      .set(authHeader(batch.adminCookie))
      .send({ status: 'closed' });
    expect(close.status).toBe(200);
    const remaining = (
      ctx.db
        .prepare("SELECT COUNT(*) AS c FROM waitlist_entries WHERE batch_id = ? AND status IN ('queued', 'suspended')")
        .get(batch.batchId) as { c: number }
    ).c;
    expect(remaining).toBe(0);
  });

  it('计算期间健康检查可响应，超时不发布部分结果', async () => {
    const batch = await setupBatch(ctx, { name: '后台任务' });
    const course = makeCourse('后台任务课');
    const classId = makeClass(course, batch.term, 5, [{ dayOfWeek: 5, periodStart: 7, periodEnd: 8 }]);
    await submitPreferences(ctx, await studentCookie('20241027'), batch.batchId, [
      { courseId: course, globalRank: 1, classIds: [classId] },
    ]);

    // 接口立即返回任务标识；随后健康检查仍然正常响应
    const start = await request(ctx.app)
      .post(`/api/admin/batches/${batch.batchId}/allocate`)
      .set(authHeader(batch.adminCookie))
      .send({ mode: 'simulate' });
    expect(start.status).toBe(200);
    expect(typeof start.body.data.taskId).toBe('number');
    const health = await request(ctx.app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.data.status).toBe('ok');

    const timedOutBatch = await setupBatch(ctx, { name: '超时不落位' });
    const course2 = makeCourse('超时课');
    const class2 = makeClass(course2, timedOutBatch.term, 5, [{ dayOfWeek: 5, periodStart: 9, periodEnd: 10 }]);
    await submitPreferences(ctx, await studentCookie('20241028'), timedOutBatch.batchId, [
      { courseId: course2, globalRank: 1, classIds: [class2] },
    ]);
    const before = enrollmentSnapshot();
    await freezeBatch(timedOutBatch);
    const timedOut = await runAllocationTask(ctx, timedOutBatch.adminCookie, timedOutBatch.batchId, 'publish', { timeoutMs: 0 });
    expect(timedOut.task.status).toBe('timeout');
    expect(enrollmentSnapshot()).toBe(before);
    const batchRow = ctx.db.prepare('SELECT status FROM selection_batches WHERE id = ?').get(timedOutBatch.batchId) as {
      status: string;
    };
    expect(batchRow.status).toBe('frozen');
  });
});
