/** 教学班时段与座位的小工具，供 catalog / allocation / rules 共用。 */
import type { SqliteDb } from '../../db/index.js';
import type { SessionLike } from '../../core/time.js';

export interface ClassSessionRow extends SessionLike {
  id: number;
  class_id: number;
  room: string | null;
  week_parity: 'all' | 'odd' | 'even' | string;
}

export function classSessions(db: SqliteDb, classIds: number[]): Map<number, ClassSessionRow[]> {
  const map = new Map<number, ClassSessionRow[]>();
  if (classIds.length === 0) return map;
  const placeholders = classIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity, room
       FROM class_sessions WHERE class_id IN (${placeholders}) ORDER BY day_of_week, period_start`,
    )
    .all(...classIds) as ClassSessionRow[];
  for (const row of rows) {
    const list = map.get(row.class_id) ?? [];
    list.push(row);
    map.set(row.class_id, list);
  }
  return map;
}

export function classCapacity(db: SqliteDb, classId: number): { capacity: number; reservedSeats: number } | null {
  const row = db.prepare('SELECT capacity, reserved_seats FROM teaching_classes WHERE id = ?').get(classId) as
    | { capacity: number; reserved_seats: number }
    | undefined;
  return row ? { capacity: row.capacity, reservedSeats: row.reserved_seats } : null;
}
