-- =====================================================================
-- 选课系统数据库结构 v1（对应迁移 001_init.sql）
--
-- 注意：这里只是 001 的基线结构。后续结构变更以 src/db/migrations/ 下的迁移为准：
--   002 term_required_courses
--   003 preference_drafts
--   004 data_versions.scope 扩展与 preallocation_results 外键修正
--   005 source_confirmations.version_id 允许为空
--   006 guarantee_authorizations、waitlist_entries.position_reason/source、
--       allocation_runs.request_hash/published_at/source_run_id、background_tasks
-- 完整数据字典见 docs/数据库设计.md。
-- =====================================================================
-- =====================================================================
-- 选课系统数据库结构 v1
-- 目标：SQLite (better-sqlite3)，单机单后端实例
-- 设计原则：
--   1) 名额（seat）是唯一会被并发争抢的资源，只有正式选课服务可以改动它；
--   2) 所有影响竞争结果的数据都带版本或快照，保证重试、重交不改变结果；
--   3) 竞争使用的随机信息固定存储，不依赖运行时随机数；
--   4) 关键规则（唯一约束、容量、状态流转）在数据库层也做兜底约束。
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- 1. 账号与权限
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('student', 'admin')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT    NOT NULL,
  last_login_at TEXT
);

CREATE TABLE students (
  user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  student_no           TEXT    NOT NULL UNIQUE,
  name                 TEXT    NOT NULL,
  grade                TEXT,
  major                TEXT,
  program_id           INTEGER,                       -- 外键在培养方案表建立后补充（见下方 ALTER）
  admitted_year        INTEGER,
  expected_graduate_at TEXT,
  created_at           TEXT    NOT NULL
);

-- 服务器会话（不使用 JWT，会话可随时撤销）
CREATE TABLE sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------
-- 2. 课程与教学班
-- ---------------------------------------------------------------------
CREATE TABLE courses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  credits       REAL    NOT NULL CHECK (credits > 0),
  department    TEXT,
  course_type   TEXT    NOT NULL DEFAULT 'elective'
                        CHECK (course_type IN ('required', 'limited_elective', 'elective', 'general')),
  description   TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX idx_courses_type ON courses(course_type);

CREATE TABLE teachers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  department TEXT,
  title      TEXT
);

CREATE TABLE teaching_classes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id       INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  class_code      TEXT    NOT NULL UNIQUE,
  term            TEXT    NOT NULL,
  teacher_id      INTEGER REFERENCES teachers(id),
  capacity        INTEGER NOT NULL CHECK (capacity >= 0),
  reserved_seats  INTEGER NOT NULL DEFAULT 0 CHECK (reserved_seats >= 0),
  status          TEXT    NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'closed', 'cancelled')),
  campus          TEXT,
  note            TEXT,
  created_at      TEXT    NOT NULL,
  -- 预留名额不得超过总容量（毕业预留）
  CHECK (reserved_seats <= capacity)
);
CREATE INDEX idx_classes_course ON teaching_classes(course_id);
CREATE INDEX idx_classes_term ON teaching_classes(term, status);

-- 上课时间：一个教学班可以有多个时段（含单双周与起止教学周）
CREATE TABLE class_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id      INTEGER NOT NULL REFERENCES teaching_classes(id) ON DELETE CASCADE,
  day_of_week   INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),  -- 1=周一
  period_start  INTEGER NOT NULL CHECK (period_start BETWEEN 1 AND 14),
  period_end    INTEGER NOT NULL CHECK (period_end BETWEEN 1 AND 14),
  week_start    INTEGER NOT NULL CHECK (week_start BETWEEN 1 AND 30),
  week_end      INTEGER NOT NULL CHECK (week_end BETWEEN 1 AND 30),
  week_parity   TEXT    NOT NULL DEFAULT 'all' CHECK (week_parity IN ('all', 'odd', 'even')),
  room          TEXT,
  CHECK (period_end >= period_start),
  CHECK (week_end >= week_start)
);
CREATE INDEX idx_sessions_class ON class_sessions(class_id);

-- ---------------------------------------------------------------------
-- 3. 培养方案（含课程抵扣关系）与修读记录
-- ---------------------------------------------------------------------
CREATE TABLE programs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  grade           TEXT,
  major           TEXT,
  total_credits   REAL    NOT NULL DEFAULT 0,
  version         TEXT    NOT NULL DEFAULT 'v1',
  published_at    TEXT,
  status          TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at      TEXT    NOT NULL
);

