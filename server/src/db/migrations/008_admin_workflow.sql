-- 008: 管理端流程简化所需的状态版本与失效标记
--
-- 背景（管理员页面简化实施计划）：
--   * “发布结果”与“开放退改选”是两个独立动作。结果发布后学生只能查看，
--     只有管理员主动开放退改选（批次进入 waitlist 阶段）后才能选退换与自动递补。
--   * 未发布结果前允许“重新开放志愿提交”。重新开放必须是一致的受控恢复：
--     保留已有志愿与固定随机键，同时让旧快照与旧试算结果失效，
--     即使晚到的计算任务完成，也不能发布过期结果。
--   * 因此需要给批次一个“阶段版本”（stage_revision），并在快照/试算上记录失效原因。
--   * 每次重新开放都必须留下操作者、原因与影响版本，便于审计。

-- ---------------------------------------------------------------------------
-- 批次：重新开放计数与阶段版本
-- ---------------------------------------------------------------------------
-- 阶段版本用于判定“某次试算是否还是当前版本的输入”。
-- 每次重新开放志愿提交都会 +1；旧版本的试算一律不能发布。
ALTER TABLE selection_batches ADD COLUMN stage_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE selection_batches ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE selection_batches ADD COLUMN last_reopened_at TEXT;
ALTER TABLE selection_batches ADD COLUMN last_reopen_reason TEXT;

-- ---------------------------------------------------------------------------
-- 冻结快照：失效标记（保留历史，只标记不再可用）
-- ---------------------------------------------------------------------------
ALTER TABLE batch_snapshots ADD COLUMN invalidated_at TEXT;
ALTER TABLE batch_snapshots ADD COLUMN invalidated_reason TEXT;
ALTER TABLE batch_snapshots ADD COLUMN stage_revision INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 分配试算：失效标记与所属阶段版本
-- ---------------------------------------------------------------------------
ALTER TABLE allocation_runs ADD COLUMN invalidated_at TEXT;
ALTER TABLE allocation_runs ADD COLUMN invalidated_reason TEXT;
ALTER TABLE allocation_runs ADD COLUMN stage_revision INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_runs_batch_revision ON allocation_runs(batch_id, stage_revision, status);
