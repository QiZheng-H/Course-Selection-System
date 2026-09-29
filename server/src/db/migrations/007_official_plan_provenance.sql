-- 007: 官方培养方案来源记录、课程必修选修属性与建议修读学期、演示数据标记
--
-- 背景（新要求）：
--   * 培养方案以学校官方发布的《上海理工大学本科培养计划（2024级）》为准，
--     必须能追溯原文件、来源网址与具体页码，因此 programs 增加来源字段。
--   * 每门课程需要记录官方的必修/选修属性与建议修读学年学期，
--     因此 curriculum_courses 增加 course_nature / suggested_term。
--   * 模块层面需要区分必修/选修，curriculum_requirements 增加 nature。
--   * 教师、教学班时间与容量、学生与修读记录属于本系统模拟配置，
--     必须能明确标记为演示数据，因此相关表增加 is_demo 标记。

-- ---------------------------------------------------------------------------
-- 培养方案来源（官方文件 / 网址 / 页码）
-- ---------------------------------------------------------------------------
ALTER TABLE programs ADD COLUMN source_file TEXT;
ALTER TABLE programs ADD COLUMN source_url TEXT;
ALTER TABLE programs ADD COLUMN source_pages TEXT;
ALTER TABLE programs ADD COLUMN source_sha256 TEXT;
ALTER TABLE programs ADD COLUMN source_note TEXT;

-- ---------------------------------------------------------------------------
-- 模块与课程的官方属性
-- ---------------------------------------------------------------------------
-- 模块性质：必修 / 选修
ALTER TABLE curriculum_requirements ADD COLUMN nature TEXT;
-- 模块在官方文件中的页码
ALTER TABLE curriculum_requirements ADD COLUMN source_pages TEXT;
-- 官方“建议修读学年学期”，例如 一/1、二/2(短 3)
ALTER TABLE curriculum_courses ADD COLUMN suggested_term TEXT;
-- 课程在该模块中的官方属性：必修 / 选修
ALTER TABLE curriculum_courses ADD COLUMN course_nature TEXT;

CREATE INDEX idx_curriculum_courses_term ON curriculum_courses(suggested_term);

-- ---------------------------------------------------------------------------
-- 演示数据标记
-- ---------------------------------------------------------------------------
ALTER TABLE courses ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));
ALTER TABLE teachers ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));
ALTER TABLE teaching_classes ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));
ALTER TABLE students ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));
ALTER TABLE student_course_records ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));