CREATE TABLE curriculum_requirements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id   INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  code         TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  category     TEXT,
  required_credits REAL NOT NULL DEFAULT 0 CHECK (required_credits >= 0),
  min_courses  INTEGER NOT NULL DEFAULT 0 CHECK (min_courses >= 0),
  priority     INTEGER NOT NULL DEFAULT 0,   -- 数字越小越关键，用于兜底顺序
  note         TEXT,
  UNIQUE (program_id, code)
);

-- 培养方案课程明细：课程抵扣关系来自这里（Agent 不得自行重复计分）
CREATE TABLE curriculum_courses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES curriculum_requirements(id) ON DELETE CASCADE,
  course_id      INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  relation       TEXT    NOT NULL DEFAULT 'direct'
                         CHECK (relation IN ('direct', 'substitute')),
  priority       INTEGER NOT NULL DEFAULT 100,
  UNIQUE (requirement_id, course_id)
);
CREATE INDEX idx_curriculum_courses_course ON curriculum_courses(course_id);

-- 修读记录（已获得 / 正在修读 / 本期已选分开记录，已选不等于已通过）
CREATE TABLE student_course_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status      TEXT    NOT NULL CHECK (status IN ('passed', 'failed', 'in_progress', 'selected')),
  term        TEXT,
  credits     REAL    NOT NULL DEFAULT 0,
  source      TEXT    NOT NULL DEFAULT 'school' CHECK (source IN ('school', 'student')),
  verified    INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  version_id  INTEGER,                              -- 来自哪次资料发布
  updated_at  TEXT    NOT NULL,
  -- 一个学生同一门课同一状态同一学期只保留一条
  UNIQUE (student_id, course_id, status, term)
);
CREATE INDEX idx_records_student ON student_course_records(student_id, status);

-- ---------------------------------------------------------------------
-- 4. 资料导入与版本发布
-- ---------------------------------------------------------------------
CREATE TABLE import_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('courses', 'classes', 'program', 'records', 'preallocation')),
  file_name     TEXT    NOT NULL,
  file_hash     TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'validated', 'published', 'rejected')),
  row_count     INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  payload       TEXT,                               -- 解析后的标准化数据（JSON）
  report        TEXT,                               -- 校验报告（JSON）
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL,
  published_at  TEXT
);

CREATE TABLE data_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope         TEXT    NOT NULL CHECK (scope IN ('courses', 'classes', 'program', 'records', 'config')),
  version_no    INTEGER NOT NULL,
  content_hash  TEXT    NOT NULL,                   -- 关键内容哈希：内容未变化时重新校验可复用
  summary       TEXT,
  batch_id      INTEGER REFERENCES import_batches(id),
  published_by  INTEGER REFERENCES users(id),
  published_at  TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (scope, version_no)
);
CREATE INDEX idx_versions_active ON data_versions(scope, active);

-- 资料确认：学生需要重新确认时记录，未确认则不能用于竞争
CREATE TABLE source_confirmations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  version_id     INTEGER NOT NULL REFERENCES data_versions(id) ON DELETE CASCADE,
  confirmed_at   TEXT    NOT NULL,
  invalidated_at TEXT,
  note           TEXT,
  UNIQUE (student_id, version_id)
);

-- 系统配置（学分上限、批次时间、公开补选开关等由管理员配置）
CREATE TABLE app_configs (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  value_type  TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  description TEXT,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------
-- 5. 专业课预分配（占用正式容量）
-- ---------------------------------------------------------------------
CREATE TABLE preallocation_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id   INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  class_id     INTEGER NOT NULL REFERENCES teaching_classes(id) ON DELETE CASCADE,
  batch_id     INTEGER REFERENCES import_batches(id),
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'applied', 'failed', 'reverted')),
  failure_code TEXT,
  reason       TEXT,
  margin       INTEGER NOT NULL DEFAULT 0,          -- 预留给管理员调整的余量
  created_at   TEXT    NOT NULL,
  applied_at   TEXT,
  UNIQUE (student_id, class_id)
);
CREATE INDEX idx_prealloc_student ON preallocation_results(student_id, status);

