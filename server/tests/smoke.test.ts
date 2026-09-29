/**
 * 冒烟测试：确认服务能启动、能登录、能读到演示数据。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authHeader, login, setupTestContext, type TestContext } from './helpers.js';

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
    expect(courses.c).toBe(28);
    expect(classes.c).toBe(12);
    expect(students.c).toBe(20);
  });
});
