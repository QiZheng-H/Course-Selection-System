/**
 * 志愿管理：草稿、全局排名、替代组、提交版本、撤回、截止与冻结。
 *
 * 规则要点：
 *   - 所有申请课程共用不重复的全局排名；
 *   - 同一课程只出现一次（重复课程会直接判为校验错误，防止“多建组增加第一志愿”）；
 *   - 课程可以组成互斥替代组，每组最多落实一门，同一课程不跨组重复；
 *   - 备选之间允许时间冲突（那是草稿期的自由），但实际落实的完整课表必须无冲突；
 *   - 截止时以最后一次成功提交的完整版本为准，提交失败保留旧版本。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, notFound } from '../../core/errors.js';
import { contentHash, deriveRandomKey, nowIso, stableStringify } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { assessDemand, type SubstituteGroup } from '../rules/service.js';

export interface DraftPreferenceInput {
  courseId: number;
  globalRank: number;
  classIds?: number[];
  note?: string | null;
  /** 该课程所属替代组（可选，组内互斥） */
  groupCode?: string | null;
}

export interface DraftGroupInput {
  code: string;
  name: string;
  note?: string | null;
}

export interface DraftPayload {
  preferences: DraftPreferenceInput[];
  groups: DraftGroupInput[];
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  courseId?: number;
  groupCode?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** 规范化后的志愿（按全局排名排序） */
  normalized: DraftPreferenceInput[];
  groups: SubstituteGroup[];
  /** 每门课程当前可用的教学班数量，便于前端提示 */
  availability: Array<{ courseId: number; courseName: string; openClasses: number; totalAvailable: number }>;
  demandHints: Array<{ courseId: number; courseName: string; demandLevel: string; reasons: string[] }>;
  creditPlan: { selectedCourses: number; plannedCredits: number; creditLimit: number };
}

const emptyPayload: DraftPayload = { preferences: [], groups: [] };

export function getDraft(db: SqliteDb, studentId: number, batchId: number): DraftPayload & { updatedAt: string | null } {
  const row = db
    .prepare('SELECT payload, updated_at FROM preference_drafts WHERE student_id = ? AND batch_id = ?')
    .get(studentId, batchId) as { payload: string; updated_at: string } | undefined;
  if (!row) return { ...emptyPayload, updatedAt: null };
  try {
    const parsed = JSON.parse(row.payload) as DraftPayload;
    return {
      preferences: parsed.preferences ?? [],
      groups: parsed.groups ?? [],
      updatedAt: row.updated_at,
    };
  } catch {
    return { ...emptyPayload, updatedAt: row.updated_at };
  }
}

