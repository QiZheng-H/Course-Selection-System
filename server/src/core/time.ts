/**
 * 教学周与节次的冲突判断。
 *
 * 规则：两个人（或两门课）占用同一个“星期 + 节次 + 教学周”才算冲突。
 * 单双周和起止周都要考虑：例如 1-16 周与 3-5 周只有在交集周里才冲突。
 */

export interface SessionLike {
  day_of_week: number;
  period_start: number;
  period_end: number;
  week_start: number;
  week_end: number;
  week_parity: 'all' | 'odd' | 'even' | string;
}

/** 节次区间是否相交 */
export function periodsOverlap(a: SessionLike, b: SessionLike): boolean {
  return a.period_start <= b.period_end && b.period_start <= a.period_end;
}

/**
 * 展开为具体的教学周集合（考虑单双周）。
 * 只对 [1, 30] 的合理范围展开，用于精确求交集。
 */
export function expandWeeks(session: SessionLike): number[] {
  const start = Math.max(1, Math.min(session.week_start, session.week_end));
  const end = Math.min(30, Math.max(session.week_start, session.week_end));
  const weeks: number[] = [];
  for (let w = start; w <= end; w += 1) {
    if (session.week_parity === 'odd' && w % 2 === 0) continue;
    if (session.week_parity === 'even' && w % 2 === 1) continue;
    weeks.push(w);
  }
  return weeks;
}

/** 两个时段共同占用的教学周 */
export function overlappingWeeks(a: SessionLike, b: SessionLike): number[] {
  const setB = new Set(expandWeeks(b));
  return expandWeeks(a).filter((w) => setB.has(w));
}

export function sessionsConflict(a: SessionLike, b: SessionLike): boolean {
  if (a.day_of_week !== b.day_of_week) return false;
  if (!periodsOverlap(a, b)) return false;
  return overlappingWeeks(a, b).length > 0;
}

export interface ConflictPair<A, B> {
  left: A;
  right: B;
  weeks: number[];
}

/** 两组时段之间是否存在冲突，并给出冲突的具体周次（用于解释给用户看） */
export function findConflicts<A extends SessionLike, B extends SessionLike>(
  left: A[],
  right: B[],
): ConflictPair<A, B>[] {
  const out: ConflictPair<A, B>[] = [];
  for (const a of left) {
    for (const b of right) {
      const weeks = a.day_of_week === b.day_of_week && periodsOverlap(a, b) ? overlappingWeeks(a, b) : [];
      if (weeks.length > 0) {
        out.push({ left: a, right: b, weeks });
      }
    }
  }
  return out;
}

/** 把时段渲染成中文，用于提示与文档 */
export function describeSession(session: SessionLike): string {
  const dayNames = ['', '一', '二', '三', '四', '五', '六', '日'];
  const parity = session.week_parity === 'odd' ? '单周' : session.week_parity === 'even' ? '双周' : '';
  const period =
    session.period_start === session.period_end
      ? `第${session.period_start}节`
      : `第${session.period_start}-${session.period_end}节`;
  return `周${dayNames[session.day_of_week] ?? session.day_of_week} ${period}（第${session.week_start}-${session.week_end}周${parity}）`;
}

export function describeWeeks(weeks: number[]): string {
  if (weeks.length === 0) return '无交集';
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  return `第${sorted.join('、')}周`;
}
