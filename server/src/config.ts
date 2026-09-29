/**
 * 运行时配置。
 * 默认值面向本机演示；可以通过环境变量覆盖，不改代码。
 * 学分上限、选课时间等“业务配置”不在代码里写死，存放在 app_configs 表中由管理员维护。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  /** HTTP 端口 */
  port: envInt('PORT', 3001),
  host: envStr('HOST', '127.0.0.1'),
  /** SQLite 文件位置：默认 server/data/course-selection.db */
  dbPath: envStr('DB_PATH', path.join(serverRoot, 'data', 'course-selection.db')),
  /** 会话有效期（小时） */
  sessionTtlHours: envInt('SESSION_TTL_HOURS', 12),
  /** 规划 / 分配任务的单次计算上限（毫秒），超时不发布部分结果 */
  taskTimeoutMs: envInt('TASK_TIMEOUT_MS', 60_000),
  /** 预分配默认调整余量（管理员可在数据里覆盖） */
  preallocationMargin: envInt('PREALLOCATION_MARGIN', 2),
  /** 登录失败节流：同一用户名连续失败上限 */
  loginMaxFailures: envInt('LOGIN_MAX_FAILURES', 10),
  isTest: process.env.NODE_ENV === 'test',
  serverRoot,
} as const;

export type AppConfig = typeof config;