export function saveDraft(db: SqliteDb, studentId: number, batchId: number, payload: DraftPayload): { updatedAt: string } {
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO preference_drafts (student_id, batch_id, payload, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (student_id, batch_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).run(studentId, batchId, stableStringify(payload), updatedAt);
  return { updatedAt };
}

/** 校验草稿：错误会阻止提交，警告只是提示 */
export function validateDraft(db: SqliteDb, studentId: number, _batchId: number, payload: DraftPayload): ValidationResult {
  const issues: ValidationIssue[] = [];
  const preferences = [...(payload.preferences ?? [])].sort((a, b) => a.globalRank - b.globalRank);
  const groups = payload.groups ?? [];

  // 全局排名唯一且为正整数
  const rankSeen = new Map<number, number>();
  for (const pref of preferences) {
    if (!Number.isInteger(pref.globalRank) || pref.globalRank <= 0) {
      issues.push({ level: 'error', code: 'RANK_INVALID', message: '全局排名必须是正整数', courseId: pref.courseId });
      continue;
    }
    const dup = rankSeen.get(pref.globalRank);
    if (dup !== undefined) {
      issues.push({
        level: 'error',
        code: 'RANK_DUPLICATE',
        message: `全局排名 ${pref.globalRank} 被多门课程同时使用，请为每门课程分配唯一排名`,
        courseId: pref.courseId,
      });
    }
    rankSeen.set(pref.globalRank, pref.courseId);
  }

  // 同一课程只出现一次
  const courseSeen = new Map<number, number>();
  for (const pref of preferences) {
    const count = (courseSeen.get(pref.courseId) ?? 0) + 1;
    courseSeen.set(pref.courseId, count);
    if (count > 1) {
      issues.push({
        level: 'error',
        code: 'COURSE_DUPLICATE',
        message: '同一门课程只能出现一次；不同的教学班请在“教学班偏好”里排序，不能通过重复课程提高中签机会',
        courseId: pref.courseId,
      });
    }
  }

  // 替代组：组内至少一门、组内课程不重复、同一课程不跨组
  const groupCodes = new Set(groups.map((g) => g.code));
  const membership = new Map<string, string[]>();
  for (const pref of preferences) {
    if (!pref.groupCode) continue;
    if (!groupCodes.has(pref.groupCode)) {
      issues.push({
        level: 'error',
        code: 'GROUP_UNKNOWN',
        message: `课程引用了不存在的替代组「${pref.groupCode}」`,
        courseId: pref.courseId,
        groupCode: pref.groupCode,
      });
      continue;
    }
    const list = membership.get(pref.groupCode) ?? [];
    if (list.includes(String(pref.courseId))) {
      issues.push({
        level: 'error',
        code: 'GROUP_COURSE_DUPLICATE',
        message: `课程在替代组「${pref.groupCode}」中重复出现`,
        courseId: pref.courseId,
        groupCode: pref.groupCode,
      });
    }
    list.push(String(pref.courseId));
    membership.set(pref.groupCode, list);
  }

  const substituteGroups: SubstituteGroup[] = groups.map((group) => ({
    groupId: 0,
    code: group.code,
    name: group.name,
    rankHint: Math.min(
      ...preferences.filter((p) => p.groupCode === group.code).map((p) => p.globalRank),
      Number.MAX_SAFE_INTEGER,
    ),
    courseIds: preferences.filter((p) => p.groupCode === group.code).map((p) => p.courseId),
  }));

  for (const group of substituteGroups) {
    if (group.courseIds.length === 0) {
      issues.push({
        level: 'warning',
        code: 'GROUP_EMPTY',
        message: `替代组「${group.name}」没有任何课程，不会参与分配`,
        groupCode: group.code,
      });
    }
  }

  // 课程必须真实存在、本学期开设、教学班偏好必须属于该课程
  const availability: ValidationResult['availability'] = [];
  for (const pref of preferences) {
    const course = db.prepare('SELECT id, name, credits FROM courses WHERE id = ?').get(pref.courseId) as
      | { id: number; name: string; credits: number }
      | undefined;
    if (!course) {
      issues.push({ level: 'error', code: 'COURSE_NOT_FOUND', message: `课程 ${pref.courseId} 不存在`, courseId: pref.courseId });
      continue;
    }
    const classes = db
      .prepare("SELECT id, capacity, reserved_seats FROM teaching_classes WHERE course_id = ? AND status = 'open'")
      .all(pref.courseId) as Array<{ id: number; capacity: number; reserved_seats: number }>;
    const enrolled = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM enrollments e JOIN teaching_classes tc ON tc.id = e.class_id
           WHERE tc.course_id = ? AND e.status = 'enrolled'`,
        )
        .get(pref.courseId) as { c: number }
    ).c;
    const totalCapacity = classes.reduce((sum, c) => sum + c.capacity, 0);
    if (classes.length === 0) {
      issues.push({
        level: 'error',
        code: 'COURSE_NOT_OFFERED',
        message: `课程「${course.name}」本学期没有开放的教学班`,
        courseId: pref.courseId,
      });
    }
    for (const classId of pref.classIds ?? []) {
      if (!classes.some((c) => c.id === classId)) {
        issues.push({
          level: 'error',
          code: 'CLASS_NOT_IN_COURSE',
          message: `教学班偏好中的教学班不属于课程「${course.name}」或未开放`,
          courseId: pref.courseId,
        });
      }
    }
    const alreadyEnrolled = (
      db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ? AND course_id = ? AND status = 'enrolled'").get(
        studentId,
        pref.courseId,
      ) as { c: number }
    ).c;
    if (alreadyEnrolled > 0) {
      issues.push({
        level: 'warning',
        code: 'ALREADY_ENROLLED',
        message: `课程「${course.name}」已经有有效选课记录，该志愿不会重复落实`,
        courseId: pref.courseId,
      });
    }
    availability.push({
      courseId: pref.courseId,
      courseName: course.name,
      openClasses: classes.length,
      totalAvailable: Math.max(0, totalCapacity - enrolled),
    });
  }

  // 培养需求提示（让“多建组不能增加第一志愿”这件事在界面上说得清楚）
  const demandHints: ValidationResult['demandHints'] = [];
  if (preferences.length > 0) {
    const assessments = assessDemand(db, studentId, preferences.map((p) => p.courseId));
    for (const pref of preferences) {
      const assessment = assessments.get(pref.courseId);
      const course = availability.find((a) => a.courseId === pref.courseId);
      demandHints.push({
        courseId: pref.courseId,
        courseName: course?.courseName ?? String(pref.courseId),
        demandLevel: assessment?.demandLevel ?? 'D0',
        reasons: assessment?.reasons ?? [],
      });
    }
  }

  const plannedCredits = preferences.reduce((sum, pref) => {
    const course = db.prepare('SELECT credits FROM courses WHERE id = ?').get(pref.courseId) as { credits: number } | undefined;
    return sum + (course?.credits ?? 0);
  }, 0);
  const creditLimit = (() => {
    const row = db.prepare("SELECT value FROM app_configs WHERE key = 'credit_limit_default'").get() as { value: string } | undefined;
    const parsed = row ? Number.parseFloat(row.value) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  })();

  // 冲突检查：备选之间允许冲突，这里只提示“同时落实会冲突”的课程对
  const conflicts: string[] = [];
  const sessionRows = db.prepare(
    `SELECT class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity FROM class_sessions WHERE class_id IN (SELECT id FROM teaching_classes WHERE course_id = ? AND status = 'open')`,
  );
  const sessionsOf = (courseId: number) =>
    sessionRows.all(courseId) as Array<{
      class_id: number;
      day_of_week: number;
      period_start: number;
      period_end: number;
      week_start: number;
      week_end: number;
      week_parity: string;
    }>;
  for (let i = 0; i < preferences.length; i += 1) {
    for (let j = i + 1; j < preferences.length; j += 1) {
      const a = preferences[i];
      const b = preferences[j];
      if (a.groupCode && a.groupCode === b.groupCode) continue; // 同组互斥，不会同时落实
      const sessionsA = sessionsOf(a.courseId);
      const sessionsB = sessionsOf(b.courseId);
      let allConflict = sessionsA.length > 0 && sessionsB.length > 0;
      for (const sa of sessionsA) {
        for (const sb of sessionsB) {
          if (sa.day_of_week !== sb.day_of_week) {
            allConflict = false;
            break;
          }
          if (sa.period_start > sb.period_end || sb.period_start > sa.period_end) {
            allConflict = false;
            break;
          }
        }
        if (!allConflict) break;
      }
      if (allConflict) {
        conflicts.push(`${a.courseId} 与 ${b.courseId} 的所有教学班都互相冲突，无法同时落实`);
      }
    }
  }
  for (const message of conflicts) {
    issues.push({ level: 'warning', code: 'ALL_CLASSES_CONFLICT', message });
  }

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    normalized: preferences,
    groups: substituteGroups,
    availability,
    demandHints,
    creditPlan: { selectedCourses: preferences.length, plannedCredits, creditLimit },
  };
}

/**
 * 提交 / 撤回的时间与状态校验。
 * 关键点：截止判断使用服务器时间与管理员配置的开放/截止时刻，
 * 不能依赖“管理员恰好在截止时点了冻结”。
 */
function assertSubmissionWindow(batch: {
  status: string;
  open_at: string | null;
  close_at: string | null;
}): void {
  if (batch.status === 'preparing') {
    throw new AppError(ERROR_CODES.SUBMISSION_CLOSED, '资料准备阶段尚未开放志愿提交', 409);
  }
  if (
    batch.status === 'frozen' ||
    batch.status === 'published' ||
    batch.status === 'waitlist' ||
    batch.status === 'closed'
  ) {
    throw new AppError(ERROR_CODES.SUBMISSION_CLOSED, '本轮志愿已截止冻结，不能再提交或撤回', 409);
  }
  const now = Date.now();
  if (batch.open_at && now < new Date(batch.open_at).getTime()) {
    throw new AppError(ERROR_CODES.SUBMISSION_CLOSED, '本轮志愿尚未开放提交', 409);
  }
  if (batch.close_at && now >= new Date(batch.close_at).getTime()) {
    throw new AppError(ERROR_CODES.SUBMISSION_CLOSED, '已到管理员设定的截止时间，不能再提交或撤回', 409);
  }
}

/** 提交志愿：生成不可变版本，保证重复提交留下可审计的历史 */
export function submitPreferences(
  db: SqliteDb,
  studentId: number,
  batchId: number,
  payload: DraftPayload,
  actor: AuthUser,
): {
  submissionId: number;
  versionNo: number;
  submittedAt: string;
  warnings: ValidationIssue[];
} {
  const batch = db.prepare('SELECT id, status, term, open_at, close_at FROM selection_batches WHERE id = ?').get(batchId) as
    | { id: number; status: string; term: string; open_at: string | null; close_at: string | null }
    | undefined;
  if (!batch) throw notFound('批次不存在');
  assertSubmissionWindow(batch);

  const validation = validateDraft(db, studentId, batchId, payload);
  if (!validation.ok) {
    const firstError = validation.issues.find((i) => i.level === 'error');
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      firstError ? firstError.message : '志愿校验未通过',
      422,
      { issues: validation.issues },
    );
  }
  if (validation.normalized.length === 0) {
    throw new AppError(ERROR_CODES.SUBMISSION_EMPTY, '志愿为空，至少需要一门课程', 422);
  }

  const submittedAt = nowIso();
  const hash = contentHash(validation.normalized);
  const warnings = validation.issues.filter((i) => i.level === 'warning');

  const result = db.transaction(() => {
    const versionRow = db
      .prepare('SELECT COALESCE(MAX(version_no), 0) AS v FROM preference_submissions WHERE student_id = ? AND batch_id = ?')
      .get(studentId, batchId) as { v: number };
    const versionNo = versionRow.v + 1;

    // 旧的有效提交标记为已被新版本取代（保留历史，便于审计“重交不重抽”）
    db.prepare(
      "UPDATE preference_submissions SET status = 'withdrawn', withdrawn_at = ? WHERE student_id = ? AND batch_id = ? AND status = 'submitted'",
    ).run(submittedAt, studentId, batchId);

    const versions = db
      .prepare(
        `SELECT id, version_no FROM data_versions WHERE active = 1 AND scope IN ('program', 'records')
         ORDER BY published_at DESC`,
      )
      .all() as Array<{ id: number; version_no: number }>;
    const programVersion = db
      .prepare("SELECT id FROM data_versions WHERE scope = 'program' AND active = 1 ORDER BY version_no DESC LIMIT 1")
      .get() as { id: number } | undefined;
    const recordsVersion = db
      .prepare("SELECT id FROM data_versions WHERE scope = 'records' AND active = 1 ORDER BY version_no DESC LIMIT 1")
      .get() as { id: number } | undefined;
    void versions;

    const info = db
      .prepare(
        `INSERT INTO preference_submissions
         (student_id, batch_id, version_no, status, program_version_id, records_version_id, submitted_at, content_hash, summary)
         VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?)`,
      )
      .run(
        studentId,
        batchId,
        versionNo,
        programVersion?.id ?? null,
        recordsVersion?.id ?? null,
        submittedAt,
        hash,
        `${validation.normalized.length} 门课程，共 ${validation.creditPlan.plannedCredits} 学分`,
      );
    const submissionId = Number(info.lastInsertRowid);

    const insertPreference = db.prepare(
      'INSERT INTO preferences (submission_id, course_id, global_rank, note) VALUES (?, ?, ?, ?)',
    );
    const insertClassChoice = db.prepare(
      'INSERT INTO preference_class_choices (preference_id, class_id, class_rank) VALUES (?, ?, ?)',
    );

    const groupIdByCode = new Map<string, number>();
    for (const group of payload.groups ?? []) {
      const groupInfo = db
        .prepare('INSERT INTO preference_groups (submission_id, code, name, rank_hint, note) VALUES (?, ?, ?, ?, ?)')
        .run(
          submissionId,
          group.code,
          group.name,
          Math.min(...validation.normalized.filter((p) => p.groupCode === group.code).map((p) => p.globalRank), 9999),
          group.note ?? null,
        );
      groupIdByCode.set(group.code, Number(groupInfo.lastInsertRowid));
    }

    for (const pref of validation.normalized) {
      const prefInfo = insertPreference.run(submissionId, pref.courseId, pref.globalRank, pref.note ?? null);
      const preferenceId = Number(prefInfo.lastInsertRowid);
      (pref.classIds ?? []).forEach((classId, index) => {
        insertClassChoice.run(preferenceId, classId, index + 1);
      });
      if (pref.groupCode && groupIdByCode.has(pref.groupCode)) {
        db.prepare('INSERT INTO preference_group_courses (group_id, course_id, priority) VALUES (?, ?, ?)').run(
          groupIdByCode.get(pref.groupCode),
          pref.courseId,
          pref.globalRank,
        );
      }
    }

    // 固定随机键：提交时一次性生成，之后重交/重试/重新加入都不重抽
    const term = batch.term;
    const insertKey = db.prepare(
      `INSERT INTO student_course_random_keys (student_id, course_id, term, random_key, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (student_id, course_id, term) DO NOTHING`,
    );
    const seed = `${batchId}:${term}`;
    for (const pref of validation.normalized) {
      insertKey.run(studentId, pref.courseId, term, deriveRandomKey(seed, studentId, pref.courseId), submittedAt);
    }

    // 提交成功后同步草稿，保证界面显示的与提交内容一致
    saveDraft(db, studentId, batchId, { preferences: validation.normalized, groups: payload.groups ?? [] });

    writeAudit(db, {
      actorId: actor.id,
      actorName: actor.username,
      action: 'preference.submit',
      entityType: 'preference_submission',
      entityId: submissionId,
      summary: `提交志愿 v${versionNo}（${validation.normalized.length} 门课程）`,
      detail: { contentHash: hash, warnings: warnings.length },
    });

    return { submissionId, versionNo, submittedAt, warnings };
  })();

  return result;
}

export function withdrawPreferences(
  db: SqliteDb,
  studentId: number,
  batchId: number,
  actor: AuthUser,
): { withdrawn: number } {
  const batch = db.prepare('SELECT id, status, open_at, close_at FROM selection_batches WHERE id = ?').get(batchId) as
    | { id: number; status: string; open_at: string | null; close_at: string | null }
    | undefined;
  if (!batch) throw notFound('批次不存在');
  assertSubmissionWindow(batch);
  const now = nowIso();
  const info = db
    .prepare(
      "UPDATE preference_submissions SET status = 'withdrawn', withdrawn_at = ? WHERE student_id = ? AND batch_id = ? AND status = 'submitted'",
    )
    .run(now, studentId, batchId);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'preference.withdraw',
    entityType: 'preference_submission',
    entityId: batchId,
    summary: `撤回志愿（保留草稿）：影响 ${info.changes} 份提交`,
  });
  return { withdrawn: info.changes };
}

export interface PreferenceView {
  submissionId: number | null;
  batchId: number;
  studentId: number;
  versionNo: number | null;
  status: 'none' | 'submitted' | 'withdrawn';
  submittedAt: string | null;
  items: Array<{
    preferenceId: number;
    courseId: number;
    courseCode: string;
    courseName: string;
    credits: number;
    globalRank: number;
    groupCode: string | null;
    groupName: string | null;
    classChoices: Array<{ classId: number; classCode: string; classRank: number; capacity: number; reservedSeats: number; enrolled: number; generalAvailable: number }>;
    /** 相对已落实课表的状态：pending / allocated / superseded（已有更高偏好落实） */
    state: 'pending' | 'allocated' | 'superseded';
    note: string | null;
  }>;
  groups: Array<{ code: string; name: string; courseIds: number[]; rankHint: number }>;
}

export function getPreferences(db: SqliteDb, studentId: number, batchId: number): PreferenceView {
  const submission = db
    .prepare(
      `SELECT id, version_no, status, submitted_at FROM preference_submissions
       WHERE student_id = ? AND batch_id = ? ORDER BY version_no DESC LIMIT 1`,
    )
    .get(studentId, batchId) as
    | { id: number; version_no: number; status: string; submitted_at: string }
    | undefined;

  const view: PreferenceView = {
    submissionId: submission?.id ?? null,
    batchId,
    studentId,
    versionNo: submission?.version_no ?? null,
    status: submission ? (submission.status === 'submitted' ? 'submitted' : 'withdrawn') : 'none',
    submittedAt: submission?.submitted_at ?? null,
    items: [],
    groups: [],
  };
  if (!submission) return view;

  const groups = db
    .prepare('SELECT id, code, name, rank_hint FROM preference_groups WHERE submission_id = ? ORDER BY rank_hint')
    .all(submission.id) as Array<{ id: number; code: string; name: string; rank_hint: number }>;
  view.groups = groups.map((g) => ({
    code: g.code,
    name: g.name,
    rankHint: g.rank_hint,
    courseIds: (
      db.prepare('SELECT course_id FROM preference_group_courses WHERE group_id = ? ORDER BY priority').all(g.id) as Array<{
        course_id: number;
      }>
    ).map((r) => r.course_id),
  }));
  const groupByCourse = new Map<number, { code: string; name: string }>();
  for (const group of view.groups) {
    for (const courseId of group.courseIds) {
      groupByCourse.set(courseId, { code: group.code, name: group.name });
    }
  }

  const rows = db
    .prepare(
      `SELECT p.id, p.course_id, p.global_rank, p.note, c.code AS course_code, c.name AS course_name, c.credits
       FROM preferences p JOIN courses c ON c.id = p.course_id
       WHERE p.submission_id = ? ORDER BY p.global_rank`,
    )
    .all(submission.id) as Array<{
    id: number;
    course_id: number;
    global_rank: number;
    note: string | null;
    course_code: string;
    course_name: string;
    credits: number;
  }>;

  const allocatedCourseIds = new Set(
    (
      db
        .prepare("SELECT DISTINCT course_id FROM enrollments WHERE student_id = ? AND status = 'enrolled'")
        .all(studentId) as Array<{ course_id: number }>
    ).map((r) => r.course_id),
  );
  // 已落实的最高排名：比它更低（排名数值更大）的志愿已被关闭
  let highestAllocatedRank = Number.MAX_SAFE_INTEGER;
  for (const row of rows) {
    if (allocatedCourseIds.has(row.course_id)) {
      highestAllocatedRank = Math.min(highestAllocatedRank, row.global_rank);
    }
  }

  for (const row of rows) {
    const choices = db
      .prepare(
        `SELECT pcc.class_id, pcc.class_rank, tc.class_code, tc.capacity, tc.reserved_seats
         FROM preference_class_choices pcc JOIN teaching_classes tc ON tc.id = pcc.class_id
         WHERE pcc.preference_id = ? ORDER BY pcc.class_rank`,
      )
      .all(row.id) as Array<{
      class_id: number;
      class_rank: number;
      class_code: string;
      capacity: number;
      reserved_seats: number;
    }>;
    const group = groupByCourse.get(row.course_id) ?? null;
    const allocated = allocatedCourseIds.has(row.course_id);
    const superseded = !allocated && highestAllocatedRank < row.global_rank;
    view.items.push({
      preferenceId: row.id,
      courseId: row.course_id,
      courseCode: row.course_code,
      courseName: row.course_name,
      credits: row.credits,
      globalRank: row.global_rank,
      groupCode: group?.code ?? null,
      groupName: group?.name ?? null,
      classChoices: choices.map((c) => {
        const enrolled = (
          db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled'").get(c.class_id) as {
            c: number;
          }
        ).c;
        const usedReserved = (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM enrollments WHERE class_id = ? AND status = 'enrolled' AND uses_reserved = 1",
            )
            .get(c.class_id) as { c: number }
        ).c;
        return {
          classId: c.class_id,
          classCode: c.class_code,
          classRank: c.class_rank,
          capacity: c.capacity,
          reservedSeats: c.reserved_seats,
          enrolled,
          generalAvailable: Math.max(0, c.capacity - c.reserved_seats - (enrolled - usedReserved)),
        };
      }),
      state: allocated ? 'allocated' : superseded ? 'superseded' : 'pending',
      note: row.note,
    });
  }

  return view;
}

/** 取出某个提交版本的结构化内容（分配阶段使用） */
export function loadSubmissionPayload(db: SqliteDb, submissionId: number): DraftPayload {
  const rows = db
    .prepare('SELECT course_id, global_rank, note FROM preferences WHERE submission_id = ? ORDER BY global_rank')
    .all(submissionId) as Array<{ course_id: number; global_rank: number; note: string | null }>;
  const classes = db
    .prepare(
      `SELECT pcc.preference_id, pcc.class_id, pcc.class_rank FROM preference_class_choices pcc
       JOIN preferences p ON p.id = pcc.preference_id WHERE p.submission_id = ? ORDER BY pcc.class_rank`,
    )
    .all(submissionId) as Array<{ preference_id: number; class_id: number; class_rank: number }>;
  const groups = db
    .prepare('SELECT id, code, name, note FROM preference_groups WHERE submission_id = ?')
    .all(submissionId) as Array<{ id: number; code: string; name: string; note: string | null }>;
  const groupCourses = db
    .prepare(
      `SELECT pgc.group_id, pgc.course_id FROM preference_group_courses pgc
       JOIN preference_groups pg ON pg.id = pgc.group_id WHERE pg.submission_id = ?`,
    )
    .all(submissionId) as Array<{ group_id: number; course_id: number }>;

  const courseToGroup = new Map<number, string>();
  for (const link of groupCourses) {
    const group = groups.find((g) => g.id === link.group_id);
    if (group) courseToGroup.set(link.course_id, group.code);
  }
  const prefIdToCourse = new Map<number, number>();
  const prefs = db
    .prepare('SELECT id, course_id, global_rank, note FROM preferences WHERE submission_id = ? ORDER BY global_rank')
    .all(submissionId) as Array<{ id: number; course_id: number; global_rank: number; note: string | null }>;
  for (const pref of prefs) prefIdToCourse.set(pref.id, pref.course_id);

  return {
    preferences: rows.map((r) => ({
      courseId: r.course_id,
      globalRank: r.global_rank,
      note: r.note,
      classIds: classes.filter((c) => prefIdToCourse.get(c.preference_id) === r.course_id).map((c) => c.class_id),
      groupCode: courseToGroup.get(r.course_id) ?? null,
    })),
    groups: groups.map((g) => ({ code: g.code, name: g.name, note: g.note })),
  };
}

/** 冻结前的检查：是否存在“已提交志愿但资料待确认”的情况 */
export function pendingConfirmations(db: SqliteDb, batchId: number): Array<{ studentId: number; studentNo: string; name: string }> {
  const rows = db
    .prepare(
      `SELECT s.user_id AS studentId, s.student_no AS studentNo, s.name
       FROM preference_submissions ps
       JOIN students s ON s.user_id = ps.student_id
       WHERE ps.batch_id = ? AND ps.status = 'submitted'
         AND NOT EXISTS (
           SELECT 1 FROM source_confirmations sc
           WHERE sc.student_id = ps.student_id AND sc.invalidated_at IS NULL
         )`,
    )
    .all(batchId) as Array<{ studentId: number; studentNo: string; name: string }>;
  return rows;
}

export function getRandomKey(db: SqliteDb, studentId: number, courseId: number, term: string): string | null {
  const row = db
    .prepare('SELECT random_key FROM student_course_random_keys WHERE student_id = ? AND course_id = ? AND term = ?')
    .get(studentId, courseId, term) as { random_key: string } | undefined;
  return row?.random_key ?? null;
}

export function countSubmissions(db: SqliteDb, batchId: number): { submitted: number; withdrawn: number; students: number } {
  const submitted = (
    db.prepare("SELECT COUNT(*) AS c FROM preference_submissions WHERE batch_id = ? AND status = 'submitted'").get(batchId) as {
      c: number;
    }
  ).c;
  const withdrawn = (
    db.prepare("SELECT COUNT(*) AS c FROM preference_submissions WHERE batch_id = ? AND status = 'withdrawn'").get(batchId) as {
      c: number;
    }
  ).c;
  const students = (
    db.prepare('SELECT COUNT(DISTINCT student_id) AS c FROM preference_submissions WHERE batch_id = ?').get(batchId) as { c: number }
  ).c;
  return { submitted, withdrawn, students };
}


