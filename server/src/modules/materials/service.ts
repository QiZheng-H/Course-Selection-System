/**
 * 资料导入与版本发布。
 *
 * 支持范围（第一版）：文字型 CSV / XLSX / DOCX / 文字型 PDF；
 * 其他格式由管理员转换或人工录入。
 *
 * 关键约定：
 *   - 导入只生成“批次 + 校验报告”，不直接改正式数据；
 *   - 管理员核对通过后发布，发布产生 data_versions 版本号与内容哈希；
 *   - 关键资料变化后，依赖它的授权/确认会被标记为过期（不能静默删除已选课）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../core/errors.js';
import { contentHash, nowIso, stableStringify } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';

export type ImportKind = 'courses' | 'classes' | 'program' | 'records' | 'preallocation';

export interface ParsedRow {
  [key: string]: string | number | null;
}

export interface ImportPreview {
  batchId: number;
  kind: ImportKind;
  fileName: string;
  fileHash: string;
  headers: string[];
  rows: ParsedRow[];
  rowCount: number;
  issues: Array<{ row: number; level: 'error' | 'warning'; message: string }>;
  valid: boolean;
  source: 'xlsx' | 'csv' | 'docx-text' | 'pdf-text' | 'json';
  textPreview?: string;
}

/** 读取上传文件并解析成二维表；无法解析的格式给出明确提示 */
export function parseUploadedFile(filePath: string, fileName: string): { rows: ParsedRow[]; headers: string[]; source: ImportPreview['source']; textPreview?: string } {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.readFile(filePath, { cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new AppError(ERROR_CODES.BAD_REQUEST, 'Excel 文件没有任何工作表', 400);
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json<Record<string, string | number | null>>(sheet, { defval: null, raw: true });
    const headers = json.length > 0 ? Object.keys(json[0]) : [];
    return { rows: json, headers, source: 'xlsx' };
  }
  if (ext === '.csv' || ext === '.txt' || ext === '.md' || ext === '.json') {
    const content = fs.readFileSync(filePath, 'utf8');
    if (ext === '.json') {
      const parsed = JSON.parse(content) as unknown;
      const list = Array.isArray(parsed) ? parsed : ((parsed as { rows?: unknown[] }).rows ?? []);
      const rows = list as ParsedRow[];
      return { rows, headers: rows.length > 0 ? Object.keys(rows[0]) : [], source: 'json' };
    }
    // CSV：同时支持逗号与中文全角逗号
    const text = content.replace(/\r\n/g, '\n').replace(/，/g, ',');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) return { rows: [], headers: [], source: 'csv', textPreview: '' };
    const headers = splitCsvLine(lines[0]);
    const rows = lines.slice(1).map((line) => {
      const cells = splitCsvLine(line);
      const row: ParsedRow = {};
      headers.forEach((header, index) => {
        row[header] = cells[index] ?? null;
      });
      return row;
    });
    if (ext === '.txt' || ext === '.md') {
      return { rows, headers, source: 'csv', textPreview: text.slice(0, 2000) };
    }
    return { rows, headers, source: 'csv' };
  }
  if (ext === '.docx') {
    const text = extractDocxText(filePath);
    return parseTextAsTable(text, 'docx-text');
  }
  if (ext === '.pdf') {
    const text = extractPdfText(filePath);
    return parseTextAsTable(text, 'pdf-text');
  }
  throw new AppError(
    ERROR_CODES.BAD_REQUEST,
    `暂不支持的文件格式 ${ext}；第一版支持 xlsx / csv / docx / pdf（文字型）与 json，其他格式请先转换或人工录入`,
    400,
  );
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** DOCX 是 zip：这里只取 word/document.xml 里的文本节点，不做完整排版还原 */
function extractDocxText(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  const text = buffer.toString('latin1');
  const matches = [...text.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
  const paragraphs = text.split(/<w:p[ >]/).map((p) => {
    const cells = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]));
    return cells.join('');
  });
  const joined = paragraphs.length > 1 ? paragraphs.join('\n') : matches.map(decodeXml).join('');
  return joined.replace(/\n{3,}/g, '\n\n');
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** PDF 文本抽取：识别未压缩的文本流，够用于演示（复杂 PDF 建议转 CSV） */
function extractPdfText(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  const raw = buffer.toString('latin1');
  const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => m[1]);
  const pieces: string[] = [];
  for (const stream of streams) {
    if (!/BT[\s\S]*?ET/.test(stream)) continue;
    const texts = [...stream.matchAll(/\((?:\\.|[^\\()])*\)/g)].map((m) =>
      m[0]
        .slice(1, -1)
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\n/g, '\n'),
    );
    if (texts.length > 0) pieces.push(texts.join(' '));
  }
  return pieces.join('\n');
}

