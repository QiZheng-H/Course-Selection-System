/**
 * 请求上下文与通用返回结构。
 * 所有接口统一返回 { ok, data } 或 { ok: false, error: { code, message, details } }，
 * 前端只依赖 error.code 做分支，不解析中文文案。
 */
import type { Request } from 'express';
import type { SqliteDb } from '../db/index.js';
import type { ErrorCode } from './errors.js';

export type Role = 'student' | 'admin';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  /** 学生身份时的学号等信息 */
  student?: {
    studentNo: string;
    name: string;
    grade: string | null;
    major: string | null;
    programId: number | null;
  };
}

export interface RequestContext {
  db: SqliteDb;
  user: AuthUser | null;
  sessionToken: string | null;
  requestId: string;
}

export interface AppRequest extends Request {
  ctx: RequestContext;
}

export interface SuccessBody<T> {
  ok: true;
  data: T;
}

export interface ErrorBody {
  ok: false;
  error: {
    code: ErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
