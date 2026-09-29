-- 004: 其它资料类型的版本 scope 与预分配批次外键修正
--
-- 背景：001 中 data_versions.scope 的取值集合没有包含 preallocation，
-- 而导入发布逻辑会用导入批次的 kind 作为 scope，发布预分配导入时会触发 CHECK 失败。
-- 同时 preallocation_results.batch_id 的外键误指向 import_batches，而接口按“选课批次”使用。
--
-- SQLite 不支持修改已有的 CHECK / 外键，因此这里按官方推荐的
-- “新建表 → 搬数据 → 删旧表 → 改名 → 重建索引”方式重建这两张表。
-- 迁移在一个事务内执行（见 db/index.ts），失败会整体回滚。

-- ---------------------------------------------------------------------------
-- data_versions：scope 增加 preallocation
-- ---------------------------------------------------------------------------
CREATE TABLE data_versions_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope         TEXT    NOT NULL CHECK (scope IN ('courses', 'classes', 'program', 'records', 'config', 'preallocation')),
  version_no    INTEGER NOT NULL,
  content_hash  TEXT    NOT NULL,
  summary       TEXT,
  batch_id      INTEGER REFERENCES import_batches(id),
  published_by  INTEGER REFERENCES users(id),
  published_at  TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (scope, version_no)
);
INSERT INTO data_versions_new (id, scope, version_no, content_hash, summary, batch_id, published_by, published_at, active)
  SELECT id, scope, version_no, content_hash, summary, batch_id, published_by, published_at, active FROM data_versions;
DROP TABLE data_versions;
ALTER TABLE data_versions_new RENAME TO data_versions;
CREATE INDEX idx_versions_active ON data_versions(scope, active);

-- ---------------------------------------------------------------------------
-- preallocation_results：batch_id 改为指向选课批次
-- ---------------------------------------------------------------------------
CREATE TABLE preallocation_results_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id   INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  class_id     INTEGER NOT NULL REFERENCES teaching_classes(id) ON DELETE CASCADE,
  batch_id     INTEGER REFERENCES selection_batches(id) ON DELETE SET NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'applied', 'failed', 'reverted')),
  failure_code TEXT,
  reason       TEXT,
  margin       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  applied_at   TEXT,
  UNIQUE (student_id, class_id)
);
INSERT INTO preallocation_results_new
  (id, student_id, class_id, batch_id, status, failure_code, reason, margin, created_at, applied_at)
  SELECT pr.id, pr.student_id, pr.class_id,
         -- 旧数据里 batch_id 指向导入批次，含义已经不同：改成 NULL（表示未关联选课批次）
         NULL, pr.status, pr.failure_code, pr.reason, pr.margin, pr.created_at, pr.applied_at
    FROM preallocation_results pr;
DROP TABLE preallocation_results;
ALTER TABLE preallocation_results_new RENAME TO preallocation_results;
CREATE INDEX idx_prealloc_student ON preallocation_results(student_id, status);
