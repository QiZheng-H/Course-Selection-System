-- 002: 管理员确认的“本学期必须完成”课程（D2 需求的正式依据之一）
-- 说明：需求基线要求“正式规则或管理员确认，本学期必须完成，且尚无足够安排”才算 D2。
-- 课程在培养方案中的 direct 关系由 001 处理，这里补充学校/学院按学期下发的必须完成名单。
CREATE TABLE term_required_courses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  term       TEXT    NOT NULL,
  reason     TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT  NOT NULL,
  UNIQUE (student_id, course_id, term)
);
CREATE INDEX idx_term_required_student ON term_required_courses(student_id, term);
