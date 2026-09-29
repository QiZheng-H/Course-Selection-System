/**
 * 统一错误类型与错误码。
 *
 * 设计目标（来自验收要求）：错误必须可解释，
 * 要能区分容量不足、竞争落选、资格不符、时间冲突、授权失效、资料待确认等情况。
 * 因此所有业务失败都带一个稳定的 code，前端据此显示不同提示。
 */

export const ERROR_CODES = {
  // 参数与通用
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
  TASK_TIMEOUT: 'TASK_TIMEOUT',

  // 身份与权限
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  BAD_CREDENTIALS: 'BAD_CREDENTIALS',

  // 批次与时间
  BATCH_NOT_FOUND: 'BATCH_NOT_FOUND',
  BATCH_STATE_INVALID: 'BATCH_STATE_INVALID',
  BATCH_CONFIG_MISSING: 'BATCH_CONFIG_MISSING',
  BATCH_FROZEN: 'BATCH_FROZEN',
  SUBMISSION_CLOSED: 'SUBMISSION_CLOSED',
  SUBMISSION_EMPTY: 'SUBMISSION_EMPTY',
  SUBMISSION_STALE: 'SUBMISSION_STALE',

  // 规则
  TIME_CONFLICT: 'TIME_CONFLICT',
  DUPLICATE_COURSE: 'DUPLICATE_COURSE',
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  REQUIREMENT_UNAVAILABLE: 'REQUIREMENT_UNAVAILABLE',
  SUBSTITUTE_GROUP_VIOLATION: 'SUBSTITUTE_GROUP_VIOLATION',
  GRADUATION_INFEASIBLE: 'GRADUATION_INFEASIBLE',

  // 名额与竞争
  CLASS_NOT_FOUND: 'CLASS_NOT_FOUND',
  CLASS_CLOSED: 'CLASS_CLOSED',
  CLASS_CANCELLED: 'CLASS_CANCELLED',
  NO_CAPACITY: 'NO_CAPACITY',
  RESERVED_CAPACITY_ONLY: 'RESERVED_CAPACITY_ONLY',
  COMPETITION_LOST: 'COMPETITION_LOST',

  // 事务与授权
  NO_ENROLLMENT: 'NO_ENROLLMENT',
  AUTHORIZATION_REQUIRED: 'AUTHORIZATION_REQUIRED',
  AUTHORIZATION_INVALIDATED: 'AUTHORIZATION_INVALIDATED',
  AUTHORIZATION_SUSPENDED: 'AUTHORIZATION_SUSPENDED',
  MATERIAL_NOT_CONFIRMED: 'MATERIAL_NOT_CONFIRMED',
  MATERIAL_CHANGED: 'MATERIAL_CHANGED',
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
  WAITLIST_NOT_PROMOTABLE: 'WAITLIST_NOT_PROMOTABLE',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 业务错误：可安全返回给客户端 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(ERROR_CODES.BAD_REQUEST, message, 400, details);
export const validationFailed = (message: string, details?: Record<string, unknown>) =>
  new AppError(ERROR_CODES.VALIDATION_FAILED, message, 422, details);
export const notFound = (message: string) => new AppError(ERROR_CODES.NOT_FOUND, message, 404);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError(ERROR_CODES.CONFLICT, message, 409, details);
export const unauthenticated = (message = '请先登录') => new AppError(ERROR_CODES.UNAUTHENTICATED, message, 401);
export const forbidden = (message = '没有权限执行该操作') => new AppError(ERROR_CODES.FORBIDDEN, message, 403);
export const noCapacity = (message = '教学班名额已满', details?: Record<string, unknown>) =>
  new AppError(ERROR_CODES.NO_CAPACITY, message, 409, details);
export const timeConflict = (message = '与已选课程时间冲突', details?: Record<string, unknown>) =>
  new AppError(ERROR_CODES.TIME_CONFLICT, message, 409, details);
