-- 003: 志愿草稿
-- 草稿自动保存但不自动提交；提交时生成 preference_submissions 版本快照。
-- 撤回保留草稿，因此草稿与提交版本分开存。
CREATE TABLE preference_drafts (
  student_id INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  batch_id   INTEGER NOT NULL REFERENCES selection_batches(id) ON DELETE CASCADE,
  payload    TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (student_id, batch_id)
);
