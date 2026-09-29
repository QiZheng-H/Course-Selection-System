/** 路由小工具：统一返回结构、参数读取。 */
import type { Request, RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/index.js';
import type { AppRequest } from './context.js';

export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

export type Handler = (req: AppRequest, res: Response) => unknown | Promise<unknown>;

/**
 * 包装处理器并挂载路由。
 *
 * 约定：`middlewares` 是 Express 风格的中间件（自行决定是否 next）；
 * 最后一个参数是业务处理器，它的返回值会被包装成 `{ ok: true, data }`。
 * 这样路由层可以自然地写 `handle(router, 'get', '/x', requireAuth, async (req) => ({...}))`。
 */
export function handle<H extends Handler>(
  router: Router,
  method: 'get' | 'post' | 'patch' | 'put' | 'delete',
  path: string,
  ...middlewaresAndHandler: [...RequestHandler[], H]
): void {
  const list = middlewaresAndHandler as unknown[];
  const handler = list[list.length - 1] as Handler;
  const middlewares = list.slice(0, -1) as RequestHandler[];

  const finalHandler = asyncHandler(async (req: Request, res: Response) => {
    const result = await handler(req as AppRequest, res);
    if (res.headersSent) return;
    if (result === undefined) {
      res.status(204).end();
      return;
    }
    ok(res, result);
  });

  router[method](path, ...middlewares, finalHandler);
}

export function str(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function num(value: unknown, fallback: number | null = null): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

export function intList(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((v) => Number(v)).filter((v) => Number.isInteger(v));
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v));
  }
  return [];
}
