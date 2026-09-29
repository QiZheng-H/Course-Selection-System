-- 005: source_confirmations.version_id 允许为空
--
-- 背景：演示/首次运行环境可能还没有任何资料版本，此时学生也应该能确认自己的修读记录。
-- 原表 version_id 为 NOT NULL 且是外键，无法写入一个“还没有版本”的确认记录（写入 0 会破坏外键）。
-- 因此重建为可空列：NULL 表示“在尚无正式资料版本时做出的确认”。
CREATE TABLE source_confirmations_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  version_id     INTEGER REFERENCES data_versions(id) ON DELETE CASCADE,
  confirmed_at   TEXT    NOT NULL,
  invalidated_at TEXT,
  note           TEXT,
  UNIQUE (student_id, version_id)
);
INSERT INTO source_confirmations_new (id, student_id, version_id, confirmed_at, invalidated_at, note)
  SELECT id, student_id, version_id, confirmed_at, invalidated_at, note FROM source_confirmations;
DROP TABLE source_confirmations;
ALTER TABLE source_confirmations_new RENAME TO source_confirmations;
CREATE INDEX idx_confirmations_student ON source_confirmations(student_id);
