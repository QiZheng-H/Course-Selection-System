/** 登录、会话与当前用户。 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, unauthenticated } from '../../core/errors.js';
import { newSessionToken, hashPassword, verifyPassword } from '../../core/password.js';
import { addHours, nowIso } from '../../core/utils.js';
import { config } from '../../config.js';
import type { AuthUser, Role } from '../../core/context.js';
import { writeAudit } from '../../core/audit.js';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: Role;
  status: 'active' | 'disabled';
}

export function loadUserById(db: SqliteDb, userId: number): AuthUser | null {
  const row = db
    .prepare('SELECT id, username, display_name, role, status FROM users WHERE id = ?')
    .get(userId) as Omit<UserRow, 'password_hash'> | undefined;
  if (!row || row.status !== 'active') return null;
  const user: AuthUser = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
  };
  if (row.role === 'student') {
    const student = db
      .prepare('SELECT student_no, name, grade, major, program_id FROM students WHERE user_id = ?')
      .get(row.id) as { student_no: string; name: string; grade: string | null; major: string | null; program_id: number | null } | undefined;
    if (student) {
      user.student = {
        studentNo: student.student_no,
        name: student.name,
        grade: student.grade,
        major: student.major,
        programId: student.program_id,
      };
    }
  }
  return user;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

export function login(db: SqliteDb, username: string, password: string, userAgent?: string): LoginResult {
  const row = db
    .prepare('SELECT id, username, password_hash, display_name, role, status FROM users WHERE username = ?')
    .get(username) as UserRow | undefined;

  // 用户名不存在与口令错误返回同样的错误，避免泄露账号是否存在
  if (!row || !verifyPassword(password, row.password_hash)) {
    writeAudit(db, { action: 'auth.login_failed', entityType: 'user', entityId: row?.id, actorName: username, summary: '登录失败' });
    throw new AppError(ERROR_CODES.BAD_CREDENTIALS, '用户名或密码不正确', 401);
  }
  if (row.status !== 'active') {
    throw new AppError(ERROR_CODES.ACCOUNT_DISABLED, '账号已被停用，请联系管理员', 403);
  }

  const token = newSessionToken();
  const created = nowIso();
  const expires = addHours(created, config.sessionTtlHours);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)').run(
    token,
    row.id,
    created,
    expires,
    userAgent ?? null,
  );
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(created, row.id);

  const user = loadUserById(db, row.id);
  if (!user) {
    throw unauthenticated('账号状态异常');
  }
  writeAudit(db, { actorId: row.id, actorName: row.username, action: 'auth.login', entityType: 'user', entityId: row.id, summary: '登录成功' });
  return { token, expiresAt: expires, user };
}

export function logout(db: SqliteDb, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function resolveSession(db: SqliteDb, token: string | null): AuthUser | null {
  if (!token) return null;
  const row = db
    .prepare('SELECT token, user_id, expires_at FROM sessions WHERE token = ?')
    .get(token) as { token: string; user_id: number; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return loadUserById(db, row.user_id);
}

export function purgeExpiredSessions(db: SqliteDb): number {
  const info = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
  return info.changes;
}

export function changePassword(db: SqliteDb, userId: number, oldPassword: string, newPassword: string): void {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
  if (!row) throw unauthenticated();
  if (!verifyPassword(oldPassword, row.password_hash)) {
    throw new AppError(ERROR_CODES.BAD_CREDENTIALS, '原密码不正确', 400);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  // 改密码后其它会话失效
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
