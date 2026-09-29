/** 通用工具：时间、哈希、随机键、分页。 */
import crypto from 'node:crypto';

/** 全部时间统一用 ISO 字符串存库，避免时区歧义 */
export function nowIso(): string {
  return new Date().toISOString();
}

export function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();
}

export function isPast(iso: string | null | undefined, at: string = nowIso()): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() <= new Date(at).getTime();
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 稳定序列化：对象键排序后再序列化，保证同样的内容得到同样的哈希 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = walk(obj[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export function contentHash(value: unknown): string {
  return sha256(stableStringify(value));
}

/**
 * 固定随机键。
 * 要求：同学期“学生＋课程”唯一、同课不同班共用，重交/重试/重新加入都不重抽。
 * 因此用确定性哈希派生，而不是 Math.random()。
 */
export function deriveRandomKey(seed: string, studentId: number, courseId: number): string {
  return sha256(`${seed}:${studentId}:${courseId}`);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

export function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export class Deadline {
  private readonly start = Date.now();

  constructor(private readonly limitMs: number) {}

  get elapsed(): number {
    return Date.now() - this.start;
  }

  get expired(): boolean {
    // limitMs <= 0 表示“立即超时”，因此第一个检查点就要失败
    return this.limitMs <= 0 || this.elapsed > this.limitMs;
  }

  assert(message = '计算超时'): void {
    if (this.expired) {
      const err = new Error(message);
      err.name = 'TaskTimeoutError';
      throw err;
    }
  }
}
