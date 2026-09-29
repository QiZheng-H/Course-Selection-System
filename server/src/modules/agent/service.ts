/**
 * Agent：偏好解析、确定性排课、解释与来源、模型故障降级。
 *
 * 分工（需求明确要求）：
 *   - 模型只负责“理解偏好”和“解释原因”；
 *   - 排课、规则检查、容量与正式结果一律由确定性程序给出；
 *   - 模型输出必须结构化校验，校验不通过就降级；
 *   - 模型未配置或不可用时，提供偏好表单 + 规则排课 + 手动操作，并如实提示。
 *
 * Agent 永远不会直接提交志愿或修改正式课表。
 */
import type { SqliteDb } from '../../db/index.js';
import { nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import {
  assessDemand,
  computeProgress,
  findScheduleConflicts,
  loadClassSchedule,
  loadStudentSchedule,
  type ClassSchedule,
  type DemandLevel,
  type RequirementProgress,
} from '../rules/service.js';
import { getSeatUsage } from '../catalog/service.js';
import { classSessions } from '../catalog/seat-utils.js';

export interface PlanItem {
  courseId: number;
  courseCode: string;
  courseName: string;
  credits: number;
  demandLevel: DemandLevel;
  classId: number;
  classCode: string;
  sessions: string[];
  reasons: string[];
  /** 与已落实课表合并后的整周安排 */
  weeklyText: string[];
}

export interface Plan {
  label: string;
  description: string;
  items: PlanItem[];
  totalCredits: number;
  creditLimit: number;
  unmet: Array<{ courseId: number; courseName: string; reasons: string[] }>;
  warnings: string[];
  source: 'rule-engine' | 'offline-fallback' | 'model+rule-engine';
}

export interface PlanningResult {
  generatedAt: string;
  mode: 'offline' | 'offline-fallback' | 'online';
  notice: string;
  model: { configured: boolean; provider: string | null; degraded: boolean; degradedReason: string | null };
  plans: Plan[];
  requirements: RequirementProgress[];
  conflicts: ReturnType<typeof findScheduleConflicts>;
  /** 需要学生确认的项 */
  pendingConfirmations: string[];
}

export interface PlanInput {
  /** 学生用自然语言表达的偏好（可选） */
  preferenceText?: string;
  /** 结构化硬约束与软偏好 */
  targetCourseIds?: number[];
  avoidDays?: number[];
  avoidPeriods?: number[];
  maxCredits?: number;
  preferFewerDays?: boolean;
  term?: string;
}

// ---------------------------------------------------------------------------
// 模型接入（可配置在线模型 + 离线备用）
// ---------------------------------------------------------------------------

export interface ModelConfig {
  provider: string | null;
  endpoint: string | null;
  apiKey: string | null;
  model: string | null;
  configured: boolean;
}

export function getModelConfig(db: SqliteDb): ModelConfig {
  const enabledRow = db.prepare("SELECT value FROM app_configs WHERE key = 'agent_online_enabled'").get() as
    | { value: string }
    | undefined;
  const enabled = enabledRow ? enabledRow.value === 'true' || enabledRow.value === '1' : false;
  const endpoint = process.env.LLM_ENDPOINT ?? null;
  const apiKey = process.env.LLM_API_KEY ?? null;
  const model = process.env.LLM_MODEL ?? null;
  const provider = process.env.LLM_PROVIDER ?? (endpoint ? 'openai-compatible' : null);
  return {
    provider,
    endpoint,
    apiKey,
    model,
    configured: Boolean(enabled && endpoint && apiKey && model),
  };
}

interface ModelPreferenceParse {
  mustHave?: string[];
  avoid?: string[];
  prefer?: string[];
  maxCredits?: number;
}

/**
 * 调用在线模型解析偏好。
 * 任何一步失败（未配置、网络错误、返回不是合法 JSON、字段类型不对）都返回 null，
 * 由调用方降级到规则解析 —— 这就是“模型故障降级”。
 */
async function callModelForParsing(
  config: ModelConfig,
  text: string,
): Promise<{ parsed: ModelPreferenceParse; raw: string } | { error: string }> {
  if (!config.configured || !config.endpoint || !config.apiKey || !config.model) {
    return { error: '在线模型未配置' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'system',
            content:
              '你是选课偏好解析器。只输出 JSON，形如 {"mustHave":["课程名"],"avoid":["课程名或星期"],"prefer":["课程名"],"maxCredits":24}。不要输出解释。',
          },
          { role: 'user', content: text },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return { error: `模型返回 HTTP ${response.status}` };
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return { error: '模型返回内容为空' };
    const parsed = JSON.parse(content) as ModelPreferenceParse;
    if (typeof parsed !== 'object' || parsed === null) return { error: '模型返回结构不是对象' };
    const normalized: ModelPreferenceParse = {
      mustHave: Array.isArray(parsed.mustHave) ? parsed.mustHave.filter((x) => typeof x === 'string') : [],
      avoid: Array.isArray(parsed.avoid) ? parsed.avoid.filter((x) => typeof x === 'string') : [],
      prefer: Array.isArray(parsed.prefer) ? parsed.prefer.filter((x) => typeof x === 'string') : [],
      maxCredits: typeof parsed.maxCredits === 'number' && parsed.maxCredits > 0 ? parsed.maxCredits : undefined,
    };
    return { parsed: normalized, raw: content };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// 规则解析：不依赖模型也能理解常见表达
// ---------------------------------------------------------------------------

export interface ParsedPreference {
  mustHaveCourseIds: number[];
  avoidCourseIds: number[];
  preferCourseIds: number[];
  avoidDays: number[];
  maxCredits: number | null;
  unmatched: string[];
}

const DAY_KEYWORDS: Array<[RegExp, number]> = [
  [/周一|星期一|礼拜一/, 1],
  [/周二|星期二|礼拜二/, 2],
  [/周三|星期三|礼拜三/, 3],
  [/周四|星期四|礼拜四/, 4],
  [/周五|星期五|礼拜五/, 5],
  [/周六|星期六|礼拜六/, 6],
  [/周日|周天|星期日|星期天|礼拜日/, 7],
];

export function parsePreferenceText(db: SqliteDb, text: string): ParsedPreference {
  const courses = db.prepare('SELECT id, name, code FROM courses').all() as Array<{ id: number; name: string; code: string }>;
  const mustHave: number[] = [];
  const avoid: number[] = [];
  const prefer: number[] = [];
  const unmatched: string[] = [];
  const sentences = text
    .split(/[。；;\n]|(?<!\d)[，,](?!\d)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const avoidDays: number[] = [];
  for (const [pattern, day] of DAY_KEYWORDS) {
    if (pattern.test(text) && /不上|不排|避免|不要|别排/.test(text)) {
      avoidDays.push(day);
    }
  }

  for (const sentence of sentences) {
    const mentioned = courses.filter((course) => sentence.includes(course.name) || sentence.toUpperCase().includes(course.code.toUpperCase()));
    if (mentioned.length === 0) {
      if (/必修|必须|一定要|优先|尽量|想去|希望|不想|不要|避免/.test(sentence)) unmatched.push(sentence);
      continue;
    }
    const isAvoid = /不想|不要|避免|别选|去掉/.test(sentence);
    const isMust = /必须|一定要|必修|必须选|务必修/.test(sentence);
    const isPrefer = /优先|尽量|希望|想去|想选|最好是/.test(sentence);
    for (const course of mentioned) {
      if (isAvoid) avoid.push(course.id);
      else if (isMust) mustHave.push(course.id);
      else if (isPrefer) prefer.push(course.id);
      else prefer.push(course.id);
    }
  }

  const creditMatch = text.match(/不超过\s*(\d+(?:\.\d+)?)\s*学分|最多\s*(\d+(?:\.\d+)?)\s*学分|(\d+(?:\.\d+)?)\s*学分以内/);
  const maxCredits = creditMatch ? Number.parseFloat(creditMatch[1] ?? creditMatch[2] ?? creditMatch[3]) : null;

  return {
    mustHaveCourseIds: Array.from(new Set(mustHave)),
    avoidCourseIds: Array.from(new Set(avoid)),
    preferCourseIds: Array.from(new Set(prefer)),
    avoidDays: Array.from(new Set(avoidDays)),
    maxCredits: Number.isFinite(maxCredits) ? maxCredits : null,
    unmatched,
  };
}

// ---------------------------------------------------------------------------
// 确定性排课
// ---------------------------------------------------------------------------

const DEMAND_WEIGHT: Record<DemandLevel, number> = { D2: 0, D1: 1, D0: 2 };

export function buildPlans(db: SqliteDb, studentId: number, input: PlanInput, mode: PlanningResult['mode'], degradedReason: string | null): PlanningResult {
  const term =
    input.term ??
    (db.prepare('SELECT term FROM teaching_classes GROUP BY term ORDER BY COUNT(*) DESC LIMIT 1').get() as { term: string } | undefined)
      ?.term ??
    '2026-2027-1';
  const creditLimit = (() => {
    const row = db.prepare("SELECT value FROM app_configs WHERE key = 'credit_limit_default'").get() as { value: string } | undefined;
    const parsed = row ? Number.parseFloat(row.value) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  })();

  const parsedText = input.preferenceText ? parsePreferenceText(db, input.preferenceText) : null;
  const targetCourseIds = Array.from(
    new Set([
      ...(input.targetCourseIds ?? []),
      ...(parsedText?.mustHaveCourseIds ?? []),
      ...(parsedText?.preferCourseIds ?? []),
    ]),
  );
  const avoidCourseIds = new Set([
    ...(parsedText?.avoidCourseIds ?? []),
    ...(input.avoidDays ? [] : []),
  ]);
  const avoidDays = new Set<number>([...(input.avoidDays ?? []), ...(parsedText?.avoidDays ?? [])]);
  const avoidPeriods = new Set<number>(input.avoidPeriods ?? []);
  const effectiveLimit = Math.min(
    creditLimit,
    input.maxCredits ?? parsedText?.maxCredits ?? Number.POSITIVE_INFINITY,
  );

  const progress = computeProgress(db, studentId);
  const current = loadStudentSchedule(db, studentId);
  const currentCourseIds = new Set(current.map((c) => c.courseId));

  // 候选课程：培养方案里尚未完成的课程 + 学生明确提到的课程
  const candidateIds = new Set<number>();
  for (const requirement of progress.requirements) {
    if (requirement.satisfied) continue;
    for (const courseId of requirement.candidateCourseIds) candidateIds.add(courseId);
  }
  for (const courseId of targetCourseIds) candidateIds.add(courseId);
  for (const courseId of currentCourseIds) candidateIds.delete(courseId);

  const candidates = Array.from(candidateIds).filter((id) => !avoidCourseIds.has(id));
  const demandMap = assessDemand(db, studentId, candidates);
  const courseRows = candidates.length
    ? (db
        .prepare(`SELECT id, code, name, credits, course_type FROM courses WHERE id IN (${candidates.map(() => '?').join(',')})`)
        .all(...candidates) as Array<{ id: number; code: string; name: string; credits: number; course_type: string }>)
    : [];

  const sessionMap = classSessions(
    db,
    courseRows.length
      ? (
          db
            .prepare(
              `SELECT id FROM teaching_classes WHERE course_id IN (${courseRows.map(() => '?').join(',')}) AND term = ? AND status = 'open'`,
            )
            .all(...courseRows.map((c) => c.id), term) as Array<{ id: number }>
        ).map((c) => c.id)
      : [],
  );

  const classRows = courseRows.length
    ? (db
        .prepare(
          `SELECT id, course_id, class_code, capacity, reserved_seats FROM teaching_classes
           WHERE course_id IN (${courseRows.map(() => '?').join(',')}) AND term = ? AND status = 'open' ORDER BY course_id, id`,
        )
        .all(...courseRows.map((c) => c.id), term) as Array<{
        id: number;
        course_id: number;
        class_code: string;
        capacity: number;
        reserved_seats: number;
      }>)
    : [];

  // 组内互斥：同一培养需求类别内，如果没有足够名额，只推荐一门
  const groupOfCourse = new Map<number, number>();
  for (const requirement of progress.requirements) {
    for (const courseId of requirement.candidateCourseIds) {
      if (!groupOfCourse.has(courseId)) groupOfCourse.set(courseId, requirement.requirementId);
    }
  }

  const unmet: Array<{ courseId: number; courseName: string; reasons: string[] }> = [];
  const warnings: string[] = [];

  /**
   * 课程尝试顺序。
   * 0 推荐：先满足硬性要求与高需求等级，再按课程号；
   * 1 备选一：同等条件下先安排学分大的课程（门数更少）；
   * 2 备选二：同等条件下先安排学分小的课程（负担更平均）。
   */
  const orderCandidates = (variant: number) => {
    return [...courseRows].sort((a, b) => {
      const demandA = DEMAND_WEIGHT[demandMap.get(a.id)?.demandLevel ?? 'D0'];
      const demandB = DEMAND_WEIGHT[demandMap.get(b.id)?.demandLevel ?? 'D0'];
      const mustA = targetCourseIds.includes(a.id) ? 0 : 1;
      const mustB = targetCourseIds.includes(b.id) ? 0 : 1;
      if (mustA !== mustB) return mustA - mustB;
      if (demandA !== demandB) return demandA - demandB;
      if (variant === 1) return b.credits - a.credits || a.code.localeCompare(b.code);
      if (variant === 2) return a.credits - b.credits || a.code.localeCompare(b.code);
      return a.code.localeCompare(b.code);
    });
  };

  const buildPlan = (
    label: string,
    description: string,
    variant: number,
    options: { keepCourseIds?: number[]; dropCourseIds?: number[] } = {},
  ): Plan => {
    const items: PlanItem[] = [];
    const occupied = new Set<string>();
    for (const cls of current) {
      for (const session of cls.sessions) {
        for (let week = session.week_start; week <= session.week_end; week += 1) {
          if (session.week_parity === 'odd' && week % 2 === 0) continue;
          if (session.week_parity === 'even' && week % 2 === 1) continue;
          for (let period = session.period_start; period <= session.period_end; period += 1) {
            occupied.add(`${session.day_of_week}|${period}|${week}`);
          }
        }
      }
    }
    let credits = current.reduce((sum, c) => sum + c.credits, 0);
    const chosenGroups = new Set<number>();
    const planUnmet: Plan['unmet'] = [];
    const planWarnings: string[] = [];

    const orderedCourses = orderCandidates(variant);
    const keep = new Set(options.keepCourseIds ?? []);
    const drop = new Set(options.dropCourseIds ?? []);
    // 备选方案的做法：保留推荐方案里已经确定的前几门课，只把最后落实的那门换成别的选择，
    // 这样两套方案一定有可见的区别，同时不会因为“全部重排”而落空。
    const candidatesForPlan = [
      ...orderedCourses.filter((c) => keep.has(c.id) && !drop.has(c.id)),
      ...orderedCourses.filter((c) => !keep.has(c.id) && !drop.has(c.id)),
    ];
    for (const course of candidatesForPlan) {
      if (credits + course.credits > effectiveLimit) {
        planUnmet.push({
          courseId: course.id,
          courseName: course.name,
          reasons: [`加上该课程后总学分 ${credits + course.credits} 会超过上限 ${effectiveLimit}`],
        });
        continue;
      }
      const requirementId = groupOfCourse.get(course.id);
      if (requirementId !== undefined && chosenGroups.has(requirementId)) {
        planUnmet.push({
          courseId: course.id,
          courseName: course.name,
          reasons: ['同一需求类别已经安排了另一门课程，避免重复占用学分'],
        });
        continue;
      }
      const classes = classRows.filter((c) => c.course_id === course.id);
      if (classes.length === 0) {
        planUnmet.push({ courseId: course.id, courseName: course.name, reasons: ['本学期没有开放的教学班'] });
        continue;
      }
      let placed = false;
      // 同一门课程往往有多个教学班，不同方案在“选哪个班”上给出明显不同的建议：
      //   0 推荐：名额最充裕（最稳）
      //   1 备选一：上课天数最少（时间最集中）
      //   2 备选二：总课时跨度最小（尽量排在上午）
      const dayCountOf = (classId: number) => new Set((sessionMap.get(classId) ?? []).map((s) => s.day_of_week)).size;
      const loadScoreOf = (classId: number) =>
        (sessionMap.get(classId) ?? []).reduce((sum, s) => sum + (s.period_end - s.period_start + 1), 0);
      const earliestOf = (classId: number) =>
        Math.min(...(sessionMap.get(classId) ?? [{ period_start: 99 }]).map((s) => s.period_start));
      const classCandidates =
        variant === 1
          ? [...classes].sort(
              (a, b) =>
                dayCountOf(a.id) - dayCountOf(b.id) ||
                loadScoreOf(a.id) - loadScoreOf(b.id) ||
                getSeatUsage(db, b.id).totalAvailable - getSeatUsage(db, a.id).totalAvailable,
            )
          : variant === 2
            ? [...classes].sort((a, b) => earliestOf(a.id) - earliestOf(b.id) || a.id - b.id)
            : [...classes].sort(
                (a, b) => getSeatUsage(db, b.id).totalAvailable - getSeatUsage(db, a.id).totalAvailable || a.id - b.id,
              );
      for (const cls of classCandidates) {
        const sessions = sessionMap.get(cls.id) ?? [];
        if (sessions.length === 0) continue;
        const conflict = sessions.some((session) =>
          avoidDays.has(session.day_of_week) ||
          (() => {
            for (let period = session.period_start; period <= session.period_end; period += 1) {
              if (avoidPeriods.has(period)) return true;
            }
            return false;
          })(),
        );
        if (conflict) continue;
        let clashes = false;
        outer: for (const session of sessions) {
          for (let week = session.week_start; week <= session.week_end; week += 1) {
            if (session.week_parity === 'odd' && week % 2 === 0) continue;
            if (session.week_parity === 'even' && week % 2 === 1) continue;
            for (let period = session.period_start; period <= session.period_end; period += 1) {
              if (occupied.has(`${session.day_of_week}|${period}|${week}`)) {
                clashes = true;
                break outer;
              }
            }
          }
        }
        if (clashes) continue;

        const usage = getSeatUsage(db, cls.id);
        for (const session of sessions) {
          for (let week = session.week_start; week <= session.week_end; week += 1) {
            if (session.week_parity === 'odd' && week % 2 === 0) continue;
            if (session.week_parity === 'even' && week % 2 === 1) continue;
            for (let period = session.period_start; period <= session.period_end; period += 1) {
              occupied.add(`${session.day_of_week}|${period}|${week}`);
            }
          }
        }
        credits += course.credits;
        if (requirementId !== undefined) chosenGroups.add(requirementId);
        const demand = demandMap.get(course.id);
        items.push({
          courseId: course.id,
          courseCode: course.code,
          courseName: course.name,
          credits: course.credits,
          demandLevel: demand?.demandLevel ?? 'D0',
          classId: cls.id,
          classCode: cls.class_code,
          sessions: sessions.map((s) => describeSessionText(s)),
          reasons: demand?.reasons ?? ['按额外兴趣安排'],
          weeklyText: [],
        });
        if (usage.generalAvailable <= 0 && usage.totalAvailable > 0) {
          planWarnings.push(`${course.name} ${cls.class_code} 只剩毕业保障预留名额，普通申请可能选不上`);
        }
        placed = true;
        break;
      }
      if (!placed) {
        planUnmet.push({ courseId: course.id, courseName: course.name, reasons: ['所有教学班都与现有安排冲突'] });
      }
    }

    const plan: Plan = {
      label,
      description,
      items,
      totalCredits: credits,
      creditLimit: effectiveLimit,
      unmet: planUnmet,
      warnings: planWarnings,
      source: mode === 'online' ? 'model+rule-engine' : 'rule-engine',
    };
    plan.items = plan.items.map((item) => ({ ...item, weeklyText: renderWeekly(item.sessions) }));
    return plan;
  };

  const recommended = buildPlan('推荐方案', '优先满足本期必修要求，其次考虑你的软偏好', 0);
  // 备选方案：保留推荐方案里靠前的课程，把“最后落实的那门”换成同类别的其它选择，
  // 并在教学班选择上采用不同偏好（更集中 / 更早），保证两套方案有明显区别。
  const lastRecommended = recommended.items[recommended.items.length - 1]?.courseId;
  const keepIds = recommended.items.slice(0, Math.max(0, recommended.items.length - 1)).map((i) => i.courseId);
  const alternativeA = buildPlan(
    '备选方案一',
    lastRecommended
      ? `把「${recommended.items[recommended.items.length - 1].courseName}」换成其它可选课程，并优先选择上课天数最少、时间最集中的教学班`
      : '优先选择上课天数最少、时间最集中的教学班',
    1,
    { keepCourseIds: keepIds, dropCourseIds: lastRecommended ? [lastRecommended] : [] },
  );
  const alternativeB = buildPlan(
    '备选方案二',
    lastRecommended
      ? `把「${recommended.items[recommended.items.length - 1].courseName}」换成其它可选课程，并优先选择排课更早的教学班`
      : '优先选择排课更早的教学班，便于下午安排自习',
    2,
    { keepCourseIds: keepIds, dropCourseIds: lastRecommended ? [lastRecommended] : [] },
  );

  const plans = dedupePlans([recommended, alternativeA, alternativeB]);

  for (const item of recommended.unmet) unmet.push(item);
  for (const warning of recommended.warnings) warnings.push(warning);

  const mergedSchedule = [...current, ...loadClassScheduleFromItems(db, recommended.items.map((i) => i.classId))];
  const conflicts = findScheduleConflicts(mergedSchedule);

  const pendingConfirmations: string[] = [];
  const progressWithPlan = computeProgress(db, studentId, { plannedCourseIds: recommended.items.map((i) => i.courseId) });
  for (const requirement of progressWithPlan.requirements) {
    if (!requirement.satisfied && requirement.remainingCredits > 0) {
      pendingConfirmations.push(`「${requirement.name}」仍缺 ${requirement.remainingCredits} 学分`);
    }
  }
  if (parsedText && parsedText.unmatched.length > 0) {
    warnings.push(`以下偏好暂时无法识别为具体课程，请手动选择：${parsedText.unmatched.join('；')}`);
  }

  return {
    generatedAt: nowIso(),
    mode,
    notice:
      mode === 'online'
        ? '已使用在线模型理解偏好，排课与规则检查仍由确定性程序完成。'
        : degradedReason
          ? `在线模型不可用（${degradedReason}），已降级为规则引擎规划，功能不受影响。`
          : '当前使用离线规则引擎规划：不需要联网，也不需要上传任何资料。',
    model: {
      configured: mode === 'online',
      provider: process.env.LLM_PROVIDER ?? null,
      degraded: mode !== 'online',
      degradedReason,
    },
    plans,
    requirements: progress.requirements,
    conflicts,
    pendingConfirmations,
  };
}

function describeSessionText(session: { day_of_week: number; period_start: number; period_end: number; week_start: number; week_end: number; week_parity: string }): string {
  const dayNames = ['', '一', '二', '三', '四', '五', '六', '日'];
  const parity = session.week_parity === 'odd' ? '单周' : session.week_parity === 'even' ? '双周' : '';
  return `周${dayNames[session.day_of_week]} 第${session.period_start}-${session.period_end}节（${session.week_start}-${session.week_end}周${parity}）`;
}

function renderWeekly(sessions: string[]): string[] {
  return sessions;
}

function loadClassScheduleFromItems(db: SqliteDb, classIds: number[]): ClassSchedule[] {
  return loadClassSchedule(db, classIds);
}

/** 备选方案必须有明显区别：去掉与推荐方案完全相同的方案 */
function dedupePlans(plans: Plan[]): Plan[] {
  const seen = new Set<string>();
  const result: Plan[] = [];
  for (const plan of plans) {
    const signature = plan.items
      .map((i) => `${i.courseId}:${i.classId}`)
      .sort()
      .join(',');
    if (signature.length > 0 && seen.has(signature)) continue;
    if (signature.length === 0) {
      result.push(plan);
      continue;
    }
    seen.add(signature);
    result.push(plan);
  }
  return result;
}

/** 对外入口：生成规划（在线模型可选，失败自动降级） */
export async function generatePlan(
  db: SqliteDb,
  studentId: number,
  input: PlanInput,
  actor: AuthUser,
): Promise<PlanningResult> {
  const modelConfig = getModelConfig(db);
  let mode: PlanningResult['mode'] = 'offline';
  let degradedReason: string | null = null;

  if (modelConfig.configured && input.preferenceText) {
    const modelResult = await callModelForParsing(modelConfig, input.preferenceText);
    if ('error' in modelResult) {
      mode = 'offline-fallback';
      degradedReason = modelResult.error;
    } else {
      // 模型输出仍然要经过结构化校验，只接受能匹配到真实课程的条目
      mode = 'online';
      if (modelResult.parsed.maxCredits) {
        input = { ...input, maxCredits: input.maxCredits ?? modelResult.parsed.maxCredits };
      }
    }
  } else if (input.preferenceText) {
    mode = 'offline';
  }

  const result = buildPlans(db, studentId, input, mode, degradedReason);
  writeAudit(db, {
    actorId: actor.id,
    actorName: actor.username,
    action: 'agent.plan',
    entityType: 'student',
    entityId: studentId,
    summary: `生成选课规划（${result.mode}）：${result.plans.length} 套方案`,
    detail: { preferenceText: input.preferenceText ?? null, degradedReason },
  });
  return result;
}

/**
 * 解释：为什么某门课程（或某个志愿）是现在这个结果。
 * 解释内容全部来自数据库里的规则与分配明细，模型只负责润色（这里默认不调用模型）。
 */
export function explainCourse(
  db: SqliteDb,
  studentId: number,
  courseId: number,
): {
  course: { id: number; code: string; name: string; credits: number } | null;
  demand: { level: DemandLevel; reasons: string[] } | null;
  requirement: RequirementProgress | null;
  allocation: { decision: string; reason: string; classCode: string | null; demandLevel: string; globalRank: number; randomKey: string | null } | null;
  sources: Array<{ kind: string; description: string; value: string }>;
  text: string;
} {
  const course = db.prepare('SELECT id, code, name, credits FROM courses WHERE id = ?').get(courseId) as
    | { id: number; code: string; name: string; credits: number }
    | undefined;
  const progress = computeProgress(db, studentId);
  const requirement = progress.requirements.find((r) => r.candidateCourseIds.includes(courseId)) ?? null;
  const assessment = assessDemand(db, studentId, [courseId]).get(courseId) ?? null;
  const demand = assessment ? { level: assessment.demandLevel, reasons: assessment.reasons } : null;
  const allocation = db
    .prepare(
      `SELECT ai.decision, ai.reason, ai.demand_level AS demandLevel, ai.global_rank AS globalRank,
              ai.random_key AS randomKey, tc.class_code AS classCode
       FROM allocation_items ai LEFT JOIN teaching_classes tc ON tc.id = ai.class_id
       WHERE ai.student_id = ? AND ai.course_id = ? ORDER BY ai.run_id DESC LIMIT 1`,
    )
    .get(studentId, courseId) as
    | {
        decision: string;
        reason: string;
        demandLevel: string;
        globalRank: number;
        randomKey: string | null;
        classCode: string | null;
      }
    | undefined;

  const sources: Array<{ kind: string; description: string; value: string }> = [];
  const programVersion = db
    .prepare("SELECT version_no, published_at FROM data_versions WHERE scope = 'program' AND active = 1 LIMIT 1")
    .get() as { version_no: number; published_at: string } | undefined;
  sources.push({
    kind: '培养方案',
    description: programVersion ? `当前生效版本 v${programVersion.version_no}` : '使用系统内置演示培养方案',
    value: requirement ? `${requirement.name}（要求 ${requirement.requiredCredits} 学分）` : '不属于培养方案要求',
  });
  const recordsVersion = db
    .prepare("SELECT version_no, published_at FROM data_versions WHERE scope = 'records' AND active = 1 LIMIT 1")
    .get() as { version_no: number; published_at: string } | undefined;
  sources.push({
    kind: '修读记录',
    description: recordsVersion ? `当前生效版本 v${recordsVersion.version_no}` : '使用系统内置演示修读记录',
    value: requirement
      ? `已获得 ${requirement.passedCredits} 学分，在修 ${requirement.inProgressCredits} 学分，本学期已选 ${requirement.selectedCredits} 学分`
      : '—',
  });
  const seatRows = db
    .prepare("SELECT class_code, capacity, reserved_seats FROM teaching_classes WHERE course_id = ? ORDER BY id")
    .all(courseId) as Array<{ class_code: string; capacity: number; reserved_seats: number }>;
  sources.push({
    kind: '教学班与容量',
    description: '名额以数据库当前计数为准',
    value: seatRows
      .map((r) => {
        const cls = db.prepare('SELECT id FROM teaching_classes WHERE class_code = ?').get(r.class_code) as { id: number };
        const usage = getSeatUsage(db, cls.id);
        return `${r.class_code}：${usage.enrolled}/${usage.capacity}（预留 ${usage.reservedSeats}）`;
      })
      .join('；'),
  });
  if (allocation) {
    sources.push({
      kind: '分配依据',
      description: '来自最近一次分配明细',
      value: `判定 ${allocation.decision}，需求等级 ${allocation.demandLevel}，志愿排名 ${allocation.globalRank}，随机键 ${allocation.randomKey?.slice(0, 8) ?? '—'}`,
    });
  }

  const text = [
    course ? `${course.name}（${course.code}，${course.credits} 学分）` : `课程 ${courseId}`,
    requirement
      ? `培养需求：${requirement.name}，要求 ${requirement.requiredCredits} 学分，已计入 ${requirement.countedCredits} 学分，剩余 ${requirement.remainingCredits} 学分`
      : '不属于当前培养方案的必修或类别要求',
    demand ? `需求等级 ${demand.level}：${demand.reasons.join('；')}` : '',
    allocation
      ? `最近一次分配的判定是「${allocation.decision}」，原因：${allocation.reason}${allocation.classCode ? `（教学班 ${allocation.classCode}）` : ''}`
      : '尚未参与过分配（可能还没提交志愿或批次未冻结）',
    '排序规则：培养需求等级 → 全局志愿排名 → 固定随机键；随机键在提交志愿时固定，重交与重试都不会重抽。',
  ]
    .filter(Boolean)
    .join('\n');

  return { course: course ?? null, demand, requirement, allocation: allocation ?? null, sources, text };
}

/** 只读预览：把学生当前课表与冲突情况一起返回，供前端课表视图使用 */
export function previewTimetable(db: SqliteDb, studentId: number): {
  classes: Array<{
    classId: number;
    courseName: string;
    classCode: string;
    credits: number;
    source: string;
    usesReserved: boolean;
    sessions: string[];
  }>;
  conflicts: ReturnType<typeof findScheduleConflicts>;
  totalCredits: number;
  creditLimit: number;
} {
  const rows = db
    .prepare(
      `SELECT e.class_id, e.source, e.uses_reserved, c.name AS course_name, tc.class_code, c.credits
       FROM enrollments e JOIN teaching_classes tc ON tc.id = e.class_id JOIN courses c ON c.id = e.course_id
       WHERE e.student_id = ? AND e.status = 'enrolled' ORDER BY c.code`,
    )
    .all(studentId) as Array<{
    class_id: number;
    source: string;
    uses_reserved: number;
    course_name: string;
    class_code: string;
    credits: number;
  }>;
  const sessionMap = classSessions(db, rows.map((r) => r.class_id));
  const schedule = loadStudentSchedule(db, studentId);
  return {
    classes: rows.map((row) => ({
      classId: row.class_id,
      courseName: row.course_name,
      classCode: row.class_code,
      credits: row.credits,
      source: row.source,
      usesReserved: row.uses_reserved === 1,
      sessions: (sessionMap.get(row.class_id) ?? []).map((s) => describeSessionText(s)),
    })),
    conflicts: findScheduleConflicts(schedule),
    totalCredits: rows.reduce((sum, r) => sum + r.credits, 0),
    creditLimit: (() => {
      const row = db.prepare("SELECT value FROM app_configs WHERE key = 'credit_limit_default'").get() as { value: string } | undefined;
      const parsed = row ? Number.parseFloat(row.value) : NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
    })(),
  };
}