-- ---------------------------------------------------------------------
-- 6. 选课批次与冻结快照
-- ---------------------------------------------------------------------
CREATE TABLE selection_batches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  term              TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  -- preparing: 资料准备; preview: 预览可提交草稿; open: 正式受理(可退改选);
  -- frozen: 截止冻结出结果; published: 已发布; waitlist: 候补与退改选; closed: 结束
  status            TEXT    NOT NULL DEFAULT 'preparing'
                            CHECK (status IN ('preparing', 'preview', 'open', 'frozen', 'published', 'waitlist', 'closed')),
  credit_limit      REAL    NOT NULL DEFAULT 30 CHECK (credit_limit > 0),
  open_at           TEXT,
  close_at          TEXT,
  published_at      TEXT,
  closed_at         TEXT,
  config_version_id INTEGER REFERENCES data_versions(id),
  note              TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL,
  UNIQUE (term, name)
);

-- 冻结快照：本轮分配只看快照，之后的数据变化不影响已生成结果
CREATE TABLE batch_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES selection_batches(id) ON DELETE CASCADE,
  content_hash  TEXT    NOT NULL,
  payload       TEXT    NOT NULL,                   -- 冻结的志愿/名额/需求输入
  rng_seed      TEXT    NOT NULL,                   -- 固定随机信息
  frozen_by     INTEGER REFERENCES users(id),
  frozen_at     TEXT    NOT NULL,
  UNIQUE (batch_id)
);

-- 分配任务：可恢复、可重试，重复执行不重复扣名额
CREATE TABLE allocation_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL REFERENCES selection_batches(id) ON DELETE CASCADE,
  attempt        INTEGER NOT NULL DEFAULT 1,
  mode           TEXT    NOT NULL DEFAULT 'simulate' CHECK (mode IN ('simulate', 'publish')),
  status         TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'published', 'rolled_back')),
  snapshot_hash  TEXT,
  idempotency_key TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  duration_ms    INTEGER,
  timeout_ms     INTEGER NOT NULL DEFAULT 60000,
  failure_code   TEXT,
  failure_reason TEXT,
  result_summary TEXT,                              -- 试算结果（JSON）
  report         TEXT,                              -- 校验报告与保障异常（JSON）
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT    NOT NULL,
  UNIQUE (batch_id, attempt)
);
CREATE INDEX idx_runs_batch ON allocation_runs(batch_id, status);

-- 分配明细：记录每一名学生每一门申请的判定过程与依据（可解释、可审计）
CREATE TABLE allocation_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES allocation_runs(id) ON DELETE CASCADE,
  student_id      INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  batch_id        INTEGER NOT NULL REFERENCES selection_batches(id) ON DELETE CASCADE,
  course_id       INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  preference_id   INTEGER,
  class_id        INTEGER REFERENCES teaching_classes(id),
  group_id        INTEGER,
  demand_level    TEXT    NOT NULL DEFAULT 'D0' CHECK (demand_level IN ('D0', 'D1', 'D2')),
  global_rank     INTEGER,
  random_key      TEXT,
  order_index     INTEGER,
  decision        TEXT    NOT NULL CHECK (decision IN ('allocated', 'rejected', 'waitlisted', 'error')),
  reason_code     TEXT,
  reason          TEXT,
  score_trace     TEXT,                             -- 排序要素（需求/排名/随机键）用于解释
  created_at      TEXT    NOT NULL
);
CREATE INDEX idx_alloc_items_run ON allocation_items(run_id, decision);
CREATE INDEX idx_alloc_items_student ON allocation_items(student_id, batch_id);
-- 一名学生在一个批次内的一门课程只应有一条最终判定
CREATE UNIQUE INDEX uq_alloc_items_student_course ON allocation_items(run_id, student_id, course_id);

-- ---------------------------------------------------------------------
-- 7. 志愿（草稿 / 提交版本）
-- ---------------------------------------------------------------------
CREATE TABLE preference_submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  batch_id       INTEGER NOT NULL REFERENCES selection_batches(id) ON DELETE CASCADE,
  version_no     INTEGER NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('submitted', 'withdrawn', 'invalidated')),
  program_version_id INTEGER REFERENCES data_versions(id),
  records_version_id INTEGER REFERENCES data_versions(id),
  submitted_at   TEXT    NOT NULL,
  withdrawn_at   TEXT,
  content_hash   TEXT    NOT NULL,
  summary        TEXT,
  UNIQUE (student_id, batch_id, version_no)
);
-- 一名学生在一个批次内最多只有一份有效提交（草稿不算）
CREATE UNIQUE INDEX uq_submission_active ON preference_submissions(student_id, batch_id)
  WHERE status = 'submitted';
