/** 参数校验辅助：基于 zod，把校验失败统一转成 VALIDATION_FAILED。 */
import { z, type ZodTypeAny } from 'zod';
import { validationFailed } from '../core/errors.js';

export function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown, what = '请求参数'): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details: Record<string, unknown> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.') || '(root)';
      details[path] = issue.message;
    }
    throw validationFailed(`${what}不合法：${Object.entries(details).map(([k, v]) => `${k} ${v}`).join('；')}`, details);
  }
  return result.data;
}

export const idParam = (value: unknown, what = 'ID'): number => {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw validationFailed(`${what} 必须是正整数`);
  }
  return n;
};

/** 查询串里的 page / pageSize */
export function pagination(query: Record<string, unknown>, defaultSize = 20): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const rawSize = Number.parseInt(String(query.pageSize ?? defaultSize), 10) || defaultSize;
  const pageSize = Math.min(200, Math.max(1, rawSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export const zInt = (min = -Infinity, max = Infinity) =>
  z.coerce.number().int().min(min).max(max);
