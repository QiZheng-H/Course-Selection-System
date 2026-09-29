/**
 * 按后端错误码生成可读提示。
 * 与 server/src/core/errors.ts 的 ERROR_CODES 保持一致。
 */
import { ApiError } from './client';
import type { ScheduleConflict, ValidationIssue } from './types';

const CODE_TITLES: Record<string, string> = {
  BAD_REQUEST: '请求参数有误',
  VALIDATION_FAILED: '校验未通过',
  NOT_FOUND: '数据不存在',
  CONFLICT: '操作冲突',
  INTERNAL: '服务器内部错误',
  TASK_TIMEOUT: '计算超时',
  UNAUTHENTICATED: '请先登录',
  FORBIDDEN: '没有权限执行该操作',
  ACCOUNT_DISABLED: '账号已被停用',
  BAD_CREDENTIALS: '用户名或密码不正确',
  BATCH_NOT_FOUND: '选课活动不存在',
  BATCH_STATE_INVALID: '当前阶段不允许该操作',
  BATCH_CONFIG_MISSING: '必需配置缺失',
  BATCH_FROZEN: '本轮已结束志愿提交，暂时不能改选',
  SUBMISSION_CLOSED: '本轮志愿已截止',
  SUBMISSION_EMPTY: '志愿为空',
  SUBMISSION_STALE: '提交版本已过期',
  TIME_CONFLICT: '时间冲突',
  DUPLICATE_COURSE: '重复选课',
  CREDIT_LIMIT_EXCEEDED: '超出学分上限',
  NOT_ELIGIBLE: '不满足选课资格',
  REQUIREMENT_UNAVAILABLE: '培养需求无法满足',
  SUBSTITUTE_GROUP_VIOLATION: '替代组规则冲突',
  GRADUATION_INFEASIBLE: '毕业保障联合无解',
  CLASS_NOT_FOUND: '教学班不存在',
  CLASS_CLOSED: '教学班已关闭选课',
  CLASS_CANCELLED: '教学班已取消',
  NO_CAPACITY: '名额已满',
  RESERVED_CAPACITY_ONLY: '只剩毕业保障预留名额',
  COMPETITION_LOST: '竞争落选',
  NO_ENROLLMENT: '没有有效的选课记录',
  AUTHORIZATION_REQUIRED: '需要替换授权',
  AUTHORIZATION_INVALIDATED: '替换授权已失效',
  AUTHORIZATION_SUSPENDED: '替换授权当前不可用',
  MATERIAL_NOT_CONFIRMED: '个人修读资料待确认',
  MATERIAL_CHANGED: '关键资料已更新，需要重新确认',
  IDEMPOTENCY_MISMATCH: '检测到重复提交了不同内容，请刷新页面后重试',
  WAITLIST_NOT_PROMOTABLE: '候补当前不可提升',
  CONSTRAINT_VIOLATION: '数据约束冲突，请刷新后重试',
  NETWORK_ERROR: '无法连接后端服务',
};

export interface ApiErrorInfo {
  code: string;
  title: string;
  message: string;
  lines: string[];
}

function formatDetails(details?: Record<string, unknown>): string[] {
  if (!details) return [];
  const lines: string[] = [];

  const conflicts = details.conflicts;
  if (Array.isArray(conflicts)) {
    for (const raw of conflicts) {
      const conflict = raw as Partial<ScheduleConflict>;
      if (!conflict.leftCourseName) continue;
      const weeks = Array.isArray(conflict.weeks) && conflict.weeks.length > 0 ? `（第 ${conflict.weeks.join('、')} 周）` : '';
      lines.push(
        `${conflict.leftCourseName}（${conflict.leftText ?? ''}）与 ${conflict.rightCourseName}（${conflict.rightText ?? ''}）冲突${weeks}`,
      );
    }
  }

  const issues = details.issues;
  if (Array.isArray(issues)) {
    for (const raw of issues) {
      const issue = raw as Partial<ValidationIssue>;
      if (!issue.message) continue;
      lines.push(`${issue.level === 'warning' ? '提示' : '错误'}：${issue.message}`);
    }
  }

  const students = details.students;
  if (Array.isArray(students) && students.length > 0) {
    const names = students
      .map((raw) => {
        const student = raw as { name?: string; studentNo?: string };
        return student.name ? `${student.name}(${student.studentNo ?? ''})` : '';
      })
      .filter(Boolean);
    if (names.length > 0) lines.push(`涉及学生：${names.slice(0, 20).join('、')}${students.length > 20 ? ' 等' : ''}`);
  }

  if (typeof details.credits === 'number' && typeof details.limit === 'number') {
    lines.push(`替换后总学分 ${details.credits}，上限 ${details.limit}`);
  }
  if (typeof details.capacity === 'number') {
    lines.push(
      `容量 ${details.capacity}，已选 ${String(details.enrolled ?? '—')}，已用预留 ${String(details.usedReserved ?? 0)}，预留 ${String(details.reservedSeats ?? 0)}`,
    );
  }
  if (typeof details.openExceptions === 'number') {
    lines.push(`未处理的关键异常：${details.openExceptions} 条`);
  }
  if (typeof details.message === 'string' && details.message) {
    lines.push(details.message);
  }
  return lines;
}

export function apiErrorInfo(error: unknown, fallbackTitle = '操作失败'): ApiErrorInfo {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      title: CODE_TITLES[error.code] ?? fallbackTitle,
      message: error.message,
      lines: formatDetails(error.details),
    };
  }
  if (error instanceof Error) {
    return { code: 'UNKNOWN', title: fallbackTitle, message: error.message, lines: [] };
  }
  return { code: 'UNKNOWN', title: fallbackTitle, message: String(error), lines: [] };
}

export function isApiErrorCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}
