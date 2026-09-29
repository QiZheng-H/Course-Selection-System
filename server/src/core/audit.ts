/**
 * 操作记录（审计）。
 * 要求：记录关键管理操作、资料版本、分配依据、授权和课表变更。
 */
import type { SqliteDb } from '../db/index.js';
import { nowIso, stableStringify } from './utils.js';

export interface AuditInput {
  actorId?: number | null;
  actorName?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | number;
  summary?: string;
  detail?: unknown;
}

export function writeAudit(db: SqliteDb, input: AuditInput): number {
  const info = db
    .prepare(
      `INSERT INTO audit_logs (actor_id, actor_name, action, entity_type, entity_id, summary, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.actorId ?? null,
      input.actorName ?? null,
      input.action,
      input.entityType ?? null,
      input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
      input.summary ?? null,
      input.detail === undefined ? null : stableStringify(input.detail),
      nowIso(),
    );
  return Number(info.lastInsertRowid);
}

export function listAudit(
  db: SqliteDb,
  filter: { limit?: number; offset?: number; action?: string; entityType?: string } = {},
): { rows: unknown[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.action) {
    conditions.push('action = ?');
    params.push(filter.action);
  }
  if (filter.entityType) {
    conditions.push('entity_type = ?');
    params.push(filter.entityType);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${where}`).get(...params) as { c: number };
  const rows = db
    .prepare(
      `SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit ?? 50, filter.offset ?? 0);
  return { rows, total: total.c };
}
