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
import {
  assessDemand,
  getCreditLimit,
  keysIntersect,
  loadStudentSchedule,
  occupancyKeys,
  type ClassSchedule,
  type SubstituteGroup,
} from '../rules/service.js';
import { findConflicts, describeSession, describeWeeks } from '../../core/time.js';
import { getSeatUsage } from '../catalog/service.js';

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

/**
 * 读到的替代组：界面只提供 code，归一化后服务端补上组名与组内课程。
 * 用联合类型如实表达“读到的组可能只有最简声明，也可能是完整结构”。
 */
export type DraftGroupLike = DraftGroupInput | SubstituteGroup;

export interface DraftPayload {
  preferences: DraftPreferenceInput[];
  groups: DraftGroupLike[];
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

/**
 * 志愿草稿的入口归一化。保存草稿、校验、提交、预演都先经过这里，
 * 让界面与规则层之间只有一个稳定的数据形态。
 *
 * 前端提交的形态是：
 *   主课程（groupCode = null，排在前面） + 备选课程（同一个 groupCode）。
 * 也就是“替代组里只放备选课程”，主课程不属于该组 —— 这是刻意的：
 * 规则层按“组内课程”判断互斥，如果主课程也在组里，它自己就会把自己挡住，
 * 出现“组内已落实一门”而永远无法落实的情况。
 *
 * 组的展示名由服务端生成（例如「高等数学A 或 高等数学B」），
 * 界面只需要给出课程顺序，不必拼中文，也不必自己命名。
 */
export function normalizeDraftPayload(db: SqliteDb, payload: DraftPayload): DraftPayload {
  const ordered = [...(payload.preferences ?? [])].sort((a, b) => a.globalRank - b.globalRank);
  const declared = new Map<string, DraftGroupInput>(
    (payload.groups ?? []).map((group) => [group.code, group] as const),
  );
  const coursesOfGroup = new Map<string, number[]>();
  for (const pref of ordered) {
    if (!pref.groupCode) continue;
    const list = coursesOfGroup.get(pref.groupCode) ?? [];
    if (!list.includes(pref.courseId)) list.push(pref.courseId);
    coursesOfGroup.set(pref.groupCode, list);
  }

  const courseIds = ordered.map((p) => p.courseId);
  const nameOf = new Map<number, string>();
  if (courseIds.length > 0) {
    const rows = db
      .prepare(`SELECT id, name FROM courses WHERE id IN (${courseIds.map(() => '?').join(',')})`)
      .all(...courseIds) as Array<{ id: number; name: string }>;
    for (const row of rows) nameOf.set(row.id, row.name);
  }

  const rankOf = new Map<number, number>();
  ordered.forEach((pref, index) => rankOf.set(pref.courseId, index + 1));

  // 组内课程 = 显式声明了该组的课程本身（也就是备选课程），主课程不声明、因此不在其中。
  // 展示时把主课程带进来，拼成「A 或 B」——这是学生真正想看到的一句话。
  const anchorOf = anchorCourseByGroup(ordered, coursesOfGroup);
  const groups: SubstituteGroup[] = [];
  for (const [code, courseIdsInGroup] of coursesOfGroup) {
    if (courseIdsInGroup.length === 0) continue;
    const anchorCourseId = anchorOf.get(code);
    const names = [anchorCourseId, ...courseIdsInGroup]
      .filter((id): id is number => id !== undefined)
      .map((id) => nameOf.get(id) ?? String(id));
    const declaredName = declared.get(code)?.name?.trim();
    groups.push({
      groupId: 0,
      code,
      name: declaredName ? declaredName : names.join(' 或 '),
      rankHint: Math.min(...courseIdsInGroup.map((id) => rankOf.get(id) ?? 9999), 9999),
      courseIds: courseIdsInGroup,
    });
  }

  return {
    preferences: ordered.map((pref) => ({
      courseId: pref.courseId,
      globalRank: pref.globalRank,
      classIds: pref.classIds ?? [],
      note: pref.note ?? null,
      // 保留前端声明的组归属：主课程为 null，备选带组编码
      groupCode: pref.groupCode ?? null,
    })),
    groups,
  };
}

/**
 * 推导每个替代组的“主课程”：排在组内第一门之前、且自身不属于任何组的最后一门课。
 * 例：顺序为「高等数学A（无组）→ 高等数学B（ALT1）」，主课程就是高等数学A。
 *
 * 主课程刻意不放进替代组：规则层按组内课程判断互斥，
 * 若主课程也在组里，它自己就会把自己挡住（“组内已落实一门”），永远无法落实。
 */
function anchorCourseByGroup(
  ordered: DraftPreferenceInput[],
  coursesOfGroup: Map<string, number[]>,
): Map<string, number> {
  const anchorOf = new Map<string, number>();
  for (const [code, courseIdsInGroup] of coursesOfGroup) {
    const firstMemberIndex = ordered.findIndex((pref) => pref.courseId === courseIdsInGroup[0]);
    for (let i = firstMemberIndex - 1; i >= 0; i -= 1) {
      const candidate = ordered[i];
      if (candidate.groupCode) continue; // 属于某个组的课程不能当主课程
      anchorOf.set(code, candidate.courseId);
      break;
    }
  }
  return anchorOf;
}

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
  const normalized = normalizeDraftPayload(db, payload);
  db.prepare(
    `INSERT INTO preference_drafts (student_id, batch_id, payload, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (student_id, batch_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).run(studentId, batchId, stableStringify(normalized), updatedAt);
  return { updatedAt };
}

/**
 * 把 DraftPayload.groups 里的元素统一成完整的替代组结构。
 * 走 normalizeDraftPayload 时本来就是完整的；兼容只有 code 的最简声明，
 * 组内课程按“哪些志愿声明了这个组编码”推导。
 */
function toSubstituteGroup(group: DraftGroupLike, preferences: DraftPreferenceInput[]): SubstituteGroup {
  if ('courseIds' in group) return group;
  const courseIds = preferences.filter((pref) => pref.groupCode === group.code).map((pref) => pref.courseId);
  const ranks = preferences.filter((pref) => pref.groupCode === group.code).map((pref) => pref.globalRank);
  return {
    groupId: 0,
    code: group.code,
    name: group.name,
    rankHint: ranks.length > 0 ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER,
    courseIds,
  };
}

/** 校验草稿：错误会阻止提交，警告只是提示 */
export function validateDraft(db: SqliteDb, studentId: number, _batchId: number, rawPayload: DraftPayload): ValidationResult {
  const payload = normalizeDraftPayload(db, rawPayload);
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

  // 组结构由 normalizeDraftPayload 统一推导（组名也在这里生成），
  // 校验与提交共用同一份结果，避免两处对“什么是组”有两套理解。
  const substituteGroups: SubstituteGroup[] = groups.map((group) => toSubstituteGroup(group, preferences));

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
  rawPayload: DraftPayload,
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

  const payload = normalizeDraftPayload(db, rawPayload);
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
    // 依赖顺序：同一替代组必须先插入“组”，再插入组内课程（preference_group_courses.group_id 有外键）。
    // 组名与组内课程都由 normalizeDraftPayload 推导好，这里只负责落库。
    for (const group of validation.groups) {
      const groupInfo = db
        .prepare('INSERT INTO preference_groups (submission_id, code, name, rank_hint, note) VALUES (?, ?, ?, ?, ?)')
        .run(submissionId, group.code, group.name, group.rankHint, null);
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

    // 提交成功后同步草稿，保证界面显示的与提交内容一致。
    // 传 payload（已归一化）给 saveDraft 保险：即使归一化逻辑将来变化，草稿也不会退化成另一种形态。
    saveDraft(db, studentId, batchId, payload);

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

// ---------------------------------------------------------------------------
// 志愿预演（只读）
// ---------------------------------------------------------------------------

/**
 * 志愿预演的结论。
 *   feasible   按当前名额，这门课能排进课表
 *   conflict   与已排定的更高偏好志愿时间冲突（必须取舍）
 *   no_seat    所有教学班都没有普通余量
 *   over_limit 排进后总学分超上限
 *   no_class   本学期没有开放的教学班
 */
export type PreviewStatus = 'feasible' | 'conflict' | 'no_seat' | 'over_limit' | 'no_class';

export interface PreviewAttempt {
  rank: number;
  courseId: number;
  courseName: string;
  courseCode: string;
  credits: number;
  groupCode: string | null;
  demandLevel: 'D2' | 'D1' | 'D0';
  /** 面向学生的一句话需求说明（由后端翻译，前端不显示 D 级字母） */
  demandText: string;
  status: PreviewStatus;
  reason: string;
  /** 预计会落实的教学班 */
  classId: number | null;
  classCode: string | null;
  /** 该教学班当前普通余量与总余量 */
  generalAvailable: number;
  totalAvailable: number;
  /** 本课程所有开放教学班的合计余量 */
  courseAvailable: number;
  /** 冲突对象：排名更靠前的第几志愿 */
  conflictRank: number | null;
  conflictCourseName: string | null;
  /** 冲突发生的具体时段文案 */
  conflictText: string | null;
  /** 所有开放教学班的时段文案，便于学生换班 */
  optionTexts: string[];
  isSubstitute: boolean;
}

export interface PreferencePreview {
  batchId: number;
  credits: number;
  creditLimit: number;
  baseCredits: number;
  plannedCredits: number;
  overLimit: boolean;
  /** 整份志愿全部落实后的课表（只含可落实的志愿 + 已落实的正式选课） */
  entries: Array<{
    id: string | number;
    title: string;
    subtitle: string | null;
    source: string | null;
    credits: number | null;
    sessions: Array<{
      dayOfWeek: number;
      periodStart: number;
      periodEnd: number;
      weekStart: number;
      weekEnd: number;
      weekParity: string;
      room: string | null;
      text: string;
    }>;
  }>;
  attempts: PreviewAttempt[];
  summary: {
    total: number;
    feasible: number;
    conflict: number;
    noSeat: number;
    overLimit: number;
    noClass: number;
  };
  notes: string[];
}

interface ClassOption {
  classId: number;
  courseId: number;
  classCode: string;
  courseCode: string;
  courseName: string;
  credits: number;
  sessions: ClassSchedule['sessions'];
  generalAvailable: number;
  totalAvailable: number;
}

function loadClassOptions(db: SqliteDb, term: string): Map<number, ClassOption[]> {
  const rows = db
    .prepare(
      `SELECT tc.id AS classId, tc.course_id AS courseId, tc.class_code AS classCode,
              c.code AS courseCode, c.name AS courseName, c.credits
       FROM teaching_classes tc JOIN courses c ON c.id = tc.course_id
       WHERE tc.term = ? AND tc.status = 'open' ORDER BY tc.id`,
    )
    .all(term) as Array<{
    classId: number;
    courseId: number;
    classCode: string;
    courseCode: string;
    courseName: string;
    credits: number;
  }>;
  const byCourse = new Map<number, ClassOption[]>();
  if (rows.length === 0) return byCourse;

  const placeholders = rows.map(() => '?').join(',');
  const sessionRows = db
    .prepare(
      `SELECT id, class_id, day_of_week, period_start, period_end, week_start, week_end, week_parity, room
       FROM class_sessions WHERE class_id IN (${placeholders}) ORDER BY day_of_week, period_start`,
    )
    .all(...rows.map((r) => r.classId)) as Array<{
    id: number;
    class_id: number;
    day_of_week: number;
    period_start: number;
    period_end: number;
    week_start: number;
    week_end: number;
    week_parity: string;
    room: string | null;
  }>;
  const sessionsByClass = new Map<number, ClassSchedule['sessions']>();
  for (const row of sessionRows) {
    const list = sessionsByClass.get(row.class_id) ?? [];
    list.push({
      id: row.id,
      day_of_week: row.day_of_week,
      period_start: row.period_start,
      period_end: row.period_end,
      week_start: row.week_start,
      week_end: row.week_end,
      week_parity: row.week_parity,
      room: row.room,
    });
    sessionsByClass.set(row.class_id, list);
  }

  for (const row of rows) {
    const seat = getSeatUsage(db, row.classId);
    const option: ClassOption = {
      classId: row.classId,
      courseId: row.courseId,
      classCode: row.classCode,
      courseCode: row.courseCode,
      courseName: row.courseName,
      credits: row.credits,
      sessions: sessionsByClass.get(row.classId) ?? [],
      generalAvailable: seat.generalAvailable,
      totalAvailable: seat.totalAvailable,
    };
    const list = byCourse.get(row.courseId) ?? [];
    list.push(option);
    byCourse.set(row.courseId, list);
  }
  return byCourse;
}

/**
 * 志愿预演：只读计算，不写任何数据。
 *
 * 它模拟“如果这些志愿按你的顺序依次落实”，用来回答学生最关心的三个问题：
 *   1) 我的课表会是什么样；
 *   2) 哪一门排不进去、被谁挡住了；
 *   3) 一共多少学分、会不会超。
 *
 * 它**不预测中签概率**：统一分配还要经过“培养需求 → 志愿排名 → 固定随机键”的竞争，
 * 提交先后不影响结果，因此界面文案不能承诺“你会选上”。
 */
export function previewDraft(
  db: SqliteDb,
  studentId: number,
  batchId: number,
  rawPayload: DraftPayload,
): PreferencePreview {
  const batch = db.prepare('SELECT id, term FROM selection_batches WHERE id = ?').get(batchId) as
    | { id: number; term: string }
    | undefined;
  if (!batch) throw notFound('批次不存在');

  // 与保存/校验/提交使用同一套归一化，保证预演看到的结构与真正提交的一致
  const payload = normalizeDraftPayload(db, rawPayload);
  const preferences = [...(payload.preferences ?? [])]
    .filter((p) => Number.isInteger(p.courseId))
    .sort((a, b) => a.globalRank - b.globalRank);
  const groupCodeOf = new Map<number, string>();
  for (const pref of preferences) {
    if (pref.groupCode) groupCodeOf.set(pref.courseId, pref.groupCode);
  }
  // 主课程自己不携带 groupCode，必须反查“谁是这一组的主课程”，
  // 否则主课程落实时不会把该组标记为已落实，备选就会重复入选。
  const groupAnchors = anchorCourseByGroup(
    preferences,
    (() => {
      const map = new Map<string, number[]>();
      for (const pref of preferences) {
        if (!pref.groupCode) continue;
        const list = map.get(pref.groupCode) ?? [];
        if (!list.includes(pref.courseId)) list.push(pref.courseId);
        map.set(pref.groupCode, list);
      }
      return map;
    })(),
  );
  const anchorToGroup = new Map<number, string>();
  for (const [code, courseId] of groupAnchors) anchorToGroup.set(courseId, code);
  const groupOfCourse = (courseId: number): string | null =>
    groupCodeOf.get(courseId) ?? anchorToGroup.get(courseId) ?? null;

  const classesByCourse = loadClassOptions(db, batch.term);
  const existing = loadStudentSchedule(db, studentId);
  const creditLimit = getCreditLimit(db, studentId);
  const baseCourseIds = new Set(existing.map((e) => e.courseId));
  const baseCredits = existing.reduce((sum, item) => sum + item.credits, 0);

  // 占用键 → 来源。来源用于把“排不进去”归因到具体是谁挡住了它：
  // null 表示已落实的正式选课，数字表示排在前面的第几志愿。
  const occupancy = new Map<string, number | null>();
  for (const item of existing) {
    for (const key of occupancyKeys(item.sessions)) occupancy.set(key, null);
  }

  const demand = assessDemand(db, studentId, preferences.map((p) => p.courseId));
  const courseInfoRows =
    preferences.length > 0
      ? (db
          .prepare(
            `SELECT id, code, name, credits FROM courses WHERE id IN (${preferences
              .map(() => '?')
              .join(',')})`,
          )
          .all(...preferences.map((p) => p.courseId)) as Array<{
          id: number;
          code: string;
          name: string;
          credits: number;
        }>)
      : [];
  const courseInfo = new Map(courseInfoRows.map((c) => [c.id, c]));

  const picks: Array<{ option: ClassOption; rank: number; groupCode: string | null; demandLevel: PreviewAttempt['demandLevel'] }> = [];
  const attempts: PreviewAttempt[] = [];
  const notes: string[] = [];

  // 替代组：组内最多落实一门。前一个成员成功排定后，后面成员直接判为“组内已落实”。
  const fulfilledGroups = new Map<string, number>();
  const plannedCourseIds = new Set<number>();

  const rankOf = new Map<number, number>();
  preferences.forEach((pref, index) => rankOf.set(pref.courseId, index + 1));

  const optionText = (option: ClassOption): string =>
    option.sessions.length === 0
      ? `${option.classCode}（时段待定）`
      : `${option.classCode} ${option.sessions.map((s) => describeSession(s)).join('、')}`;

  for (const pref of preferences) {
    const info = courseInfo.get(pref.courseId);
    const rank = rankOf.get(pref.courseId) ?? 0;
    const assessment = demand.get(pref.courseId);
    const demandLevel = assessment?.demandLevel ?? 'D0';
    const options = classesByCourse.get(pref.courseId) ?? [];
    const courseAvailable = options.reduce((sum, o) => sum + o.generalAvailable, 0);
    // 这门课所属的替代组：主课程自身不带 groupCode，靠“谁是该组主课程”反查得到
    const groupCode = groupOfCourse(pref.courseId);
    // 教学班顺序：学生填写的偏好在前，其余按班号
    const ordered = [
      ...(pref.classIds ?? []).map((id) => options.find((o) => o.classId === id)).filter((o): o is ClassOption => Boolean(o)),
      ...options.filter((o) => !(pref.classIds ?? []).includes(o.classId)),
    ];

    const base = {
      rank,
      courseId: pref.courseId,
      courseName: info?.name ?? String(pref.courseId),
      courseCode: info?.code ?? '—',
      credits: info?.credits ?? 0,
      // 主课程本身不带 groupCode，但界面需要知道它属于哪一组，因此统一用反查结果
      groupCode,
      demandLevel,
      demandText: describeDemand(assessment?.demandLevel ?? 'D0', assessment?.reasons ?? [], info?.name ?? ''),
      courseAvailable,
      optionTexts: ordered.map(optionText),
    };

    if (baseCourseIds.has(pref.courseId)) {
      attempts.push({
        ...base,
        status: 'feasible',
        reason: '已有该课程的有效记录，本轮不会重复落实',
        classId: null,
        classCode: null,
        generalAvailable: 0,
        totalAvailable: 0,
        conflictRank: null,
        conflictCourseName: null,
        conflictText: null,
        isSubstitute: false,
      });
      continue;
    }
    if (plannedCourseIds.has(pref.courseId)) {
      attempts.push({
        ...base,
        status: 'conflict',
        reason: '同一门课程在志愿里重复出现，只会按最高排名落实一次',
        classId: null,
        classCode: null,
        generalAvailable: 0,
        totalAvailable: 0,
        conflictRank: null,
        conflictCourseName: null,
        conflictText: null,
        isSubstitute: false,
      });
      continue;
    }
    if (groupCode && fulfilledGroups.has(groupCode)) {
      attempts.push({
        ...base,
        status: 'conflict',
        reason: `备选组「${groupCode}」已由第 ${fulfilledGroups.get(groupCode)} 志愿落实，组内只落实一门`,
        classId: null,
        classCode: null,
        generalAvailable: 0,
        totalAvailable: 0,
        conflictRank: fulfilledGroups.get(groupCode) ?? null,
        conflictCourseName: null,
        conflictText: null,
        isSubstitute: true,
      });
      continue;
    }
    if (ordered.length === 0) {
      attempts.push({
        ...base,
        status: 'no_class',
        reason: '本学期没有开放的教学班',
        classId: null,
        classCode: null,
        generalAvailable: 0,
        totalAvailable: 0,
        conflictRank: null,
        conflictCourseName: null,
        conflictText: null,
        isSubstitute: false,
      });
      continue;
    }

    // 逐个教学班尝试：只要有一个能排进课表，这门志愿就是可行的。
    // 同时记录“因为什么被跳过”，用于在没有班可用时给出准确原因。
    let chosen: ClassOption | null = null;
    let blockedBy: { rank: number | null; option: ClassOption } | null = null;
    let seatRoom = false;
    let timeRoom = false;
    let creditRoom = false;
    for (const option of ordered) {
      const tooManyCredits = baseCredits + plannedCredits(picks) + option.credits > creditLimit;
      if (!tooManyCredits) creditRoom = true;
      // 名额不足与时间冲突的差别是“等得到”与“等不到”，因此先判名额
      if (option.totalAvailable <= 0 || option.generalAvailable <= 0) continue;
      seatRoom = true;
      if (option.sessions.length === 0) {
        // 时段待定的教学班：没有时段就无法判断冲突。教务排定时间后可重新提交，
        // 这里既不当成错误，也不占用课表格子。
        chosen = option;
        break;
      }
      const optionKeys = occupancyKeys(option.sessions);
      if (keysIntersect(new Set(occupancy.keys()), optionKeys)) {
        if (!blockedBy) blockedBy = { rank: blockingRank(occupancy, optionKeys), option };
        continue;
      }
      timeRoom = true;
      if (tooManyCredits) continue;
      chosen = option;
      break;
    }

    if (chosen) {
      for (const key of occupancyKeys(chosen.sessions)) occupancy.set(key, rank);
      plannedCourseIds.add(chosen.courseId);
      picks.push({ option: chosen, rank, groupCode, demandLevel });
      if (groupCode) fulfilledGroups.set(groupCode, rank);
      attempts.push({
        ...base,
        status: 'feasible',
        reason:
          chosen.sessions.length === 0
            ? `${chosen.classCode} 的时段尚未排定，先按该班登记`
            : `可排入课表（${chosen.classCode}，普通余量 ${chosen.generalAvailable}）`,
        classId: chosen.classId,
        classCode: chosen.classCode,
        generalAvailable: chosen.generalAvailable,
        totalAvailable: chosen.totalAvailable,
        conflictRank: null,
        conflictCourseName: null,
        conflictText: null,
        isSubstitute: false,
      });
      continue;
    }

    // 排不进去：按“时间冲突 → 名额 → 学分 → 其它”给出最贴近实际的原因
    if (blockedBy && !timeRoom) {
      const blockerName =
        blockedBy.rank === null
          ? '你已选上的课程'
          : `第 ${blockedBy.rank} 志愿「${courseInfo.get(blockedBy.option.courseId)?.name ?? blockedBy.option.courseName}」`;
      attempts.push({
        ...base,
        status: 'conflict',
        reason:
          blockedBy.rank === null
            ? '与你已选上的课程时间冲突，要选它需要先调整已选课程'
            : `与${blockerName}时间冲突，要选它就得放弃那一门`,
        classId: null,
        classCode: null,
        generalAvailable: blockedBy.option.generalAvailable,
        totalAvailable: blockedBy.option.totalAvailable,
        conflictRank: blockedBy.rank,
        conflictCourseName: blockedBy.rank === null ? null : blockedBy.option.courseName,
        conflictText: firstConflictText(blockedBy.option, blockedBy.rank, picks, existing),
        isSubstitute: false,
      });
      continue;
    }

    if (!seatRoom) {
      attempts.push({
        ...base,
        status: 'no_seat',
        reason: `所有教学班的普通名额都已用完（含毕业预留共余 ${ordered.reduce((s, o) => s + o.totalAvailable, 0)}）`,
        classId: null,
        classCode: null,
        generalAvailable: 0,
        totalAvailable: 0,
        conflictRank: null,
        conflictCourseName: null,
        conflictText: null,
        isSubstitute: false,
      });
      continue;
    }

    if (!creditRoom) {
      attempts.push({
        ...base,
        status: 'over_limit',
        reason: `排入后总学分将达到 ${baseCredits + plannedCredits(picks) + base.credits}，超过上限 ${creditLimit}`,
        classId: null,
        classCode: null,
        generalAvailable: 0,
        totalAvailable: 0,
        conflictRank: null,
        conflictCourseName: null,
        conflictText: null,
        isSubstitute: false,
      });
      continue;
    }

    attempts.push({
      ...base,
      status: 'conflict',
      reason: '现有教学班都排不进当前课表，可尝试调整教学班偏好',
      classId: null,
      classCode: null,
      generalAvailable: ordered[0]?.generalAvailable ?? 0,
      totalAvailable: ordered[0]?.totalAvailable ?? 0,
      conflictRank: null,
      conflictCourseName: null,
      conflictText: null,
      isSubstitute: false,
    });
  }

  // 课表条目：已落实的正式选课 + 本次可排入的志愿
  const entries: PreferencePreview['entries'] = [
    ...existing.map((item) => ({
      id: `enrolled-${item.classId}`,
      title: item.courseName,
      subtitle: `${item.classCode} · 已选`,
      source: '已选',
      credits: item.credits,
      sessions: item.sessions.map((s) => ({
        dayOfWeek: s.day_of_week,
        periodStart: s.period_start,
        periodEnd: s.period_end,
        weekStart: s.week_start,
        weekEnd: s.week_end,
        weekParity: s.week_parity,
        room: s.room,
        text: describeSession(s),
      })),
    })),
    ...picks.map((pick) => ({
      id: `pref-${pick.option.classId}`,
      title: pick.option.courseName,
      subtitle: `${pick.option.classCode} · 第 ${pick.rank} 志愿`,
      source: '志愿',
      credits: pick.option.credits,
      sessions: pick.option.sessions.map((s) => ({
        dayOfWeek: s.day_of_week,
        periodStart: s.period_start,
        periodEnd: s.period_end,
        weekStart: s.week_start,
        weekEnd: s.week_end,
        weekParity: s.week_parity,
        room: s.room,
        text: describeSession(s),
      })),
    })),
  ];

  const planned = plannedCredits(picks);
  const summary = {
    total: attempts.length,
    feasible: attempts.filter((a) => a.status === 'feasible').length,
    conflict: attempts.filter((a) => a.status === 'conflict').length,
    noSeat: attempts.filter((a) => a.status === 'no_seat').length,
    overLimit: attempts.filter((a) => a.status === 'over_limit').length,
    noClass: attempts.filter((a) => a.status === 'no_class').length,
  };

  notes.push('预演只说明“按当前名额能不能排进课表”，不代表最终结果。');
  notes.push('最终结果由统一分配按「培养需求 → 志愿排名 → 固定随机键」决定，提交先后不影响结果。');
  if (summary.overLimit > 0) notes.push('请调整学分超限的志愿，否则对应课程不会落实。');
  if (summary.conflict > 0) notes.push('冲突的志愿之间需要取舍：把更想上的那门排在前面。');

  return {
    batchId,
    credits: baseCredits + planned,
    creditLimit,
    baseCredits,
    plannedCredits: planned,
    overLimit: baseCredits + planned > creditLimit,
    entries,
    attempts,
    summary,
    notes,
  };
}

function plannedCredits(picks: Array<{ option: { credits: number } }>): number {
  return picks.reduce((sum, item) => sum + item.option.credits, 0);
}

/**
 * 把培养需求等级翻译成学生能直接看懂的一句话。
 * 界面上不出现 D2 / D1 / D0 字母——那是系统内部的排序依据，不是给人看的。
 */
function describeDemand(level: 'D2' | 'D1' | 'D0', reasons: string[], courseName: string): string {
  const detail = reasons.find((r) => r.trim().length > 0) ?? '';
  if (level === 'D2') {
    return detail ? `本期必须完成 · ${detail}` : `本期必须完成 · ${courseName}`;
  }
  if (level === 'D1') {
    return detail ? `建议补足 · ${detail}` : '建议补足未完成的必修或类别学分';
  }
  return detail ? `兴趣 / 已有安排 · ${detail}` : '兴趣课程，培养方案已满足';
}

/** 找出挡住某个教学班的、排名最靠前的志愿（null 表示挡路的是已落实的正式选课） */
function blockingRank(occupancy: Map<string, number | null>, optionKeys: Set<string>): number | null {
  let best: number | null = null;
  let hasBase = false;
  for (const key of optionKeys) {
    if (!occupancy.has(key)) continue;
    const rank = occupancy.get(key);
    if (rank === null || rank === undefined) {
      hasBase = true;
      continue;
    }
    if (best === null || rank < best) best = rank;
  }
  // 已落实的正式选课不可被志愿挤掉，优先归因给它
  return hasBase ? null : best;
}

/** 给出冲突的具体时段文案（面向学生，能直接看懂是哪两节课撞了） */
function firstConflictText(
  option: ClassOption,
  rank: number | null,
  picks: Array<{ option: ClassOption; rank: number }>,
  existing: ClassSchedule[],
): string {
  const candidates: ClassSchedule[] = [];
  if (rank !== null) {
    const pick = picks.find((p) => p.rank === rank);
    if (pick) candidates.push(toScheduleLike(pick.option));
  } else {
    candidates.push(...existing);
  }
  for (const other of candidates) {
    const pairs = findConflicts(option.sessions, other.sessions);
    if (pairs.length > 0) {
      const pair = pairs[0];
      return `${describeSession(pair.left)} 与 ${describeSession(pair.right)} 在${describeWeeks(pair.weeks)}冲突`;
    }
  }
  return '时间冲突';
}

function toScheduleLike(option: ClassOption): ClassSchedule {
  return {
    classId: option.classId,
    courseId: option.courseId,
    classCode: option.classCode,
    courseCode: option.courseCode,
    courseName: option.courseName,
    credits: option.credits,
    sessions: option.sessions,
  };
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


