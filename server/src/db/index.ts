/**
 * 数据库连接与迁移。
 *
 * 为什么用 user_version 手工迁移而不是 ORM：
 * 本项目的关键正确性依赖“容量占用”和“唯一约束”能否精确落库，
 * 手写 SQL 可以让每条约束都出现在 schema 里，也便于审查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 迁移目录解析。
 *
 * `tsc` 只编译 .ts，不会把 migrations/*.sql 复制到 dist/，
 * 因此直接 `node dist/index.js`（npm start）时 dist/db/migrations 可能不存在，
 * 会导致“新库/空库无法建表”（no such table: sessions）。
 * 这里按顺序找：与编译产物同级的 migrations → 源码目录 src/db/migrations。
 * 构建脚本仍会把 .sql 复制到 dist，使 dist 可独立部署；源码回退只作为兜底。
 */
const MIGRATIONS_DIR = (() => {
  const candidates = [
    path.join(here, 'migrations'),
    path.resolve(here, '..', '..', 'src', 'db', 'migrations'),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
})();

export type SqliteDb = Database.Database;

let cached: SqliteDb | null = null;

export interface OpenOptions {
  /** 传入 ':memory:' 用于测试 */
  filename?: string;
  /** 打开后立即执行迁移与基础配置（默认 true） */
  migrate?: boolean;
  readonly?: boolean;
}

export function openDatabase(options: OpenOptions = {}): SqliteDb {
  const filename = options.filename ?? config.dbPath;
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new Database(filename, { readonly: options.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (options.migrate !== false) {
    migrate(db);
  }
  return db;
}

/** 单例连接：正式运行时整个进程共用一个连接（better-sqlite3 是同步的，天然串行） */
export function getDatabase(): SqliteDb {
  if (!cached) {
    cached = openDatabase();
  }
  return cached;
}

export function closeDatabase(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

export function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** 当前数据库结构版本 */
export function currentVersion(db: SqliteDb): number {
  const row = db.pragma('user_version', { simple: true }) as number;
  return Number(row ?? 0);
}

/**
 * 按文件名顺序执行未应用的迁移文件。
 * 每个迁移在事务中执行，失败则整体回滚，不会留下半套结构。
 */
export function migrate(db: SqliteDb): number {
  const files = listMigrationFiles();
  let version = currentVersion(db);
  for (const file of files) {
    const fileVersion = Number.parseInt(file.slice(0, 3), 10);
    if (!Number.isInteger(fileVersion)) {
      throw new Error(`迁移文件名必须以三位版本号开头：${file}`);
    }
    if (fileVersion <= version) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${fileVersion}`);
    });
    run();
    version = fileVersion;
  }
  return version;
}
