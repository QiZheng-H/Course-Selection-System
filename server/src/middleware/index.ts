/** 中间件：请求上下文、会话鉴权、角色校验、统一错误处理。 */
import type { NextFunction, Request, Response } from 'express';
import { AppError, ERROR_CODES, forbidden, unauthenticated } from '../core/errors.js';
import type { AppRequest, AuthUser } from '../core/context.js';
import { getDatabase, type SqliteDb } from '../db/index.js';
import { randomToken } from '../core/utils.js';
import { resolveSession } from '../modules/auth/service.js';

declare module 'express-serve-static-core' {
  interface Request {
    ctx?: AppRequest['ctx'];
  }
}

/**
 * 请求上下文中间件。
 * 默认使用全局单例数据库；测试可以传入自己的数据库，从而复用同一套路由。
 */
export function createRequestContext(provide: () => SqliteDb = getDatabase) {
  return function requestContext(req: Request, _res: Response, next: NextFunction): void {
    attachContext(provide(), req, next);
  };
}

function attachContext(db: SqliteDb, req: Request, next: NextFunction): void {
  const token = (req.cookies?.session as string | undefined) ?? null;
  let user: AuthUser | null = null;
  if (token) {
    try {
      user = resolveSession(db, token);
    } catch {
      user = null;
    }
  }
  req.ctx = {
    db,
    user,
    sessionToken: token,
    requestId: randomToken(8),
  };
  next();
}

/** 生产环境使用的上下文中间件（全局单例数据库） */
export const requestContext = createRequestContext();

/** 必须登录 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.ctx?.user) {
    next(unauthenticated());
    return;
  }
  next();
}

/** 必须是管理员 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.ctx?.user) {
    next(unauthenticated());
    return;
  }
  if (req.ctx.user.role !== 'admin') {
    next(forbidden('该操作仅管理员可用'));
    return;
  }
  next();
}

/** 必须是学生本人：管理员可以按 studentId 查询，学生只能访问自己 */
export function resolveStudentScope(req: Request): number {
  const user = req.ctx?.user;
  if (!user) throw unauthenticated();
  const requested = req.params.studentId ?? req.query.studentId;
  if (user.role === 'admin') {
    if (requested === undefined) {
      throw new AppError(ERROR_CODES.BAD_REQUEST, '管理员调用该接口需要提供 studentId', 400);
    }
    const id = Number.parseInt(String(requested), 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(ERROR_CODES.BAD_REQUEST, 'studentId 不合法', 400);
    }
    return id;
  }
  if (requested !== undefined && Number.parseInt(String(requested), 10) !== user.id) {
    throw forbidden('学生只能访问自己的数据');
  }
  return user.id;
}

/** 把同步抛错和 Promise 拒绝都交给统一错误处理 */
export function asyncHandler<T extends Request = Request>(
  handler: (req: T & AppRequest, res: Response, next: NextFunction) => unknown,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = handler(req as T & AppRequest, res, next);
      if (result instanceof Promise) {
        result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}
