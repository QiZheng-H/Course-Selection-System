/**
 * 测试基础设施：
 * 每个测试用例拿到一个独立的内存数据库（结构与演示数据完全一致），
 * 这样测试之间互不影响，也不会污染开发用的 SQLite 文件。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { openDatabase, type SqliteDb } from '../src/db/index.js';
import { seedDatabase } from '../src/db/seed.js';
import { createApp } from '../src/routes/index.js';

export interface TestContext {
  db: SqliteDb;
  app: Express;
  dir: string;
  cleanup(): void;
}

/** 新建一个隔离的测试环境（独立 SQLite 文件 + 演示数据），复用真实路由 */
export function setupTestContext(options: { students?: number; classes?: number } = {}): TestContext {
  const dir = mkdtempSync(path.join(tmpdir(), 'css-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDatabase({ filename: dbPath });
  seedDatabase(db, {
    studentCount: options.students ?? 40,
    classCount: options.classes ?? 20,
  });
  const app = createApp({ db });
  return {
    db,
    app,
    dir,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface LoginResult {
  userId: number;
  token: string;
  cookie: string;
}

export async function login(app: Express, username: string, password: string): Promise<LoginResult> {
  const response = await request(app).post('/api/auth/login').send({ username, password });
  if (response.status !== 200) {
    throw new Error(`登录失败（${response.status}）：${JSON.stringify(response.body)}`);
  }
  const setCookie = response.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = setCookie?.[0]?.split(';')[0] ?? '';
  return {
    userId: response.body.data.user.id,
    token: response.body.data.user.username,
    cookie,
  };
}

export function authHeader(cookie: string): Record<string, string> {
  return { Cookie: cookie };
}

// ---------------------------------------------------------------------------
// 批次与数据的便捷操作（测试里经常需要）
// ---------------------------------------------------------------------------

export interface BatchSetup {
  batchId: number;
  term: string;
  adminCookie: string;
}

/** 创建批次并推进到指定状态（默认 open，可提交志愿） */
export async function setupBatch(
  ctx: TestContext,
  options: { term?: string; status?: 'preview' | 'open' | 'frozen' | 'waitlist'; adminCookie?: string; name?: string } = {},
): Promise<BatchSetup> {
  const adminCookie = options.adminCookie ?? (await login(ctx.app, 'admin', 'admin123')).cookie;
  const term = options.term ?? (ctx.db.prepare('SELECT term FROM teaching_classes GROUP BY term ORDER BY COUNT(*) DESC LIMIT 1').get() as { term: string }).term;
  const create = await request(ctx.app)
    .post('/api/admin/batches')
    .set(authHeader(adminCookie))
    .send({ term, name: options.name ?? `测试批次-${Date.now()}`, creditLimit: 30 });
  if (create.status !== 200) throw new Error(`创建批次失败：${JSON.stringify(create.body)}`);
  const batchId = create.body.data.id as number;

  const target = options.status ?? 'open';
  const sequence: Array<'preview' | 'open' | 'frozen' | 'published' | 'waitlist'> =
    target === 'preview'
      ? ['preview']
      : target === 'open'
        ? ['preview', 'open']
        : target === 'frozen'
          ? ['preview', 'open', 'frozen']
          : ['preview', 'open', 'frozen', 'waitlist'];
  for (const status of sequence) {
    const transition = await request(ctx.app)
      .post(`/api/admin/batches/${batchId}/transition`)
      .set(authHeader(adminCookie))
      .send({ status, force: true });
    if (transition.status !== 200) {
      throw new Error(`批次状态流转到 ${status} 失败：${JSON.stringify(transition.body)}`);
    }
  }
  return { batchId, term, adminCookie };
}

export function studentIds(ctx: TestContext, limit: number, offset = 0): number[] {
  const rows = ctx.db
    .prepare('SELECT user_id FROM students ORDER BY user_id LIMIT ? OFFSET ?')
    .all(limit, offset) as Array<{ user_id: number }>;
  return rows.map((r) => r.user_id);
}

export function studentNo(ctx: TestContext, userId: number): string {
  return (ctx.db.prepare('SELECT student_no FROM students WHERE user_id = ?').get(userId) as { student_no: string }).student_no;
}

/** 直接给某学生选一个教学班（走正式选课服务，保证占用规则一致） */
export async function enrollDirect(
  ctx: TestContext,
  cookie: string,
  classId: number,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const response = await request(ctx.app)
    .post('/api/enroll')
    .set(authHeader(cookie))
    .send({ classId, idempotencyKey: `test-${classId}-${Math.random().toString(16).slice(2)}` });
  if (response.status === 200) return { ok: true };
  return { ok: false, code: response.body?.error?.code, message: response.body?.error?.message };
}

export interface ClassSeedInput {
  courseId: number;
  classCode: string;
  term: string;
  capacity: number;
  reservedSeats?: number;
  teacherId?: number | null;
  sessions?: Array<{
    dayOfWeek: number;
    periodStart: number;
    periodEnd: number;
    weekStart: number;
    weekEnd: number;
    weekParity?: 'all' | 'odd' | 'even';
    room?: string | null;
  }>;
}

/** 直接写库造教学班（仅测试使用；正式代码一律走 catalog service） */
export function createClassRow(ctx: TestContext, input: ClassSeedInput): number {
  const now = new Date().toISOString();
  const info = ctx.db
    .prepare(
      `INSERT INTO teaching_classes (course_id, class_code, term, teacher_id, capacity, reserved_seats, status, campus, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?)`,
    )
    .run(input.courseId, input.classCode, input.term, input.teacherId ?? null, input.capacity, input.reservedSeats ?? 0, now);
  const classId = Number(info.lastInsertRowid);
  const insertSession = ctx.db.prepare(
    `INSERT INTO class_sessions (class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity, room)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const session of input.sessions ?? []) {
    insertSession.run(
      classId,
      session.dayOfWeek,
      session.periodStart,
      session.periodEnd,
      session.weekStart,
      session.weekEnd,
      session.weekParity ?? 'all',
      session.room ?? null,
    );
  }
  return classId;
}

/** 提交一份志愿（通过 HTTP，走完整校验） */
export async function submitPreferences(
  ctx: TestContext,
  cookie: string,
  batchId: number,
  preferences: Array<{ courseId: number; globalRank: number; classIds?: number[]; groupCode?: string | null }>,
  groups: Array<{ code: string; name: string }> = [],
): Promise<{ status: number; body: { ok: boolean; data?: unknown; error?: { code: string; message: string } } }> {
  const response = await request(ctx.app)
    .post('/api/preferences/submit')
    .set(authHeader(cookie))
    .send({ batchId, preferences, groups });
  return { status: response.status, body: response.body };
}

// ---------------------------------------------------------------------------
// 后台任务：分配计算现在通过可跟踪的任务执行，测试统一轮询任务状态
// ---------------------------------------------------------------------------

export interface TaskSnapshot {
  id: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  runId: number | null;
  progress: number;
  total: number;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  percent: number;
  retryable: boolean;
}

export async function waitForTask(
  ctx: TestContext,
  adminCookie: string,
  taskId: number,
  timeoutMs = 20_000,
): Promise<TaskSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request(ctx.app).get(`/api/admin/tasks/${taskId}`).set(authHeader(adminCookie));
    if (response.status !== 200) throw new Error(`查询任务失败：${JSON.stringify(response.body)}`);
    const task = response.body.data.task as TaskSnapshot;
    if (!['queued', 'running'].includes(task.status)) return task;
    if (Date.now() > deadline) throw new Error(`任务 ${taskId} 在 ${timeoutMs}ms 内没有完成`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface AllocationRunResult {
  taskId: number;
  runId: number;
  status: string;
  report: {
    allocated: number;
    rejected: number;
    guaranteeFulfilled: number;
    releasedReservedSeats: number;
    exceptions: unknown[];
  } | null;
  task: TaskSnapshot;
}

/** 发起一次分配（后台任务）并等待其结束 */
export async function runAllocationTask(
  ctx: TestContext,
  adminCookie: string,
  batchId: number,
  mode: 'simulate' | 'publish',
  options: Record<string, unknown> = {},
): Promise<AllocationRunResult> {
  const post = await request(ctx.app)
    .post(`/api/admin/batches/${batchId}/allocate`)
    .set(authHeader(adminCookie))
    .send({ mode, ...options });
  if (post.status !== 200) throw new Error(`发起分配失败：${JSON.stringify(post.body)}`);
  const taskId = post.body.data.taskId as number;
  const task = await waitForTask(ctx, adminCookie, taskId);
  const result = (task.result ?? {}) as { runId?: number; status?: string; report?: AllocationRunResult['report'] };
  const runId = result.runId ?? task.runId ?? 0;
  return {
    taskId,
    runId,
    status: result.status ?? task.status,
    report: result.report ?? null,
    task,
  };
}

