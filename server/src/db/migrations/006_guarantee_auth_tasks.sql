-- 006: 毕业兜底授权、候补顺位说明、分配任务发布字段与后台任务表
--
-- 背景（业务基线）：
--   * 学生的“毕业兜底授权”与“已有课程替换授权”必须分开建模。
--     替换授权（upgrade_authorizations）是学生同意用某门课替换另一门课；
--     兜底授权（本表的 guarantee_authorizations）是学生同意在明确的教学班范围内
--     接受系统为毕业必要课程做出的自动安排。没有兜底授权时系统不能自动扩大选择。
--   * 候补需要能解释“顺位为什么变化”，因此补一列 position_reason。
--   * 分配任务的幂等键必须能区分批次/模式/请求内容，并记录发布时刻与来源试算。
--   * 耗时分配与规划放入可跟踪的后台任务，接口返回任务标识，重启时不重复落位。

-- ---------------------------------------------------------------------------
-- 毕业兜底授权
-- ---------------------------------------------------------------------------
CREATE TABLE guarantee_authorizations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  batch_id    INTEGER NOT NULL REFERENCES selection_batches(id) ON DELETE CASCADE,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  -- 学生明确接受的教学班（JSON 数组）。为空表示“未接受任何教学班”，系统不得自动兜底。
  class_ids   TEXT    NOT NULL DEFAULT '[]',
  note        TEXT,
  status      TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  version_id  INTEGER REFERENCES data_versions(id),
  granted_by  INTEGER REFERENCES users(id),
  granted_at  TEXT    NOT NULL,
  expires_at  TEXT,
  used_at     TEXT,
  revoked_at  TEXT,
  -- 一名学生在一个批次内的一门课程只有一份兜底授权
  UNIQUE (student_id, batch_id, course_id)
);
CREATE INDEX idx_guarantee_auth ON guarantee_authorizations(batch_id, course_id, status);
CREATE INDEX idx_guarantee_auth_student ON guarantee_authorizations(student_id, status);

-- ---------------------------------------------------------------------------
-- 候补：顺位变化原因与来源
-- ---------------------------------------------------------------------------
ALTER TABLE waitlist_entries ADD COLUMN position_reason TEXT;
-- 来源：allocation（首轮落选转入）/ manual（学生新增）/ upgrade（授权升级候补）
ALTER TABLE waitlist_entries ADD COLUMN source TEXT;

-- ---------------------------------------------------------------------------
-- 分配任务：幂等请求指纹与发布信息
-- ---------------------------------------------------------------------------
ALTER TABLE allocation_runs ADD COLUMN request_hash TEXT;
ALTER TABLE allocation_runs ADD COLUMN published_at TEXT;
-- 发布时记录来源试算运行（支持“发布指定的、检查通过的试算结果”）
ALTER TABLE allocation_runs ADD COLUMN source_run_id INTEGER;

-- ---------------------------------------------------------------------------
-- 后台任务：耗时的分配与规划计算
-- ---------------------------------------------------------------------------
CREATE TABLE background_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('allocation', 'planning')),
  batch_id        INTEGER REFERENCES selection_batches(id) ON DELETE CASCADE,
  run_id          INTEGER REFERENCES allocation_runs(id) ON DELETE SET NULL,
  status          TEXT    NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timeout', 'cancelled')),
  progress        INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  result          TEXT,
  error_code      TEXT,
  error_message   TEXT,
  idempotency_key TEXT,
  request_hash    TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX idx_tasks_status ON background_tasks(status, kind);
CREATE INDEX idx_tasks_batch ON background_tasks(batch_id, created_at);
