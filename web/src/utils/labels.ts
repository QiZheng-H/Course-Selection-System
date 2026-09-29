/** 展示用文案与格式化工具（只做展示，不参与任何业务判断）。 */
import type { BatchStatus, GridSession } from '@/api/types';

/** 面向业务的阶段名称（不向管理员暴露内部状态名） */
export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  preparing: '资料准备',
  preview: '预选进行中',
  open: '预选进行中',
  frozen: '已结束提交，待生成方案',
  published: '结果已公布（退改选未开放）',
  waitlist: '退改选进行中',
  closed: '已结束',
};

/** 学生现在能不能选退课：只有管理员开放退改选后才可以 */
export function admissionOpen(status: string | null | undefined): boolean {
  return status === 'waitlist';
}

export const COURSE_TYPE_LABEL: Record<string, string> = {
  required: '必修',
  limited_elective: '限选',
  elective: '任选',
  general: '通识',
};

export const SOURCE_LABEL: Record<string, string> = {
  preallocation: '预分配',
  allocation: '统一分配',
  guarantee: '毕业保障',
  waitlist: '候补提升',
  upgrade: '授权替换',
  manual: '手工选课',
};

export const RECORD_STATUS_LABEL: Record<string, string> = {
  passed: '已通过',
  failed: '未通过',
  in_progress: '在修',
  selected: '已选',
};

export const PREFERENCE_STATE_LABEL: Record<string, string> = {
  pending: '待定',
  allocated: '已落实',
  superseded: '已被更高偏好关闭',
};

export const WAITLIST_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  suspended: '暂挂',
  promoted: '已提升',
  closed: '已关闭',
  withdrawn: '已退出',
};

export const AUTHORIZATION_STATUS_LABEL: Record<string, string> = {
  active: '有效',
  pending: '待生效',
  used: '已使用',
  invalidated: '已失效',
  suspended: '已暂停',
};

export const IMPORT_KIND_LABEL: Record<string, string> = {
  courses: '课程',
  classes: '教学班',
  program: '培养方案',
  records: '修读记录',
  preallocation: '预分配',
};

export const SEVERITY_LABEL: Record<string, string> = {
  info: '提示',
  warning: '警告',
  critical: '严重',
};

export const DECISION_LABEL: Record<string, string> = {
  allocated: '已分配',
  rejected: '未分配',
  waitlisted: '转入候补',
  error: '异常',
};

export const OP_TYPE_LABEL: Record<string, string> = {
  enroll: '选课',
  drop: '退课',
  swap: '同课换班',
  replace: '一对一替换',
  upgrade: '授权升级',
  allocate: '统一分配',
  promote: '候补提升',
  preallocate: '预分配',
};

export function courseTypeLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return COURSE_TYPE_LABEL[value] ?? value;
}

export function sourceLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return SOURCE_LABEL[value] ?? value;
}

export function batchStatusLabel(value: BatchStatus | string | null | undefined): string {
  if (!value) return '—';
  return BATCH_STATUS_LABEL[value as BatchStatus] ?? value;
}

export function recordStatusLabel(value: string): string {
  return RECORD_STATUS_LABEL[value] ?? value;
}

export function waitlistStatusLabel(value: string): string {
  return WAITLIST_STATUS_LABEL[value] ?? value;
}

export function preferenceStateLabel(value: string): string {
  return PREFERENCE_STATE_LABEL[value] ?? value;
}

export function authorizationStatusLabel(value: string): string {
  return AUTHORIZATION_STATUS_LABEL[value] ?? value;
}

export function importKindLabel(value: string): string {
  return IMPORT_KIND_LABEL[value] ?? value;
}

export function severityLabel(value: string): string {
  return SEVERITY_LABEL[value] ?? value;
}

export function decisionLabel(value: string): string {
  return DECISION_LABEL[value] ?? value;
}

export function opTypeLabel(value: string): string {
  return OP_TYPE_LABEL[value] ?? value;
}

/** 把课程类型映射成徽标样式名 */
export function courseTypeClass(value: string | null | undefined): string {
  return value ? `badge badge--${value}` : 'badge';
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatCredits(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 把 datetime-local 输入值转成后端可接受的 ISO 字符串 */
export function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** 把后端 ISO 时间转成 datetime-local 输入框的值 */
export function toDateTimeLocal(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const DAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];

export function sessionText(session: GridSession): string {
  if (session.text) return session.text;
  const day = DAY_NAMES[session.dayOfWeek] ?? '?';
  const parity = session.weekParity === 'odd' ? '单周' : session.weekParity === 'even' ? '双周' : '';
  const weeks =
    session.weekStart && session.weekEnd ? `（${session.weekStart}-${session.weekEnd}周${parity}）` : parity ? `（${parity}）` : '';
  return `周${day} 第${session.periodStart}-${session.periodEnd}节${weeks}`;
}

export function demandLabel(level: string | null | undefined): string {
  if (level === 'D2') return '本期必须完成';
  if (level === 'D1') return '建议补足';
  if (level === 'D0') return '兴趣课程';
  return '—';
}

/**
 * 培养需求的颜色级别。
 * 只让“本期必须完成”抢眼：如果所有课程都标红，等于没有标记。
 */
export function demandTone(level: string | null | undefined): 'critical' | 'warn' | 'muted' {
  if (level === 'D2') return 'critical';
  if (level === 'D1') return 'warn';
  return 'muted';
}

export const PREVIEW_STATUS_LABEL: Record<string, string> = {
  feasible: '可排入课表',
  conflict: '时间冲突',
  no_seat: '名额已满',
  over_limit: '超出学分上限',
  no_class: '本学期未开课',
};

export function previewStatusLabel(status: string): string {
  return PREVIEW_STATUS_LABEL[status] ?? status;
}

export function previewStatusClass(status: string): string {
  if (status === 'feasible') return 'badge badge--ok';
  if (status === 'conflict' || status === 'over_limit') return 'badge badge--danger';
  return 'badge badge--warn';
}
