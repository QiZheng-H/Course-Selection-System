/**
 * 资料导入、版本发布与专业课预分配测试。
 *
 * 覆盖验收要求：
 *   - 支持文字型 CSV / XLSX / 带表格文本的导入，导入只生成批次与校验报告；
 *   - 管理员核对后发布，产生带内容哈希的资料版本；
 *   - 关键资料变化后需要重新确认（不能静默删除已选课）；
 *   - 专业课预分配占用正式容量，并保留可配置调整余量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { authHeader, login, setupTestContext, type TestContext } from './helpers.js';
import { parseUploadedFile } from '../src/modules/materials/service.js';

let ctx: TestContext;
let adminCookie: string;

beforeAll(async () => {
  ctx = setupTestContext({ students: 20, classes: 8 });
  adminCookie = (await login(ctx.app, 'admin', 'admin123')).cookie;
});

afterAll(() => {
  ctx.cleanup();
});

function writeTemp(name: string, content: string | Buffer): string {
  const file = path.join(ctx.dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('文件解析', () => {
  it('可以解析 CSV（含中文表头，支持全角逗号）', () => {
    const file = writeTemp('courses.csv', '课程号,课程名称,学分,院系\nNEW01,测试新增课,2.5,测试学院\nNEW02，另一门课，3，测试学院\n');
    const parsed = parseUploadedFile(file, 'courses.csv');
    expect(parsed.rows.length).toBe(2);
    expect(parsed.headers).toContain('课程号');
    expect(parsed.rows[0]['课程名称']).toBe('测试新增课');
  });

  it('可以解析 XLSX', () => {
    const worksheet = XLSX.utils.json_to_sheet([
      { 课程号: 'XLS01', 课程名称: 'Excel 课程', 学分: 3 },
      { 课程号: 'XLS02', 课程名称: 'Excel 课程2', 学分: 2 },
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const file = path.join(ctx.dir, 'courses.xlsx');
    XLSX.writeFile(workbook, file);
    const parsed = parseUploadedFile(file, 'courses.xlsx');
    expect(parsed.source).toBe('xlsx');
    expect(parsed.rows.length).toBe(2);
  });

  it('可以解析 DOCX 中的文字型表格（按多空格/制表符分列）', () => {
    // DOCX 本质是 zip + word/document.xml，这里造一个最小可用结构
    const xml = `<?xml version="1.0"?><w:document><w:body>
      <w:p><w:r><w:t>课程号  课程名称  学分</w:t></w:r></w:p>
      <w:p><w:r><w:t>DOC01  Word 课程  3</w:t></w:r></w:p>
    </w:body></w:document>`;
    const docx = buildMinimalZip('word/document.xml', xml);
    const file = writeTemp('courses.docx', docx);
    const parsed = parseUploadedFile(file, 'courses.docx');
    expect(parsed.source).toBe('docx-text');
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it('不支持的格式给出明确提示', () => {
    const file = writeTemp('data.png', 'not-an-image');
    expect(() => parseUploadedFile(file, 'data.png')).toThrowError(/暂不支持/);
  });
});

/** 构造一个只包含单个文件的最小 zip（不依赖第三方库） */
function buildMinimalZip(name: string, content: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const dataBuf = Buffer.from(content, 'utf8');
  const crc = crc32(dataBuf);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(dataBuf.length, 18);
  localHeader.writeUInt32LE(dataBuf.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(dataBuf.length, 20);
  central.writeUInt32LE(dataBuf.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = localHeader.length + nameBuf.length + dataBuf.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([localHeader, nameBuf, dataBuf, central, nameBuf, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('导入发布与资料版本', () => {
  it('导入课程：先校验再发布，发布产生新版本且内容可查询', async () => {
    const before = (ctx.db.prepare('SELECT COUNT(*) AS c FROM courses').get() as { c: number }).c;
    const file = writeTemp('new-courses.csv', '课程号,课程名称,学分,院系,课程类型\nIMP01,导入课程一,3,测试学院,必修\nIMP02,导入课程二,2,测试学院,选修\n');
    const response = await request(ctx.app)
      .post('/api/admin/imports')
      .set(authHeader(adminCookie))
      .field('kind', 'courses')
      .attach('file', file);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.valid).toBe(true);
    expect(response.body.data.rowCount).toBe(2);
    const batchId = response.body.data.batchId as number;

    // 导入本身不写正式数据
    const during = (ctx.db.prepare('SELECT COUNT(*) AS c FROM courses').get() as { c: number }).c;
    expect(during).toBe(before);

    const publish = await request(ctx.app)
      .post(`/api/admin/imports/${batchId}/publish`)
      .set(authHeader(adminCookie))
      .send({});
    expect(publish.status, JSON.stringify(publish.body)).toBe(200);
    expect(publish.body.data.applied).toBe(2);
    const after = (ctx.db.prepare('SELECT COUNT(*) AS c FROM courses').get() as { c: number }).c;
    expect(after).toBe(before + 2);

    const versions = await request(ctx.app).get('/api/admin/versions?scope=courses').set(authHeader(adminCookie));
    expect(versions.status).toBe(200);
    const list = versions.body.data.versions as Array<{ scope: string; versionNo: number; contentHash: string; active: number }>;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].scope).toBe('courses');
    expect(list[0].contentHash).toHaveLength(64);
    expect(list[0].active).toBe(1);

    // 新版本生效后，旧版本自动失效
    const actives = list.filter((v) => v.active === 1);
    expect(actives.length).toBe(1);
  });

  it('有错误的导入批次不能发布，并返回逐行问题', async () => {
    const file = writeTemp('bad-courses.csv', '课程号,课程名称,学分\nBAD01,错误课程,not-a-number\n,BAD02,3\n');
    const response = await request(ctx.app)
      .post('/api/admin/imports')
      .set(authHeader(adminCookie))
      .field('kind', 'courses')
      .attach('file', file);
    expect(response.status).toBe(201);
    expect(response.body.data.valid).toBe(false);
    expect(response.body.data.issues.length).toBeGreaterThan(0);

    const publish = await request(ctx.app)
      .post(`/api/admin/imports/${response.body.data.batchId}/publish`)
      .set(authHeader(adminCookie))
      .send({});
    expect(publish.status).toBe(422);
    expect(publish.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('导入教学班时连带写入上课时段', async () => {
    // 依赖上一用例导入的课程
    const file = writeTemp(
      'classes.csv',
      '教学班号,课程号,容量,教师,星期,开始节次,结束节次,教室,学期\nIMP01-A,IMP01,40,导入教师,2,3,4,教1-101,2026-2027-1\n',
    );
    const response = await request(ctx.app)
      .post('/api/admin/imports')
      .set(authHeader(adminCookie))
      .field('kind', 'classes')
      .attach('file', file);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.valid, JSON.stringify(response.body.data.issues)).toBe(true);
    const publish = await request(ctx.app)
      .post(`/api/admin/imports/${response.body.data.batchId}/publish`)
      .set(authHeader(adminCookie))
      .send({ term: '2026-2027-1' });
    expect(publish.status, JSON.stringify(publish.body)).toBe(200);

    const cls = ctx.db.prepare("SELECT id FROM teaching_classes WHERE class_code = 'IMP01-A'").get() as { id: number };
    expect(cls).toBeDefined();
    const sessions = ctx.db
      .prepare('SELECT day_of_week, period_start, period_end, room FROM class_sessions WHERE class_id = ?')
      .all(cls.id) as Array<{ day_of_week: number; period_start: number; period_end: number; room: string }>;
    expect(sessions.length).toBe(1);
    expect(sessions[0].day_of_week).toBe(2);
    expect(sessions[0].room).toBe('教1-101');
  });

  it('关键资料变化后学生需要重新确认，确认后异常关闭', async () => {
    const studentRow = ctx.db.prepare('SELECT user_id, student_no FROM students ORDER BY user_id LIMIT 1').get() as {
      user_id: number;
      student_no: string;
    };
    const studentCookie = (await login(ctx.app, studentRow.student_no, '123456')).cookie;

    const first = await request(ctx.app).post('/api/student/records/confirm').set(authHeader(studentCookie)).send({});
    expect(first.status).toBe(200);

    // 发布一次修读记录资料 → 之前的确认应当失效
    // 课程号取自官方培养计划（种子库中的 courses.code）
    const seededCourse = ctx.db.prepare('SELECT code FROM courses ORDER BY id LIMIT 1').get() as { code: string };
    const file = writeTemp(
      'records.csv',
      `学号,课程号,状态,学期\n${studentRow.student_no},${seededCourse.code},passed,2024-2025-1\n`,
    );
    const importResponse = await request(ctx.app)
      .post('/api/admin/imports')
      .set(authHeader(adminCookie))
      .field('kind', 'records')
      .attach('file', file);
    expect(importResponse.status).toBe(201);
    const publish = await request(ctx.app)
      .post(`/api/admin/imports/${importResponse.body.data.batchId}/publish`)
      .set(authHeader(adminCookie))
      .send({});
    expect(publish.status, JSON.stringify(publish.body)).toBe(200);

    const status = await request(ctx.app).get('/api/student/profile').set(authHeader(studentCookie));
    expect(status.status).toBe(200);
    expect(status.body.data.confirmation.needsReconfirm).toBe(true);

    const reconfirm = await request(ctx.app).post('/api/student/records/confirm').set(authHeader(studentCookie)).send({});
    expect(reconfirm.status).toBe(200);
    const after = await request(ctx.app).get('/api/student/profile').set(authHeader(studentCookie));
    expect(after.body.data.confirmation.needsReconfirm).toBe(false);
  });

  it('发布过的导入批次不能重复发布', async () => {
    const file = writeTemp('again.csv', '课程号,课程名称,学分\nAGAIN01,重复发布课,3\n');
    const response = await request(ctx.app)
      .post('/api/admin/imports')
      .set(authHeader(adminCookie))
      .field('kind', 'courses')
      .attach('file', file);
    const batchId = response.body.data.batchId as number;
    const first = await request(ctx.app).post(`/api/admin/imports/${batchId}/publish`).set(authHeader(adminCookie)).send({});
    expect(first.status).toBe(200);
    const second = await request(ctx.app).post(`/api/admin/imports/${batchId}/publish`).set(authHeader(adminCookie)).send({});
    expect(second.status).toBe(409);
  });
});

describe('专业课预分配', () => {
  it('校验阶段会算出“可落实”与“会失败”，失败原因说明余量', async () => {
    // 造一个容量 2 的教学班，margin 1 → 只能容纳 1 条 2 个学生的预分配
    const now = new Date().toISOString();
    const courseId = Number(
      ctx.db
        .prepare(
          `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
           VALUES ('PRE01', '预分配课程', 3, '测试学院', 'required', NULL, ?)`,
        )
        .run(now).lastInsertRowid,
    );
    const classId = Number(
      ctx.db
        .prepare(
          `INSERT INTO teaching_classes (course_id, class_code, term, capacity, reserved_seats, status, created_at)
           VALUES (?, 'PRE01-A', '2026-2027-1', 2, 0, 'open', ?)`,
        )
        .run(courseId, now).lastInsertRowid,
    );
    const students = ctx.db.prepare('SELECT user_id FROM students ORDER BY user_id LIMIT 2').all() as Array<{ user_id: number }>;
    const insert = ctx.db.prepare(
      `INSERT INTO preallocation_results (student_id, class_id, batch_id, status, margin, created_at)
       VALUES (?, ?, NULL, 'pending', 1, ?)`,
    );
    for (const student of students) insert.run(student.user_id, classId, now);

    const preview = await request(ctx.app).get('/api/admin/preallocations?status=pending').set(authHeader(adminCookie));
    expect(preview.status).toBe(200);
    expect(preview.body.data.validation.total).toBeGreaterThanOrEqual(2);
    expect(preview.body.data.validation.wouldFail.length).toBeGreaterThanOrEqual(1);
    expect(preview.body.data.validation.wouldFail[0].reason).toContain('余量');

    // 先校验（此时本用例的两条记录都还是 pending）
    const pendingPreview = await request(ctx.app).get('/api/admin/preallocations?status=pending').set(authHeader(adminCookie));
    expect(pendingPreview.body.data.validation.wouldFail.length).toBeGreaterThanOrEqual(1);

    const apply = await request(ctx.app)
      .post('/api/admin/preallocations/apply')
      .set(authHeader(adminCookie))
      .send({ term: '2026-2027-1' });
    expect(apply.status, JSON.stringify(apply.body)).toBe(200);
    // 演示数据里本身还有其它预分配记录，这里只针对本次造的教学班断言
    expect(apply.body.data.applied).toBeGreaterThanOrEqual(1);
    expect(apply.body.data.failed).toBeGreaterThanOrEqual(1);

    const enrolled = (
      ctx.db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'").get(classId) as { c: number }
    ).c;
    expect(enrolled).toBe(1);
    const source = ctx.db
      .prepare("SELECT source, uses_reserved FROM enrollments WHERE class_id = ? AND status = 'enrolled'")
      .get(classId) as { source: string; uses_reserved: number };
    expect(source.source).toBe('preallocation');
    expect(source.uses_reserved).toBe(0);
  });

  it('预分配导入发布后真的落库，并且不会再关联到导入批次', async () => {
    // 用本测试库里真实存在的学号与教学班号生成 CSV（示例文件里的班号属于完整演示数据）
    const pairs = ctx.db
      .prepare(
        `SELECT s.student_no AS studentNo, tc.class_code AS classCode
         FROM students s CROSS JOIN teaching_classes tc
         WHERE tc.status = 'open' ORDER BY s.user_id, tc.id LIMIT 3`,
      )
      .all() as Array<{ studentNo: string; classCode: string }>;
    expect(pairs.length).toBe(3);
    const csv = ['学号,教学班号,余量', ...pairs.map((p) => `${p.studentNo},${p.classCode},1`)].join('\n');
    const file = writeTemp('prealloc.csv', csv);

    const response = await request(ctx.app)
      .post('/api/admin/imports')
      .set(authHeader(adminCookie))
      .field('kind', 'preallocation')
      .attach('file', file);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.valid, JSON.stringify(response.body.data.issues)).toBe(true);

    const publish = await request(ctx.app)
      .post(`/api/admin/imports/${response.body.data.batchId}/publish`)
      .set(authHeader(adminCookie))
      .send({});
    // 关键回归：曾经把“导入批次 id”写进了关联“选课批次”的列，触发外键错误
    expect(publish.status, JSON.stringify(publish.body)).toBe(200);
    expect(publish.body.data.applied).toBeGreaterThan(0);

    const rows = ctx.db
      .prepare(
        `SELECT pr.batch_id, pr.status, pr.margin, s.student_no AS studentNo
         FROM preallocation_results pr JOIN students s ON s.user_id = pr.student_id
         WHERE pr.batch_id IS NULL AND pr.status = 'pending' AND s.student_no = ?`,
      )
      .all(pairs[0].studentNo) as Array<{ batch_id: number | null; status: string; margin: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].margin).toBe(1);

    // 版本 scope 也必须能容纳 preallocation
    const version = ctx.db
      .prepare("SELECT scope, version_no FROM data_versions WHERE scope = 'preallocation' AND active = 1")
      .get() as { scope: string; version_no: number } | undefined;
    expect(version?.scope).toBe('preallocation');
  });

  it('撤销预分配会释放名额', async () => {
    const row = ctx.db
      .prepare(
        `SELECT pr.id, pr.class_id FROM preallocation_results pr
         JOIN teaching_classes tc ON tc.id = pr.class_id
         WHERE pr.status = 'applied' AND tc.class_code = 'PRE01-A' LIMIT 1`,
      )
      .get() as { id: number; class_id: number } | undefined;
    expect(row).toBeDefined();
    if (!row) return;
    const before = (
      ctx.db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'").get(row.class_id) as {
        c: number;
      }
    ).c;
    const revert = await request(ctx.app)
      .post(`/api/admin/preallocations/${row.id}/revert`)
      .set(authHeader(adminCookie))
      .send({});
    expect(revert.status, JSON.stringify(revert.body)).toBe(200);
    expect(revert.body.data.ok).toBe(true);
    const after = (
      ctx.db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'").get(row.class_id) as {
        c: number;
      }
    ).c;
    expect(after).toBe(before - 1);
  });
});
