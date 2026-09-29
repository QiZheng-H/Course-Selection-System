/**
 * 统一 fetch 封装。
 *
 * 约定（与后端 server/src/core/context.ts 一致）：
 *   - 成功：{ ok: true, data }
 *   - 失败：{ ok: false, error: { code, message, details } }
 * 前端只依赖 error.code 做分支，不解析后端中文文案。
 *
 * 会话使用 httpOnly cookie，因此所有请求都带 credentials: 'include'。
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** 由 router 注册：收到 401 时清理会话并跳转登录页 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export type QueryValue = string | number | boolean | null | undefined;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  formData?: FormData;
  /** 查询参数；值为 undefined / null / '' 时自动忽略 */
  query?: Record<string, QueryValue>;
  /** 登录页探测会话时使用，避免 401 触发跳转循环 */
  skipAuthRedirect?: boolean;
}

function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

interface ErrorBody {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;

  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}${buildQuery(options.query)}`, {
      method,
      headers,
      body,
      credentials: 'include',
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', '无法连接后端服务，请确认服务已启动（默认 http://127.0.0.1:3001）', 0);
  }

  const text = await response.text();
  let payload: ErrorBody = {};
  if (text) {
    try {
      payload = JSON.parse(text) as ErrorBody;
    } catch {
      payload = {};
    }
  }

  if (response.ok && payload.ok === true) {
    return payload.data as T;
  }

  const code = payload.error?.code ?? (response.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL');
  const message = payload.error?.message ?? `请求失败（HTTP ${response.status}）`;
  const details = payload.error?.details;

  if (code === 'UNAUTHENTICATED' && !options.skipAuthRedirect) {
    unauthorizedHandler?.();
  }
  throw new ApiError(code, message, response.status, details);
}

export const api = {
  get<T>(path: string, query?: Record<string, QueryValue>, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'GET', query });
  },
  post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'POST', body });
  },
  put<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'PUT', body });
  },
  patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'PATCH', body });
  },
  del<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'DELETE' });
  },
  /** multipart 上传（资料导入）：不要手动设置 content-type */
  upload<T>(path: string, formData: FormData, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'POST', formData });
  },
};