/** 把纯文本按行解析成表：第一行当表头，支持逗号/制表符/多空格分隔 */
function parseTextAsTable(text: string, source: ImportPreview['source']): {
  rows: ParsedRow[];
  headers: string[];
  source: ImportPreview['source'];
  textPreview: string;
} {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return { rows: [], headers: [], source, textPreview: text.slice(0, 2000) };
  }
  const split = (line: string) => line.split(/\s{2,}|\t|,|，/).map((cell) => cell.trim());
  const headers = split(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = split(line);
    const row: ParsedRow = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? null;
    });
    return row;
  });
  return { rows, headers, source, textPreview: text.slice(0, 2000) };
}

/** 创建导入批次并做校验（不改正式数据） */
export function createImportBatch(
  db: SqliteDb,
  kind: ImportKind,
  fileName: string,
  filePath: string,
  actor: AuthUser,
): ImportPreview {
  const fileHash = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const parsed = parseUploadedFile(filePath, fileName);
  const issues = validateRows(db, kind, parsed.rows);
  const now = nowIso();

  const info = db
    .prepare(
      `INSERT INTO import_batches (kind, file_name, file_hash, status, row_count, error_count, payload, report, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      kind,
      fileName,
      fileHash,
      issues.some((i) => i.level === 'error') ? 'pending' : 'validated',
      parsed.rows.length,
      issues.filter((i) => i.level === 'error').length,
      stableStringify(parsed.rows),
      stableStringify({ headers: parsed.headers, issues, source: parsed.source }),
      actor.id,
      now,
    );

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'import.create',
    entityType: 'import_batch',
    entityId: Number(info.lastInsertRowid),
    summary: `导入${kindLabel(kind)}资料：${fileName}（${parsed.rows.length} 行，错误 ${issues.filter((i) => i.level === 'error').length}）`,
    detail: { fileHash },
  });

  return {
    batchId: Number(info.lastInsertRowid),
    kind,
    fileName,
    fileHash,
    headers: parsed.headers,
    rows: parsed.rows.slice(0, 200),
    rowCount: parsed.rows.length,
    issues,
    valid: !issues.some((i) => i.level === 'error'),
    source: parsed.source,
    textPreview: parsed.textPreview,
  };
}

export function kindLabel(kind: ImportKind): string {
  const labels: Record<ImportKind, string> = {
    courses: '课程',
    classes: '教学班',
    program: '培养方案',
    records: '修读记录',
    preallocation: '预分配',
  };
  return labels[kind];
}

function pick(row: ParsedRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  // 兼容全半角/空格差异
  for (const [key, value] of Object.entries(row)) {
    const normalized = key.replace(/\s/g, '').toLowerCase();
    if (keys.some((k) => normalized === k.replace(/\s/g, '').toLowerCase()) && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

/** 逐行校验：只报错，不写库 */
export function validateRows(db: SqliteDb, kind: ImportKind, rows: ParsedRow[]): ImportPreview['issues'] {
  const issues: ImportPreview['issues'] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const line = index + 2; // 表头占第 1 行
    if (kind === 'courses') {
      const code = pick(row, ['课程号', '课程代码', 'code']);
      const name = pick(row, ['课程名', '课程名称', 'name']);
      const credits = Number.parseFloat(pick(row, ['学分', 'credits']));
      if (!code) issues.push({ row: line, level: 'error', message: '缺少课程号' });
      if (!name) issues.push({ row: line, level: 'error', message: '缺少课程名称' });
      if (!Number.isFinite(credits) || credits <= 0) issues.push({ row: line, level: 'error', message: '学分必须是正数' });
      if (code && seen.has(code)) issues.push({ row: line, level: 'error', message: `课程号 ${code} 在文件中重复` });
      if (code) seen.add(code);
    } else if (kind === 'classes') {
      const classCode = pick(row, ['教学班号', '班级号', 'class_code', 'classCode']);
      const courseCode = pick(row, ['课程号', '课程代码', 'course_code']);
      const capacity = Number.parseInt(pick(row, ['容量', '课容量', 'capacity']), 10);
      if (!classCode) issues.push({ row: line, level: 'error', message: '缺少教学班号' });
      if (!courseCode) issues.push({ row: line, level: 'error', message: '缺少课程号' });
      if (!Number.isInteger(capacity) || capacity <= 0) issues.push({ row: line, level: 'error', message: '容量必须是正整数' });
      if (courseCode && !db.prepare('SELECT id FROM courses WHERE code = ?').get(courseCode)) {
        issues.push({ row: line, level: 'error', message: `课程号 ${courseCode} 不存在，请先导入课程` });
      }
      if (classCode && seen.has(classCode)) issues.push({ row: line, level: 'error', message: `教学班号 ${classCode} 在文件中重复` });
      if (classCode) seen.add(classCode);
      const day = pick(row, ['星期', 'day']);
      const start = pick(row, ['开始节次', '起始节次']);
      const end = pick(row, ['结束节次', '终止节次']);
      if (day && !/^[1-7]$/.test(day)) issues.push({ row: line, level: 'warning', message: '星期建议使用 1-7 的数字（1=周一）' });
      if (start && end && Number(start) > Number(end)) {
        issues.push({ row: line, level: 'error', message: '开始节次不能大于结束节次' });
      }
    } else if (kind === 'records') {
      const studentNo = pick(row, ['学号', 'student_no']);
      const courseCode = pick(row, ['课程号', '课程代码', 'course_code']);
      const status = pick(row, ['状态', 'status']);
      if (!studentNo) issues.push({ row: line, level: 'error', message: '缺少学号' });
      else if (!db.prepare('SELECT user_id FROM students WHERE student_no = ?').get(studentNo)) {
        issues.push({ row: line, level: 'error', message: `学号 ${studentNo} 不存在` });
      }
      if (!courseCode) issues.push({ row: line, level: 'error', message: '缺少课程号' });
      else if (!db.prepare('SELECT id FROM courses WHERE code = ?').get(courseCode)) {
        issues.push({ row: line, level: 'error', message: `课程号 ${courseCode} 不存在` });
      }
      const allowed = ['passed', 'failed', 'in_progress', 'selected', '已通过', '未通过', '在修', '已选'];
      if (status && !allowed.includes(status)) {
        issues.push({ row: line, level: 'warning', message: `状态 ${status} 无法识别，请使用 passed/failed/in_progress/selected` });
      }
    } else if (kind === 'preallocation') {
      const studentNo = pick(row, ['学号', 'student_no']);
      const classCode = pick(row, ['教学班号', 'class_code']);
      if (!studentNo) issues.push({ row: line, level: 'error', message: '缺少学号' });
      else if (!db.prepare('SELECT user_id FROM students WHERE student_no = ?').get(studentNo)) {
        issues.push({ row: line, level: 'error', message: `学号 ${studentNo} 不存在` });
      }
      if (!classCode) issues.push({ row: line, level: 'error', message: '缺少教学班号' });
      else if (!db.prepare('SELECT id FROM teaching_classes WHERE class_code = ?').get(classCode)) {
        issues.push({ row: line, level: 'error', message: `教学班号 ${classCode} 不存在` });
      }
      const key = `${studentNo}:${classCode}`;
      if (studentNo && classCode && seen.has(key)) issues.push({ row: line, level: 'error', message: '同一学生与教学班重复' });
      seen.add(key);
    } else if (kind === 'program') {
      const reqCode = pick(row, ['需求代码', '类别代码', 'requirement_code']);
      const courseCode = pick(row, ['课程号', '课程代码', 'course_code']);
      const credits = Number.parseFloat(pick(row, ['要求学分', 'required_credits', '学分']));
      if (!reqCode) issues.push({ row: line, level: 'error', message: '缺少需求代码' });
      if (!courseCode) issues.push({ row: line, level: 'error', message: '缺少课程号' });
      else if (!db.prepare('SELECT id FROM courses WHERE code = ?').get(courseCode)) {
        issues.push({ row: line, level: 'error', message: `课程号 ${courseCode} 不存在` });
      }
      if (credits !== undefined && pick(row, ['要求学分', 'required_credits']) && !(credits > 0)) {
        issues.push({ row: line, level: 'error', message: '要求学分必须是正数' });
      }
    }
  });
  return issues;
}

/** 发布导入批次：把校验通过的数据写入正式表，并生成资料版本 */
export function publishImportBatch(
  db: SqliteDb,
  batchId: number,
  actor: AuthUser,
  options: { programCode?: string; term?: string } = {},
): { versionId: number; versionNo: number; contentHash: string; applied: number } {
  const batch = db
    .prepare('SELECT id, kind, status, payload, file_name FROM import_batches WHERE id = ?')
    .get(batchId) as
    | { id: number; kind: ImportKind; status: string; payload: string | null; file_name: string }
    | undefined;
  if (!batch) throw notFound('导入批次不存在');
  if (batch.status === 'published') throw conflict('该导入批次已经发布过');
  const rows = JSON.parse(batch.payload ?? '[]') as ParsedRow[];
  const issues = validateRows(db, batch.kind, rows);
  if (issues.some((i) => i.level === 'error')) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '导入数据仍有错误，不能发布', 422, {
      issues: issues.filter((i) => i.level === 'error').slice(0, 30),
    });
  }

  const now = nowIso();
  let applied = 0;

  const result = db.transaction(() => {
    if (batch.kind === 'courses') {
      const insert = db.prepare(
        `INSERT INTO courses (code, name, credits, department, course_type, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (code) DO UPDATE SET name = excluded.name, credits = excluded.credits,
           department = excluded.department, course_type = excluded.course_type, description = excluded.description`,
      );
      for (const row of rows) {
        const code = pick(row, ['课程号', '课程代码', 'code']);
        insert.run(
          code,
          pick(row, ['课程名', '课程名称', 'name']),
          Number.parseFloat(pick(row, ['学分', 'credits'])) || 3,
          pick(row, ['院系', '开课单位', 'department']) || null,
          normalizeCourseType(pick(row, ['课程类型', '类型', 'course_type'])),
          pick(row, ['说明', '简介', 'description']) || null,
          now,
        );
        applied += 1;
      }
    } else if (batch.kind === 'classes') {
      const insert = db.prepare(
        `INSERT INTO teaching_classes (course_id, class_code, term, teacher_id, capacity, reserved_seats, status, campus, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
         ON CONFLICT (class_code) DO UPDATE SET course_id = excluded.course_id, term = excluded.term,
           teacher_id = excluded.teacher_id, capacity = excluded.capacity, reserved_seats = excluded.reserved_seats,
           campus = excluded.campus, note = excluded.note`,
      );
      const insertSession = db.prepare(
        `INSERT INTO class_sessions (class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity, room)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const term = options.term ?? (db.prepare('SELECT term FROM teaching_classes ORDER BY id DESC LIMIT 1').get() as
        | { term: string }
        | undefined)?.term ?? '2026-2027-1';
      for (const row of rows) {
        const courseCode = pick(row, ['课程号', '课程代码', 'course_code']);
        const course = db.prepare('SELECT id FROM courses WHERE code = ?').get(courseCode) as { id: number } | undefined;
        if (!course) continue;
        const classCode = pick(row, ['教学班号', '班级号', 'class_code']);
        const teacherName = pick(row, ['教师', '任课教师', 'teacher']);
        let teacherId: number | null = null;
        if (teacherName) {
          const existing = db.prepare('SELECT id FROM teachers WHERE name = ?').get(teacherName) as { id: number } | undefined;
          teacherId = existing
            ? existing.id
            : Number(db.prepare('INSERT INTO teachers (name, department, title) VALUES (?, ?, ?)').run(teacherName, null, null).lastInsertRowid);
        }
        const info = insert.run(
          course.id,
          classCode,
          pick(row, ['学期', 'term']) || term,
          teacherId,
          Number.parseInt(pick(row, ['容量', '课容量', 'capacity']), 10) || 40,
          Number.parseInt(pick(row, ['预留名额', 'reserved', 'reserved_seats']), 10) || 0,
          pick(row, ['校区', 'campus']) || null,
          pick(row, ['备注', 'note']) || null,
          now,
        );
        const classId = Number(info.lastInsertRowid) || (db.prepare('SELECT id FROM teaching_classes WHERE class_code = ?').get(classCode) as { id: number }).id;
        const day = Number.parseInt(pick(row, ['星期', 'day']), 10);
        const start = Number.parseInt(pick(row, ['开始节次', '起始节次']), 10);
        const end = Number.parseInt(pick(row, ['结束节次', '终止节次']), 10) || start;
        if (Number.isInteger(day) && day >= 1 && day <= 7 && Number.isInteger(start) && start >= 1) {
          db.prepare('DELETE FROM class_sessions WHERE class_id = ?').run(classId);
          const parityText = pick(row, ['单双周', 'parity']);
          insertSession.run(
            classId,
            day,
            start,
            end,
            Number.parseInt(pick(row, ['起始周', 'week_start']), 10) || 1,
            Number.parseInt(pick(row, ['结束周', 'week_end']), 10) || 16,
            parityText.includes('单') ? 'odd' : parityText.includes('双') ? 'even' : 'all',
            pick(row, ['教室', 'room']) || null,
          );
        }
        applied += 1;
      }
    } else if (batch.kind === 'records') {
      const insert = db.prepare(
        `INSERT INTO student_course_records (student_id, course_id, status, term, credits, source, verified, updated_at)
         VALUES (?, ?, ?, ?, ?, 'school', 1, ?)
         ON CONFLICT (student_id, course_id, status, term) DO UPDATE SET credits = excluded.credits, updated_at = excluded.updated_at`,
      );
      for (const row of rows) {
        const studentNo = pick(row, ['学号', 'student_no']);
        const courseCode = pick(row, ['课程号', '课程代码', 'course_code']);
        const student = db.prepare('SELECT user_id FROM students WHERE student_no = ?').get(studentNo) as { user_id: number } | undefined;
        const course = db.prepare('SELECT id, credits FROM courses WHERE code = ?').get(courseCode) as
          | { id: number; credits: number }
          | undefined;
        if (!student || !course) continue;
        insert.run(
          student.user_id,
          course.id,
          normalizeRecordStatus(pick(row, ['状态', 'status'])),
          pick(row, ['学期', 'term']) || null,
          Number.parseFloat(pick(row, ['学分', 'credits'])) || course.credits,
          now,
        );
        applied += 1;
      }
    } else if (batch.kind === 'preallocation') {
      // 注意：这里的 batchId 是“导入批次”，而 preallocation_results.batch_id 关联的是“选课批次”，
      // 两者含义不同（迁移 004 已修正外键目标）。预分配通常早于选课批次建立，因此这里写 NULL。
      const insert = db.prepare(
        `INSERT INTO preallocation_results (student_id, class_id, batch_id, status, margin, created_at)
         VALUES (?, ?, NULL, 'pending', ?, ?)
         ON CONFLICT (student_id, class_id) DO UPDATE SET status = 'pending', reason = NULL, margin = excluded.margin`,
      );
      for (const row of rows) {
        const studentNo = pick(row, ['学号', 'student_no']);
        const classCode = pick(row, ['教学班号', 'class_code']);
        const student = db.prepare('SELECT user_id FROM students WHERE student_no = ?').get(studentNo) as { user_id: number } | undefined;
        const cls = db.prepare('SELECT id FROM teaching_classes WHERE class_code = ?').get(classCode) as { id: number } | undefined;
        if (!student || !cls) continue;
        insert.run(
          student.user_id,
          cls.id,
          Number.parseInt(pick(row, ['余量', 'margin']), 10) || 0,
          now,
        );
        applied += 1;
      }
    } else if (batch.kind === 'program') {
      const programCode = options.programCode ?? 'CS-2024';
      const program = db.prepare('SELECT id FROM programs WHERE code = ?').get(programCode) as { id: number } | undefined;
      if (!program) throw notFound(`培养方案 ${programCode} 不存在`);
      for (const row of rows) {
        const reqCode = pick(row, ['需求代码', '类别代码', 'requirement_code']);
        const reqName = pick(row, ['需求名称', '类别名称', 'requirement_name']) || reqCode;
        const requiredCredits = Number.parseFloat(pick(row, ['要求学分', 'required_credits'])) || 0;
        const minCourses = Number.parseInt(pick(row, ['最少门数', 'min_courses']), 10) || 0;
        const priority = Number.parseInt(pick(row, ['优先级', 'priority']), 10) || 3;
        db.prepare(
          `INSERT INTO curriculum_requirements (program_id, code, name, category, required_credits, min_courses, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (program_id, code) DO UPDATE SET name = excluded.name, required_credits = excluded.required_credits,
             min_courses = excluded.min_courses, priority = excluded.priority`,
        ).run(program.id, reqCode, reqName, pick(row, ['类别', 'category']) || null, requiredCredits, minCourses, priority);
        const req = db.prepare('SELECT id FROM curriculum_requirements WHERE program_id = ? AND code = ?').get(program.id, reqCode) as {
          id: number;
        };
        const courseCode = pick(row, ['课程号', '课程代码', 'course_code']);
        const course = db.prepare('SELECT id FROM courses WHERE code = ?').get(courseCode) as { id: number } | undefined;
        if (!course) continue;
        db.prepare(
          `INSERT INTO curriculum_courses (requirement_id, course_id, relation, priority)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (requirement_id, course_id) DO UPDATE SET relation = excluded.relation, priority = excluded.priority`,
        ).run(req.id, course.id, pick(row, ['关系', 'relation']) === 'substitute' ? 'substitute' : 'direct', applied + 1);
        applied += 1;
      }
    }

    const versionNo = (
      (db.prepare('SELECT COALESCE(MAX(version_no), 0) AS v FROM data_versions WHERE scope = ?').get(batch.kind) as {
        v: number;
      }).v ?? 0
    ) + 1;
    // 说明：scope 取值与导入批次 kind 一致（courses/classes/program/records/preallocation），
    // 由迁移 004 扩展 data_versions.scope 的 CHECK 约束后支持 preallocation。
    db.prepare('UPDATE data_versions SET active = 0 WHERE scope = ?').run(batch.kind);
    const versionInfo = db
      .prepare(
        `INSERT INTO data_versions (scope, version_no, content_hash, summary, batch_id, published_by, published_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        batch.kind,
        versionNo,
        contentHash(rows),
        `${kindLabel(batch.kind)}资料发布：${batch.file_name}（${rows.length} 行）`,
        batchId,
        actor.id,
        now,
      );
    const versionId = Number(versionInfo.lastInsertRowid);

    db.prepare("UPDATE import_batches SET status = 'published', published_at = ? WHERE id = ?").run(now, batchId);

    return { versionId, versionNo };
  })();

  // 关键资料变化：标记受影响的学生需要重新确认（不静默删除已选课）
  if (batch.kind === 'records' || batch.kind === 'program') {
    invalidateConfirmations(db, batch.kind);
  }

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'import.publish',
    entityType: 'data_version',
    entityId: result.versionId,
    summary: `发布${kindLabel(batch.kind)}资料 v${result.versionNo}（${applied} 行生效）`,
  });

  return { ...result, contentHash: contentHash(rows), applied };
}

function normalizeCourseType(value: string): string {
  if (!value) return 'elective';
  if (value.includes('必修')) return 'required';
  if (value.includes('限选') || value.includes('选修限')) return 'limited_elective';
  if (value.includes('通识')) return 'general';
  if (['required', 'limited_elective', 'elective', 'general'].includes(value)) return value;
  return 'elective';
}

function normalizeRecordStatus(value: string): string {
  const map: Record<string, string> = {
    passed: 'passed',
    已通过: 'passed',
    通过: 'passed',
    failed: 'failed',
    未通过: 'failed',
    不及格: 'failed',
    in_progress: 'in_progress',
    在修: 'in_progress',
    正在修读: 'in_progress',
    selected: 'selected',
    已选: 'selected',
  };
  return map[value] ?? 'passed';
}

/**
 * 资料变化后让相关确认失效，并把受影响的学生记入异常清单，
 * 由管理员/学生重新确认（不能静默删除已选课）。
 */
function invalidateConfirmations(db: SqliteDb, scope: string): void {
  const now = nowIso();
  // 需要失效的确认包括：① 依据同 scope 旧版本做出的确认；② 在“尚无版本”时做出的确认（version_id 为 NULL）
  const affected = db
    .prepare(
      `SELECT sc.student_id, sc.id FROM source_confirmations sc
       LEFT JOIN data_versions dv ON dv.id = sc.version_id
       WHERE sc.invalidated_at IS NULL AND (dv.scope = ? OR sc.version_id IS NULL)`,
    )
    .all(scope) as Array<{ student_id: number; id: number }>;
  if (affected.length === 0) return;
  db.prepare(
    `UPDATE source_confirmations SET invalidated_at = ?
     WHERE id IN (
       SELECT sc.id FROM source_confirmations sc
       LEFT JOIN data_versions dv ON dv.id = sc.version_id
       WHERE sc.invalidated_at IS NULL AND (dv.scope = ? OR sc.version_id IS NULL)
     )`,
  ).run(now, scope);
  const insert = db.prepare(
    `INSERT INTO exceptions (student_id, kind, severity, status, detail, created_at)
     VALUES (?, 'material_changed', 'warning', 'open', ?, ?)`,
  );
  for (const row of affected) {
    insert.run(row.student_id, stableStringify({ scope, message: '关键资料已更新，需要重新确认' }), now);
  }

  // 依赖资料的授权标记为失效（不能继续自动执行）
  const auths = db
    .prepare(
      `SELECT ua.id, ua.student_id FROM upgrade_authorizations ua
       JOIN data_versions dv ON dv.id = ua.version_id
       WHERE ua.status IN ('active', 'pending') AND dv.scope = ?`,
    )
    .all(scope) as Array<{ id: number; student_id: number }>;
  for (const auth of auths) {
    db.prepare("UPDATE upgrade_authorizations SET status = 'invalidated', invalidated_at = ? WHERE id = ?").run(now, auth.id);
    db.prepare(
      `INSERT INTO exceptions (student_id, kind, severity, status, detail, created_at)
       VALUES (?, 'authorization_invalidated', 'warning', 'open', ?, ?)`,
    ).run(auth.student_id, stableStringify({ scope, authorizationId: auth.id }), now);
  }
}

export function listImportBatches(db: SqliteDb, limit = 50): unknown[] {
  return db
    .prepare(
      `SELECT ib.id, ib.kind, ib.file_name AS fileName, ib.file_hash AS fileHash, ib.status, ib.row_count AS rowCount,
              ib.error_count AS errorCount, ib.report, ib.created_at AS createdAt, ib.published_at AS publishedAt,
              u.username AS createdBy
       FROM import_batches ib LEFT JOIN users u ON u.id = ib.created_by
       ORDER BY ib.id DESC LIMIT ?`,
    )
    .all(limit);
}

export function listDataVersions(db: SqliteDb, scope?: string): unknown[] {
  const where = scope ? 'WHERE scope = ?' : '';
  const params = scope ? [scope] : [];
  return db
    .prepare(
      `SELECT dv.id, dv.scope, dv.version_no AS versionNo, dv.content_hash AS contentHash, dv.summary,
              dv.published_at AS publishedAt, dv.active, u.username AS publishedBy
       FROM data_versions dv LEFT JOIN users u ON u.id = dv.published_by
       ${where} ORDER BY dv.id DESC LIMIT 100`,
    )
    .all(...params);
}

/** 学生确认个人修读记录：确认后才允许参与正式竞争 */
export function confirmMaterials(db: SqliteDb, studentId: number, actor: AuthUser): { versionId: number | null; confirmedAt: string } {
  const version = db
    .prepare("SELECT id FROM data_versions WHERE scope = 'records' AND active = 1 ORDER BY version_no DESC LIMIT 1")
    .get() as { id: number } | undefined;
  const now = nowIso();
  if (!version) {
    // 还没有任何正式资料版本时也允许确认（version_id 为 NULL，含义见迁移 005）
    db.prepare(
      `INSERT INTO source_confirmations (student_id, version_id, confirmed_at, note)
       SELECT ?, NULL, ?, '尚无正式资料版本时的确认'
       WHERE NOT EXISTS (SELECT 1 FROM source_confirmations WHERE student_id = ? AND version_id IS NULL)`,
    ).run(studentId, now, studentId);
    return { versionId: null, confirmedAt: now };
  }
  db.prepare(
    `INSERT INTO source_confirmations (student_id, version_id, confirmed_at)
     VALUES (?, ?, ?)
     ON CONFLICT (student_id, version_id) DO UPDATE SET confirmed_at = excluded.confirmed_at, invalidated_at = NULL`,
  ).run(studentId, version.id, now);
  db.prepare(
    `UPDATE exceptions SET status = 'resolved', resolution = '学生已重新确认资料', resolved_at = ?
     WHERE student_id = ? AND kind = 'material_changed' AND status = 'open'`,
  ).run(now, studentId);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'material.confirm',
    entityType: 'data_version',
    entityId: version.id,
    summary: '学生确认个人修读记录',
  });
  return { versionId: version.id, confirmedAt: now };
}

export function getConfirmationStatus(db: SqliteDb, studentId: number): {
  confirmed: boolean;
  confirmedAt: string | null;
  activeVersionId: number | null;
  needsReconfirm: boolean;
} {
  const activeVersion = db
    .prepare("SELECT id FROM data_versions WHERE scope = 'records' AND active = 1 ORDER BY version_no DESC LIMIT 1")
    .get() as { id: number } | undefined;
  const latest = db
    .prepare('SELECT version_id, confirmed_at, invalidated_at FROM source_confirmations WHERE student_id = ? ORDER BY id DESC LIMIT 1')
    .get(studentId) as { version_id: number | null; confirmed_at: string; invalidated_at: string | null } | undefined;
  const needsReconfirm = (
    db
      .prepare("SELECT COUNT(*) AS c FROM exceptions WHERE student_id = ? AND kind = 'material_changed' AND status = 'open'")
      .get(studentId) as { c: number }
  ).c > 0;
  // 确认的版本与当前生效版本不一致（或确认已被标记失效）时，都需要重新确认
  const versionOutdated =
    Boolean(latest) && !latest!.invalidated_at && latest!.version_id !== (activeVersion?.id ?? null);
  return {
    confirmed: Boolean(latest && !latest.invalidated_at && !versionOutdated),
    confirmedAt: latest?.confirmed_at ?? null,
    activeVersionId: activeVersion?.id ?? null,
    needsReconfirm,
  };
}
