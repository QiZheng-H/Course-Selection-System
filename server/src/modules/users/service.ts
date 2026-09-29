/** 账号管理：管理员创建/导入账号，学生查询自己的资料。 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, conflict, forbidden, notFound } from '../../core/errors.js';
import { hashPassword } from '../../core/password.js';
import { nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser, Role } from '../../core/context.js';
import { loadUserById } from '../auth/service.js';

export interface CreateUserInput {
  username: string;
  password: string;
  displayName: string;
  role: Role;
  studentNo?: string;
  grade?: string | null;
  major?: string | null;
  programId?: number | null;
  admittedYear?: number | null;
  expectedGraduateAt?: string | null;
}

export function createUser(db: SqliteDb, input: CreateUserInput, actor: AuthUser): AuthUser {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(input.username);
  if (exists) throw conflict(`用户名 ${input.username} 已存在`);
  const now = nowIso();

  const id = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, display_name, role, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(input.username, hashPassword(input.password), input.displayName, input.role, now);
    const userId = Number(info.lastInsertRowid);
    if (input.role === 'student') {
      const studentNo = input.studentNo ?? input.username;
      if (db.prepare('SELECT user_id FROM students WHERE student_no = ?').get(studentNo)) {
        throw conflict(`学号 ${studentNo} 已存在`);
      }
      db.prepare(
        `INSERT INTO students (user_id, student_no, name, grade, major, program_id, admitted_year, expected_graduate_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        studentNo,
        input.displayName,
        input.grade ?? null,
        input.major ?? null,
        input.programId ?? null,
        input.admittedYear ?? null,
        input.expectedGraduateAt ?? null,
        now,
      );
    }
    return userId;
  })();

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'user.create',
    entityType: 'user',
    entityId: id,
    summary: `创建账号 ${input.username}（${input.role === 'admin' ? '管理员' : '学生'}）`,
  });

  const user = loadUserById(db, id);
  if (!user) throw new AppError(ERROR_CODES.INTERNAL, '账号创建后读取失败', 500);
  return user;
}

export function listUsers(
  db: SqliteDb,
  filter: { role?: Role; keyword?: string; limit: number; offset: number },
): { items: unknown[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.role) {
    conditions.push('u.role = ?');
    params.push(filter.role);
  }
  if (filter.keyword) {
    conditions.push('(u.username LIKE ? OR u.display_name LIKE ?)');
    params.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM users u ${where}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName, u.role, u.status,
              u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
              s.student_no AS studentNo, s.grade, s.major, s.program_id AS programId
       FROM users u LEFT JOIN students s ON s.user_id = u.id
       ${where}
       ORDER BY u.id
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset);
  return { items, total };
}

export function setUserStatus(db: SqliteDb, userId: number, status: 'active' | 'disabled', actor: AuthUser): void {
  if (actor.id === userId) throw forbidden('不能停用自己的账号');
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!row) throw notFound('账号不存在');
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  if (status === 'disabled') {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: status === 'disabled' ? 'user.disable' : 'user.enable',
    entityType: 'user',
    entityId: userId,
    summary: status === 'disabled' ? '停用账号' : '启用账号',
  });
}

export function resetPassword(db: SqliteDb, userId: number, newPassword: string, actor: AuthUser): void {
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!row) throw notFound('账号不存在');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'user.reset_password',
    entityType: 'user',
    entityId: userId,
    summary: '重置口令',
  });
}

export interface ImportedStudent {
  studentNo: string;
  name: string;
  grade?: string | null;
  major?: string | null;
  programCode?: string | null;
}

export interface ImportUsersResult {
  created: number;
  updated: number;
  skipped: Array<{ row: number; reason: string }>;
}

/** 批量导入账号：按学号新建或更新，默认口令由管理员指定 */
export function importStudents(
  db: SqliteDb,
  rows: ImportedStudent[],
  defaultPassword: string,
  actor: AuthUser,
): ImportUsersResult {
  const result: ImportUsersResult = { created: 0, updated: 0, skipped: [] };
  const now = nowIso();
  const hash = hashPassword(defaultPassword);

  db.transaction(() => {
    rows.forEach((row, index) => {
      if (!row.studentNo || !row.name) {
        result.skipped.push({ row: index + 1, reason: '缺少学号或姓名' });
        return;
      }
      const programId = row.programCode
        ? (db.prepare('SELECT id FROM programs WHERE code = ?').get(row.programCode) as { id: number } | undefined)?.id ?? null
        : null;
      const existing = db
        .prepare('SELECT u.id FROM users u JOIN students s ON s.user_id = u.id WHERE s.student_no = ?')
        .get(row.studentNo) as { id: number } | undefined;
      if (existing) {
        db.prepare('UPDATE students SET name = ?, grade = ?, major = ?, program_id = COALESCE(?, program_id) WHERE user_id = ?').run(
          row.name,
          row.grade ?? null,
          row.major ?? null,
          programId,
          existing.id,
        );
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(row.name, existing.id);
        result.updated += 1;
        return;
      }
      const info = db
        .prepare(
          `INSERT INTO users (username, password_hash, display_name, role, status, created_at)
           VALUES (?, ?, ?, 'student', 'active', ?)`,
        )
        .run(row.studentNo, hash, row.name, now);
      const userId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO students (user_id, student_no, name, grade, major, program_id, admitted_year, expected_graduate_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(userId, row.studentNo, row.name, row.grade ?? null, row.major ?? null, programId, now);
      result.created += 1;
    });
  })();

  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'user.import',
    entityType: 'user',
    summary: `批量导入账号：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped.length}`,
  });
  return result;
}
