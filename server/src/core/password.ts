/**
 * 口令哈希与会话令牌。
 * 使用 Node 内置 scrypt（无需额外依赖），每个口令独立随机盐；
 * 校验使用时间安全比较，避免通过响应时间猜测口令。
 */
import crypto from 'node:crypto';
import { randomToken } from './utils.js';

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  let derived: string;
  try {
    derived = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function newSessionToken(): string {
  return randomToken(32);
}
