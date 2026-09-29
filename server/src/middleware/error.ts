/** 统一错误处理：把内部异常翻译成稳定的错误码，避免把 SQL 细节泄露给前端。 */
import type { NextFunction, Request, Response } from 'express';
import { AppError, ERROR_CODES } from '../core/errors.js';
import type { ErrorBody } from '../core/context.js';

interface SqliteError extends Error {
  code?: string;
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorBody = {
    ok: false,
    error: { code: ERROR_CODES.NOT_FOUND, message: `接口不存在：${req.method} ${req.path}` },
  };
  res.status(404).json(body);
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof AppError) {
    const body: ErrorBody = { ok: false, error: error.toJSON() };
    res.status(error.status).json(body);
    return;
  }

  if (error instanceof Error && error.name === 'TaskTimeoutError') {
    const body: ErrorBody = {
      ok: false,
      error: { code: ERROR_CODES.TASK_TIMEOUT, message: '计算超过单次上限，已放弃本次结果（未发布部分结果）' },
    };
    res.status(504).json(body);
    return;
  }

  // SQLite 约束错误：说明某条兜底约束被触发，属于并发或重复请求，翻译成可解释的提示
  const sqliteError = error as SqliteError;
  if (sqliteError?.code?.startsWith('SQLITE_CONSTRAINT')) {
    const message = sqliteError.message.includes('uq_enrollment_active_course')
      ? '该课程已有有效选课记录，不能重复选课'
      : sqliteError.message.includes('uq_submission_active')
        ? '已存在有效提交，请先撤回或重新提交'
        : '数据约束冲突，请刷新后重试';
    res.status(409).json({ ok: false, error: { code: ERROR_CODES.CONSTRAINT_VIOLATION, message } } satisfies ErrorBody);
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`[error] ${req.method} ${req.path}`, error);
  const body: ErrorBody = {
    ok: false,
    error: { code: ERROR_CODES.INTERNAL, message: '服务器内部错误，请查看后端日志' },
  };
  res.status(500).json(body);
}