CREATE INDEX idx_submissions_batch ON preference_submissions(batch_id, status);

CREATE TABLE preferences (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES preference_submissions(id) ON DELETE CASCADE,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  -- 同一课程可以排出多个教学班偏好
  global_rank   INTEGER NOT NULL CHECK (global_rank > 0),
  note          TEXT,
  UNIQUE (submission_id, course_id),
  UNIQUE (submission_id, global_rank)
);
CREATE INDEX idx_preferences_course ON preferences(course_id);

-- 替代组：组内最多落实一门；同一课程不跨组重复
CREATE TABLE preference_groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES preference_submissions(id) ON DELETE CASCADE,
  code          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  rank_hint     INTEGER NOT NULL DEFAULT 0,          -- 组内最高全局排名，用于组间排序
  note          TEXT,
  UNIQUE (submission_id, code)
);

CREATE TABLE preference_group_courses (
  group_id      INTEGER NOT NULL REFERENCES preference_groups(id) ON DELETE CASCADE,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  priority      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (group_id, course_id)
);

-- 同一课程内的教学班偏好顺序（不同教学班另排偏好）
CREATE TABLE preference_class_choices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  preference_id INTEGER NOT NULL REFERENCES preferences(id) ON DELETE CASCADE,
  class_id      INTEGER NOT NULL REFERENCES teaching_classes(id) ON DELETE CASCADE,
  class_rank    INTEGER NOT NULL CHECK (class_rank > 0),
  UNIQUE (preference_id, class_id),
  UNIQUE (preference_id, class_rank)
);

-- 学生固定的随机键：同学期“学生＋课程”唯一，同课不同班共用；重交、重试、重新加入都不重抽
CREATE TABLE student_course_random_keys (
  student_id INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  term       TEXT    NOT NULL,
  random_key TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  PRIMARY KEY (student_id, course_id, term)
);

-- ---------------------------------------------------------------------
-- 8. 实际选课记录（名额占用的唯一来源）与操作审计
-- ---------------------------------------------------------------------
CREATE TABLE enrollments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id    INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  class_id      INTEGER NOT NULL REFERENCES teaching_classes(id) ON DELETE CASCADE,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status        TEXT    NOT NULL DEFAULT 'enrolled'
                        CHECK (status IN ('enrolled', 'dropped', 'cancelled')),
  source        TEXT    NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('preallocation', 'allocation', 'guarantee', 'waitlist', 'upgrade', 'manual')),
  uses_reserved INTEGER NOT NULL DEFAULT 0 CHECK (uses_reserved IN (0, 1)),
  batch_id      INTEGER REFERENCES selection_batches(id),
  allocation_run_id INTEGER REFERENCES allocation_runs(id),
  granted_credit REAL,
  reason        TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  dropped_at    TEXT,
  -- 这名学生此刻只可能有一条有效在校记录
  UNIQUE (student_id, class_id, status)
);
-- 同一学生同一课程只能有一条有效记录：防重复选课（含预分配与分配结果）
CREATE UNIQUE INDEX uq_enrollment_active_course ON enrollments(student_id, course_id)
  WHERE status = 'enrolled';
CREATE INDEX idx_enrollments_class ON enrollments(class_id, status);
CREATE INDEX idx_enrollments_student ON enrollments(student_id, status);

-- 学位预留（毕业保障名单）：管理员按课程确认
CREATE TABLE graduation_reservations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES selection_batches(id) ON DELETE CASCADE,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'fulfilled', 'abnormal', 'released', 'revoked')),
  reason        TEXT,
  confirmed_by  INTEGER REFERENCES users(id),
  confirmed_at  TEXT    NOT NULL,
  released_at   TEXT,
  UNIQUE (batch_id, course_id, student_id)
);
CREATE INDEX idx_reservations_course ON graduation_reservations(batch_id, course_id, status);

-- 授权升级：必须明确目标课程、目标教学班范围（可为空＝符合资格与时间限制的班）和被替换的原课程
CREATE TABLE upgrade_authorizations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id        INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  batch_id          INTEGER NOT NULL REFERENCES selection_batches(id) ON DELETE CASCADE,
  source_course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source_class_id   INTEGER NOT NULL REFERENCES teaching_classes(id) ON DELETE CASCADE,
  target_course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  target_class_id   INTEGER REFERENCES teaching_classes(id) ON DELETE SET NULL,
  status            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'used', 'suspended', 'revoked', 'invalidated')),
  version_id        INTEGER REFERENCES data_versions(id),   -- 授权所依据的资料版本
  granted_by        INTEGER REFERENCES users(id),
  granted_at        TEXT    NOT NULL,
  expires_at        TEXT,
  used_at           TEXT,
  invalidated_at    TEXT,
  note              TEXT,
  UNIQUE (student_id, batch_id, target_course_id, source_course_id)
);
CREATE INDEX idx_authorizations_student ON upgrade_authorizations(student_id, status);

-- 候补队列
CREATE TABLE waitlist_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  batch_id       INTEGER NOT NULL REFERENCES selection_batches(id) ON DELETE CASCADE,
  course_id      INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  preference_id  INTEGER,
  class_choices  TEXT,                              -- 教学班偏好顺序（JSON 数组）
  status         TEXT    NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'suspended', 'promoted', 'closed', 'withdrawn')),
  demand_level   TEXT    NOT NULL DEFAULT 'D0' CHECK (demand_level IN ('D0', 'D1', 'D2')),
  global_rank    INTEGER,
  random_key     TEXT,
  suspend_code   TEXT,                              -- time_conflict / credit_limit / missing_authorization
  suspend_reason TEXT,
  close_code     TEXT,                              -- no_capacity / ineligible / course_cancelled / duplicate
  close_reason   TEXT,
  position_hint  INTEGER,                           -- 上次计算的顺位，仅作展示，不承诺
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  promoted_at    TEXT,
  withdrawn_at   TEXT,
  -- 一人一课程一条候补
  UNIQUE (student_id, batch_id, course_id)
);
CREATE INDEX idx_waitlist_queue ON waitlist_entries(batch_id, course_id, status);

CREATE TABLE enrollment_operations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id    INTEGER REFERENCES students(user_id) ON DELETE SET NULL,
  actor_id      INTEGER REFERENCES users(id),
  op_type       TEXT    NOT NULL CHECK (op_type IN ('enroll', 'drop', 'swap', 'replace', 'upgrade', 'allocate', 'promote', 'preallocate')),
  idempotency_key TEXT,
  request_hash  TEXT,
  source_class_id INTEGER REFERENCES teaching_classes(id),
  target_class_id INTEGER REFERENCES teaching_classes(id),
  target_course_id INTEGER REFERENCES courses(id),
  authorization_id INTEGER REFERENCES upgrade_authorizations(id),
  status        TEXT    NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code    TEXT,
  message       TEXT,
  detail        TEXT,
  created_at    TEXT    NOT NULL,
  UNIQUE (student_id, idempotency_key, op_type)
);
CREATE INDEX idx_operations_student ON enrollment_operations(student_id, created_at);

-- 审计日志：关键管理操作、资料版本、分配依据、授权与课表变更
CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id),
  actor_name  TEXT,
  action      TEXT    NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  summary     TEXT,
  detail      TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

-- 待处理异常清单：保障异常、资料待确认、分配失败等必须有明确处理结果
CREATE TABLE exceptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER REFERENCES selection_batches(id) ON DELETE CASCADE,
  run_id        INTEGER REFERENCES allocation_runs(id) ON DELETE SET NULL,
  student_id    INTEGER REFERENCES students(user_id) ON DELETE CASCADE,
  course_id     INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  kind          TEXT    NOT NULL
                        CHECK (kind IN ('guarantee_no_solution', 'guarantee_no_authorization', 'guarantee_rejected_all',
                                        'guarantee_not_submitted', 'material_changed', 'allocation_timeout',
                                        'authorization_invalidated', 'class_cancelled', 'data_inconsistent')),
  severity      TEXT    NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  detail        TEXT,
  resolution    TEXT,
  resolved_by   INTEGER REFERENCES users(id),
  resolved_at   TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX idx_exceptions_status ON exceptions(status, kind);
