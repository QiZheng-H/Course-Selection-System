/**
 * 选课工作台：把“当前阶段、学生现在能做什么、下一步该点哪个按钮、有什么阻塞”
 * 收敛到后端一处判断，导航与页面都从同一个结果渲染，避免各页面分别猜测状态。
 *
 * 这里只做读取与判断，不修改任何数据；所有写操作都在 actions.ts 里按业务动作实现。
 */
import type { SqliteDb } from '../../db/index.js';
import { checkConfig, batchStateLabel, resolveBatch, type BatchDto, type BatchStatus } from './service.js';
import { pendingConfirmations } from '../preference/service.js';

/** 面向管理员的阶段划分（比内部状态更少、更贴近业务） */
export type StageKey =
  | 'no_activity'
  | 'materials'
  | 'preference_open'
  | 'plan_pending'
  | 'plan_ready'
  | 'result_published'
  | 'change_open'
  | 'closed';

export type ActionKey =
  | 'create_activity'
  | 'open_preference'
  | 'close_submission'
  | 'generate_plan'
  | 'publish_result'
  | 'open_change'
  | 'close_activity'
  | 'reopen_submission'
  | 'review_result';

/** 阻塞原因：fix 指定前端可直接跳到能处理该问题的入口 */
export interface WorkbenchBlocker {
  code: string;
  message: string;
  fix?:
    | 'config'
    | 'materials'
    | 'confirmations'
    | 'exceptions'
    | 'guarantee'
    | 'submissions'
    | 'users'
    | 'preallocations';
  fixLabel?: string;
  count?: number;
  /** block：不能执行；warning：可以执行但需要留意 */
  severity: 'block' | 'warning';
}

export interface WorkbenchAction {
  key: ActionKey;
  label: string;
  description: string;
  primary: boolean;
  enabled: boolean;
  /** 前端需要补充的输入：新的截止时间 / 指定方案 */
  input: 'closeAt' | 'runId' | null;
  blockers: WorkbenchBlocker[];
}

export interface WorkbenchTodo {
  key: string;
  title: string;
  detail: string;
  count: number;
  severity: 'critical' | 'warning' | 'info';
  fix: WorkbenchBlocker['fix'];
  fixLabel: string;
  items: Array<{ label: string; sub?: string }>;
}

export interface WorkbenchStats {
  totalStudents: number;
  submittedStudents: number;
  notSubmittedStudents: number;
  submitted: number;
  withdrawn: number;
  pendingConfirmations: number;
  pendingConfirmationSample: Array<{ studentNo: string; name: string }>;
  waitlistQueued: number;
  waitlistSuspended: number;
  openExceptions: number;
  criticalExceptions: number;
}

export interface WorkbenchPlan {
  runId: number | null;
  status: string | null;
  attempt: number | null;
  publishedAt: string | null;
  invalidated: boolean;
  generatedAt: string | null;
  report: {
    allocated: number;
    rejected: number;
    guaranteeFulfilled: number;
    releasedReservedSeats: number;
  } | null;
}

/** 工作台顶部 5 段进度：资料准备 → 预选提交 → 分配与发布 → 退改选 → 结束 */
export interface WorkbenchStep {
  key: 'materials' | 'preference' | 'allocation' | 'change' | 'closed';
  label: string;
  state: 'done' | 'active' | 'todo';
}

/** 本轮准备情况清单（资料是否齐全，缺什么一眼可见） */
export interface WorkbenchChecklistItem {
  key: 'classes' | 'program' | 'preallocation' | 'guarantee';
  label: string;
  value: string;
  done: boolean;
  fix?: WorkbenchBlocker['fix'];
  fixLabel?: string;
}

export interface WorkbenchActivityRow {
  id: number;
  actorName: string | null;
  /** 面向业务的动作说法，例如“更新了课程资料” */
  summary: string;
  createdAt: string;
}

export interface WorkbenchDto {
  batchId: number | null;
  batch: BatchDto | null;
  stage: {
    key: StageKey;
    label: string;
    /** 学生现在能做什么 */
    studentCan: string[];
    /** 下一步说明 */
    nextStep: string;
    /** 退改选是否已经开放（published 时为 false） */
    admissionOpen: boolean;
  };
  primaryAction: WorkbenchAction | null;
  actions: WorkbenchAction[];
  blockers: WorkbenchBlocker[];
  todos: WorkbenchTodo[];
  steps: WorkbenchStep[];
  checklist: WorkbenchChecklistItem[];
  recentActivity: WorkbenchActivityRow[];
  stats: WorkbenchStats;
  plan: WorkbenchPlan | null;
  config: { ready: boolean; issues: string[] };
  tasks: Array<{ id: number; status: string; percent: number; errorMessage: string | null; createdAt: string }>;
  /**
   * 首页/工作台用到的原始业务数据（未分页），
   * 已提交/未提交人数来自整个活动，而不是当前页的条数。
   */
  counts: { runs: number; invalidatedRuns: number; snapshots: number; preallocations: number };
}

const STEP_DEFS: Array<{ key: WorkbenchStep['key']; label: string }> = [
  { key: 'materials', label: '资料准备' },
  { key: 'preference', label: '预选提交' },
  { key: 'allocation', label: '分配与发布' },
  { key: 'change', label: '退改选' },
  { key: 'closed', label: '结束' },
];

const STAGE_STEP_INDEX: Record<StageKey, number> = {
  no_activity: 0,
  materials: 0,
  preference_open: 1,
  plan_pending: 2,
  plan_ready: 2,
  // 结果已发布但退改选未开放：下一步就是“退改选”，因此在步骤条上处于该阶段
  result_published: 3,
  change_open: 3,
  closed: -1,
};

function buildSteps(stageKey: StageKey): WorkbenchStep[] {
  const activeIndex = STAGE_STEP_INDEX[stageKey] ?? 0;
  return STEP_DEFS.map((step, index) => ({
    key: step.key,
    label: step.label,
    state: activeIndex === -1 ? 'done' : index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo',
  }));
}

const NO_ACTIVITY_STAGE = {
  key: 'no_activity' as StageKey,
  label: '尚未创建选课活动',
  studentCan: ['还不能提交志愿；学生此时只能在系统里查看培养方案与修读记录'],
  nextStep: '先创建本次选课活动，再按“准备资料 → 开放预选”的顺序推进。',
  admissionOpen: false,
};

function stageOf(
  batch: BatchDto,
  plan: WorkbenchPlan | null,
): WorkbenchDto['stage'] {
  const key: StageKey = (() => {
    switch (batch.status) {
      case 'preparing':
        return 'materials';
      case 'preview':
      case 'open':
        return 'preference_open';
      case 'frozen':
        return plan && plan.runId && plan.status === 'succeeded' && !plan.invalidated ? 'plan_ready' : 'plan_pending';
      case 'published':
        return 'result_published';
      case 'waitlist':
        return 'change_open';
      case 'closed':
        return 'closed';
    }
  })();

  const studentCan: Record<StageKey, string[]> = {
    no_activity: NO_ACTIVITY_STAGE.studentCan,
    materials: ['暂时不能提交志愿（资料准备中）', '可以查看培养方案、修读记录与可选课程'],
    preference_open: ['规划课表、调整志愿顺序', '提交或撤回志愿', '查看固定随机信息与志愿预演'],
    plan_pending: ['不能再修改志愿（已结束提交）', '只能查看自己已提交的志愿'],
    plan_ready: ['不能再修改志愿', '等管理员发布结果后查看录取情况'],
    result_published: ['查看首轮结果与候补顺位', '暂时不能选退换课，候补也不会自动递补'],
    change_open: ['选课、退课、同课换班与授权替换', '候补会自动递补，也可申请公开补选'],
    closed: ['只能查看历史选课结果与课表', '不能再选退换课'],
  };

  const nextStep: Record<StageKey, string> = {
    no_activity: NO_ACTIVITY_STAGE.nextStep,
    materials: '资料与配置齐全后，点“检查并开放预选”。',
    preference_open: '确认提交情况后，点“结束提交并检查”。',
    plan_pending: '点“生成分配方案”，系统会在后台计算，可以在本页查看进度。',
    plan_ready: '检查方案摘要与毕业保障情况后，点“发布选课结果”。',
    result_published: '学生已能查看结果。确认无误后点“开放退改选”，学生才能选退换。',
    change_open: '退改选进行中。需要收尾时点“结束本次选课”。',
    closed: '本次选课已结束。如需继续，请创建下一次选课活动。',
  };

  return {
    key,
    label: batchStateLabel(batch.status),
    studentCan: studentCan[key],
    nextStep: nextStep[key],
    admissionOpen: batch.status === 'waitlist',
  };
}

function emptyStats(): WorkbenchStats {
  return {
    totalStudents: 0,
    submittedStudents: 0,
    notSubmittedStudents: 0,
    submitted: 0,
    withdrawn: 0,
    pendingConfirmations: 0,
    pendingConfirmationSample: [],
    waitlistQueued: 0,
    waitlistSuspended: 0,
    openExceptions: 0,
    criticalExceptions: 0,
  };
}

export function buildWorkbench(db: SqliteDb, batchId?: number | null): WorkbenchDto {
  const batch = resolveBatch(db, batchId ?? null);
  const configIssues = checkConfig(db);
  const config = { ready: configIssues.length === 0, issues: configIssues };

  if (!batch) {
    return {
      batchId: null,
      batch: null,
      stage: NO_ACTIVITY_STAGE,
      primaryAction: {
        key: 'create_activity',
        label: '创建选课活动',
        description: '为某个学期建立一次选课活动，创建后处于“资料准备”阶段。',
        primary: true,
        enabled: true,
        input: null,
        blockers: [],
      },
      actions: [],
      blockers: [],
      todos: configIssues.length
        ? [
            {
              key: 'config',
              title: '基础配置尚未齐全',
              detail: configIssues.join('；'),
              count: configIssues.length,
              severity: 'warning',
              fix: 'config',
              fixLabel: '去补基础配置',
              items: configIssues.map((issue) => ({ label: issue })),
            },
          ]
        : [],
      steps: buildSteps('no_activity'),
      checklist: buildChecklist(db, null, emptyStats(), configIssues),
      recentActivity: loadRecentActivity(db, null),
      stats: emptyStats(),
      plan: null,
      config,
      tasks: [],
      counts: countRows(db, null),
    };
  }

  const plan = loadPlan(db, batch);
  const stage = stageOf(batch, plan);
  const stats = loadStats(db, batch.id);

  const blockers: WorkbenchBlocker[] = [];
  const actions: WorkbenchAction[] = [];

  const push = (action: WorkbenchAction): WorkbenchAction => {
    actions.push(action);
    return action;
  };

  const configBlockers = (): WorkbenchBlocker[] =>
    configIssues.map((issue) => ({
      code: 'BATCH_CONFIG_MISSING',
      message: issue,
      fix: 'config' as const,
      fixLabel: '去补基础配置',
      severity: 'block' as const,
    }));

  const confirmBlocker: WorkbenchBlocker[] = stats.pendingConfirmations
    ? [
        {
          code: 'MATERIAL_NOT_CONFIRMED',
          message: `有 ${stats.pendingConfirmations} 名已提交志愿的学生还没确认个人修读记录，结束后无法生成方案`,
          fix: 'confirmations',
          fixLabel: '查看名单',
          count: stats.pendingConfirmations,
          severity: 'block',
        },
      ]
    : [];

  const publishBlockers: WorkbenchBlocker[] = [];
  if (!plan || !plan.runId || plan.status !== 'succeeded' || plan.invalidated) {
    publishBlockers.push({
      code: 'NO_VALID_PLAN',
      message: '还没有可发布的分配方案，请先生成分配方案',
      fix: 'submissions',
      fixLabel: '生成分配方案',
      severity: 'block',
    });
  }
  if (stats.criticalExceptions > 0) {
    publishBlockers.push({
      code: 'OPEN_CRITICAL_EXCEPTIONS',
      message: `还有 ${stats.criticalExceptions} 条必须解决的毕业保障问题未处理，处理前不能发布`,
      fix: 'exceptions',
      fixLabel: '去处理',
      count: stats.criticalExceptions,
      severity: 'block',
    });
  }

  switch (stage.key) {
    case 'materials': {
      const openAction = push({
        key: 'open_preference',
        label: '检查并开放预选',
        description: '检查课程、教学班、学分上限等资料与配置，满足条件后开放学生提交志愿。',
        primary: true,
        enabled: configBlockers().length === 0,
        input: 'closeAt',
        blockers: configBlockers(),
      });
      blockers.push(...openAction.blockers);
      break;
    }
    case 'preference_open': {
      const closeAction = push({
        key: 'close_submission',
        label: '结束提交并检查',
        description: '停止学生提交与撤回志愿，生成本轮冻结快照，随后可以生成分配方案。',
        primary: true,
        enabled: confirmBlocker.length === 0,
        input: null,
        blockers: [
          ...confirmBlocker,
          ...(stats.submitted === 0
            ? [
                {
                  code: 'NO_SUBMISSION',
                  message: '目前还没有学生提交志愿，结束后将没有可分配的数据',
                  fix: 'submissions' as const,
                  fixLabel: '查看提交情况',
                  severity: 'warning' as const,
                },
              ]
            : []),
        ],
      });
      blockers.push(...closeAction.blockers.filter((item) => item.severity === 'block'));
      break;
    }
    case 'plan_pending': {
      const generate = push({
        key: 'generate_plan',
        label: '生成分配方案',
        description: '按公平规则在后台计算，期间可以离开页面，回来后仍能看到进度。',
        primary: true,
        enabled: batch.hasActiveSnapshot,
        input: null,
        blockers: batch.hasActiveSnapshot
          ? []
          : [
              {
                code: 'NO_SNAPSHOT',
                message:
                  '这次选课还没有生成冻结快照，无法计算分配方案。请重新开放志愿提交后，再点“结束提交并检查”。',
                fix: 'submissions',
                fixLabel: '重新开放志愿提交',
                severity: 'block',
              },
            ],
      });
      blockers.push(...generate.blockers);
      push({
        key: 'reopen_submission',
        label: '重新开放志愿提交',
        description: '保留已有志愿，允许学生继续修改并重新设置截止时间；旧方案会作废。',
        primary: false,
        enabled: true,
        input: 'closeAt',
        blockers: [],
      });
      break;
    }
    case 'plan_ready': {
      const publish = push({
        key: 'publish_result',
        label: '发布选课结果',
        description: '正式落实方案并公布结果。发布后学生只能查看，退改选需要另行开放。',
        primary: true,
        enabled: publishBlockers.length === 0,
        input: 'runId',
        blockers: publishBlockers,
      });
      blockers.push(...publish.blockers);
      push({
        key: 'reopen_submission',
        label: '重新开放志愿提交',
        description: '保留已有志愿并允许学生继续修改；当前方案将失效，需要重新生成。',
        primary: false,
        enabled: true,
        input: 'closeAt',
        blockers: [],
      });
      push({
        key: 'generate_plan',
        label: '重新生成分配方案',
        description: '在同一个冻结快照上再算一次，不会影响已生成的方案。',
        primary: false,
        enabled: true,
        input: null,
        blockers: [],
      });
      break;
    }
    case 'result_published': {
      push({
        key: 'open_change',
        label: '开放退改选',
        description: '主动开启第二阶段：学生可以选退换课，候补开始自动递补。',
        primary: true,
        enabled: true,
        input: null,
        blockers: [
          {
            code: 'ADMISSION_CLOSED',
            message: '尚未开放退改选：学生现在只能查看结果，不能选退换，候补也不会自动递补',
            severity: 'warning',
          },
        ],
      });
      push({
        key: 'review_result',
        label: '查看发布结果',
        description: '查看成功安排、未落实数量与毕业保障情况。',
        primary: false,
        enabled: true,
        input: null,
        blockers: [],
      });
      push({
        key: 'close_activity',
        label: '结束本次选课',
        description: '不再需要退改选时直接结束本次选课并保留历史。',
        primary: false,
        enabled: true,
        input: null,
        blockers: [],
      });
      break;
    }
    case 'change_open': {
      push({
        key: 'close_activity',
        label: '结束本次选课',
        description: '停止常规选退课与候补递补，保留全部历史记录。',
        primary: true,
        enabled: true,
        input: null,
        blockers: [],
      });
      push({
        key: 'review_result',
        label: '查看发布结果',
        description: '查看成功安排、未落实数量与毕业保障情况。',
        primary: false,
        enabled: true,
        input: null,
        blockers: [],
      });
      break;
    }
    case 'closed': {
      push({
        key: 'create_activity',
        label: '创建下一次选课',
        description: '为新的学期建立选课活动，已有的正式课程会保留。',
        primary: true,
        enabled: true,
        input: null,
        blockers: [],
      });
      push({
        key: 'review_result',
        label: '查看历史结果',
        description: '查看本次选课的发布结果与操作记录。',
        primary: false,
        enabled: true,
        input: null,
        blockers: [],
      });
      break;
    }
    default:
      break;
  }

  const todos = buildTodos(db, batch, stats, configIssues, plan);

  return {
    batchId: batch.id,
    batch,
    stage,
    primaryAction: actions.find((action) => action.primary) ?? null,
    actions,
    blockers,
    todos,
    steps: buildSteps(stage.key),
    checklist: buildChecklist(db, batch, stats, configIssues),
    recentActivity: loadRecentActivity(db, batch.id),
    stats,
    plan,
    config,
    tasks: loadTasks(db, batch.id),
    counts: countRows(db, batch.id),
  };
}

function loadPlan(db: SqliteDb, batch: BatchDto): WorkbenchPlan | null {
  const row = db
    .prepare(
      `SELECT id, status, attempt, published_at AS publishedAt, invalidated_at AS invalidatedAt,
              finished_at AS finishedAt, report, stage_revision AS stageRevision
       FROM allocation_runs WHERE batch_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(batch.id) as
    | {
        id: number;
        status: string;
        attempt: number;
        publishedAt: string | null;
        invalidatedAt: string | null;
        finishedAt: string | null;
        report: string | null;
        stageRevision: number;
      }
    | undefined;
  if (!row) return null;
  let report: WorkbenchPlan['report'] = null;
  if (row.report) {
    try {
      const parsed = JSON.parse(row.report) as {
        allocated?: number;
        rejected?: number;
        guaranteeFulfilled?: number;
        releasedReservedSeats?: number;
      };
      report = {
        allocated: parsed.allocated ?? 0,
        rejected: parsed.rejected ?? 0,
        guaranteeFulfilled: parsed.guaranteeFulfilled ?? 0,
        releasedReservedSeats: parsed.releasedReservedSeats ?? 0,
      };
    } catch {
      report = null;
    }
  }
  return {
    runId: row.id,
    status: row.status,
    attempt: row.attempt,
    publishedAt: row.publishedAt,
    invalidated: Boolean(row.invalidatedAt) || row.stageRevision !== batch.stageRevision,
    generatedAt: row.finishedAt,
    report,
  };
}

/**
 * 本轮准备情况清单：课程与教学班、培养方案、专业课安排、毕业保障。
 * 数值都来自当前选课活动的完整数据，不是当前页的条数。
 */
function buildChecklist(
  db: SqliteDb,
  batch: BatchDto | null,
  stats: WorkbenchStats,
  configIssues: string[],
): WorkbenchChecklistItem[] {
  const items: WorkbenchChecklistItem[] = [];
  const term = batch?.term ?? null;

  const classCount = term
    ? (db.prepare('SELECT COUNT(*) AS c FROM teaching_classes WHERE term = ?').get(term) as { c: number }).c
    : 0;
  items.push({
    key: 'classes',
    label: '课程与教学班',
    value: classCount > 0 ? `${classCount} 个教学班` : '尚未导入',
    done: classCount > 0 && configIssues.length === 0,
    fix: 'materials',
    fixLabel: '去导入资料',
  });

  const programPublished = (
    db.prepare("SELECT COUNT(*) AS c FROM programs WHERE status = 'published'").get() as { c: number }
  ).c;
  items.push({
    key: 'program',
    label: '培养方案',
    value: programPublished > 0 ? '已发布' : '尚未发布',
    done: programPublished > 0,
    fix: 'materials',
    fixLabel: '去发布培养方案',
  });

  const prealloc = batch
    ? (db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status IN ('applied', 'reverted') THEN 1 ELSE 0 END) AS handled
           FROM preallocation_results WHERE batch_id = ?`,
        )
        .get(batch.id) as { total: number; handled: number | null })
    : { total: 0, handled: 0 };
  const pendingPrealloc = prealloc.total - (prealloc.handled ?? 0);
  items.push({
    key: 'preallocation',
    label: '专业课安排',
    value: prealloc.total === 0 ? '未导入名单' : pendingPrealloc > 0 ? `${pendingPrealloc} 条待落实` : '已完成',
    done: prealloc.total > 0 && pendingPrealloc === 0,
    fix: 'preallocations',
    fixLabel: '去处理',
  });

  const guaranteeIssues = stats.criticalExceptions + stats.openExceptions - stats.criticalExceptions;
  const unconfirmed = stats.pendingConfirmations;
  const guaranteeTotal = guaranteeIssues + unconfirmed;
  items.push({
    key: 'guarantee',
    label: '毕业保障',
    value: guaranteeTotal > 0 ? `${guaranteeTotal} 项待处理` : '无需处理',
    done: guaranteeTotal === 0,
    fix: 'guarantee',
    fixLabel: '去查看',
  });

  return items;
}

/** 最近操作：优先展示本次选课活动相关的管理操作，没有则回退到全局最近记录 */
function loadRecentActivity(db: SqliteDb, batchId: number | null): WorkbenchActivityRow[] {
  const rows = batchId
    ? (db
        .prepare(
          `SELECT id, actor_name AS actorName, action, summary, created_at AS createdAt
           FROM audit_logs WHERE entity_type = 'selection_batch' AND entity_id = ?
           ORDER BY id DESC LIMIT 5`,
        )
        .all(String(batchId)) as Array<{ id: number; actorName: string | null; action: string; summary: string | null; createdAt: string }>)
    : [];
  const source = rows.length
    ? rows
    : (db
        .prepare(
          `SELECT id, actor_name AS actorName, action, summary, created_at AS createdAt
           FROM audit_logs ORDER BY id DESC LIMIT 5`,
        )
        .all() as Array<{ id: number; actorName: string | null; action: string; summary: string | null; createdAt: string }>);
  return source.map((row) => ({
    id: row.id,
    actorName: row.actorName,
    summary: sanitizeAuditSummary(row.summary, row.action),
    createdAt: row.createdAt,
  }));
}

/**
 * 早期版本的审计摘要里带有内部状态名（例如「批次状态 open → frozen」），
 * 管理端不展示这些内部说法：遇到就退回“动作的业务说法”。
 */
function sanitizeAuditSummary(summary: string | null, action: string): string {
  const text = (summary ?? '').trim();
  if (!text) return businessActionLabel(action);
  const internal = /(?:preparing|preview|open|frozen|published|waitlist|closed)\s*(?:→|->|to)\s*(?:preparing|preview|open|frozen|published|waitlist|closed)/i;
  if (internal.test(text)) return `${businessActionLabel(action)}（早期记录）`;
  if (text.startsWith('批次状态')) return businessActionLabel(action);
  // 面向管理员统一用“选课活动”，不再出现内部叫法“批次”
  return text.replace(/批次/g, '选课活动');
}

/** 把内部动作名翻译成管理员看得懂的说法（审计摘要缺失时兜底） */
function businessActionLabel(action: string): string {
  const labels: Record<string, string> = {
    'batch.create': '创建了选课活动',
    'batch.update': '更新了选课活动设置',
    'batch.transition': '变更了选课阶段',
    'batch.open_preference': '开放了预选',
    'batch.close_submission': '结束了志愿提交',
    'batch.open_change': '开放了退改选',
    'batch.close_activity': '结束了本次选课',
    'batch.reopen_submission': '重新开放了志愿提交',
    'batch.adjust_deadline': '调整了截止时间',
    'batch.freeze': '生成了冻结快照',
    'allocation.simulate': '生成了分配方案',
    'allocation.publish': '发布了选课结果',
    'allocation.stale': '作废了过期方案',
    'allocation.failed': '分配计算失败',
    'guarantee.release_reserved': '释放了毕业保障预留名额',
    'waitlist.promote': '完成了候补递补',
  };
  return labels[action] ?? action;
}

function loadStats(db: SqliteDb, batchId: number): WorkbenchStats {
  const totalStudents = (db.prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number }).c;
  const submittedStudents = (
    db
      .prepare("SELECT COUNT(DISTINCT student_id) AS c FROM preference_submissions WHERE batch_id = ? AND status = 'submitted'")
      .get(batchId) as { c: number }
  ).c;
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
  const pending = pendingConfirmations(db, batchId);
  const waitlistQueued = (
    db.prepare("SELECT COUNT(*) AS c FROM waitlist_entries WHERE batch_id = ? AND status = 'queued'").get(batchId) as {
      c: number;
    }
  ).c;
  const waitlistSuspended = (
    db.prepare("SELECT COUNT(*) AS c FROM waitlist_entries WHERE batch_id = ? AND status = 'suspended'").get(batchId) as {
      c: number;
    }
  ).c;
  const exceptionRows = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN status = 'open' AND severity = 'critical' THEN 1 ELSE 0 END) AS critical
       FROM exceptions WHERE batch_id = ?`,
    )
    .get(batchId) as { open: number | null; critical: number | null };

  return {
    totalStudents,
    submittedStudents,
    notSubmittedStudents: Math.max(0, totalStudents - submittedStudents),
    submitted,
    withdrawn,
    pendingConfirmations: pending.length,
    pendingConfirmationSample: pending.slice(0, 10).map((row) => ({ studentNo: row.studentNo, name: row.name })),
    waitlistQueued,
    waitlistSuspended,
    openExceptions: exceptionRows.open ?? 0,
    criticalExceptions: exceptionRows.critical ?? 0,
  };
}

function buildTodos(
  db: SqliteDb,
  batch: BatchDto,
  stats: WorkbenchStats,
  configIssues: string[],
  plan: WorkbenchPlan | null,
): WorkbenchTodo[] {
  const todos: WorkbenchTodo[] = [];

  if (configIssues.length > 0) {
    todos.push({
      key: 'config',
      title: '基础配置或资料不齐全，不能开放预选',
      detail: configIssues.join('；'),
      count: configIssues.length,
      severity: 'critical',
      fix: 'config',
      fixLabel: '去补配置',
      items: configIssues.map((issue) => ({ label: issue })),
    });
  }

  if (stats.pendingConfirmations > 0) {
    todos.push({
      key: 'confirmations',
      title: '已提交志愿的学生尚未确认个人修读记录',
      detail: '结束提交前需要学生本人确认，否则无法生成分配方案。',
      count: stats.pendingConfirmations,
      severity: 'critical',
      fix: 'confirmations',
      fixLabel: '查看名单',
      items: stats.pendingConfirmationSample.map((row) => ({ label: row.name, sub: row.studentNo })),
    });
  }

  if (stats.criticalExceptions > 0) {
    const samples = db
      .prepare(
        `SELECT e.kind, e.detail, c.name AS courseName, s.name AS studentName
         FROM exceptions e
         LEFT JOIN courses c ON c.id = e.course_id
         LEFT JOIN students s ON s.user_id = e.student_id
         WHERE e.batch_id = ? AND e.status = 'open' AND e.severity = 'critical'
         ORDER BY e.id LIMIT 5`,
      )
      .all(batch.id) as Array<{ kind: string; detail: string | null; courseName: string | null; studentName: string | null }>;
    todos.push({
      key: 'exceptions',
      title: '有必须解决的毕业保障问题',
      detail: '这些问题会阻止发布结果，必须给出明确处理结果。',
      count: stats.criticalExceptions,
      severity: 'critical',
      fix: 'exceptions',
      fixLabel: '去处理',
      items: samples.map((row) => ({
        label: row.courseName ?? row.kind,
        sub: [row.studentName, row.detail].filter(Boolean).join(' · ') || undefined,
      })),
    });
  }

  const openWarnings = stats.openExceptions - stats.criticalExceptions;
  if (openWarnings > 0) {
    todos.push({
      key: 'exceptions-warning',
      title: '有需要关注但不阻塞的异常',
      detail: '不阻止发布，但请确认业务影响。',
      count: openWarnings,
      severity: 'warning',
      fix: 'exceptions',
      fixLabel: '查看详情',
      items: [],
    });
  }

  // 保护名单缺少兜底授权：发布前需要学生自己确认，管理员只能协调
  const missingAuth = db
    .prepare(
      `SELECT COUNT(DISTINCT gr.student_id) AS c FROM graduation_reservations gr
       WHERE gr.batch_id = ? AND gr.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM guarantee_authorizations ga
           WHERE ga.student_id = gr.student_id AND ga.batch_id = gr.batch_id
             AND ga.course_id = gr.course_id AND ga.status = 'active'
         )`,
    )
    .get(batch.id) as { c: number };
  if (missingAuth.c > 0) {
    todos.push({
      key: 'guarantee-authorizations',
      title: '保护名单中的学生还没有提供兜底授权',
      detail: '管理员不能代替学生同意退换课，请联系学生本人在系统中确认。',
      count: missingAuth.c,
      severity: 'warning',
      fix: 'guarantee',
      fixLabel: '查看名单',
      items: [],
    });
  }

  if (plan?.invalidated) {
    todos.push({
      key: 'stale-plan',
      title: '已有分配方案已失效',
      detail: '选课活动重新开放过提交，旧方案不能发布，请重新生成。',
      count: 1,
      severity: 'warning',
      fix: 'submissions',
      fixLabel: '重新生成方案',
      items: [],
    });
  }

  return todos;
}

function loadTasks(db: SqliteDb, batchId: number): WorkbenchDto['tasks'] {
  const rows = db
    .prepare(
      `SELECT id, status, progress, total, error_message AS errorMessage, created_at AS createdAt
       FROM background_tasks WHERE batch_id = ? AND kind = 'allocation' ORDER BY id DESC LIMIT 5`,
    )
    .all(batchId) as Array<{
    id: number;
    status: string;
    progress: number;
    total: number;
    errorMessage: string | null;
    createdAt: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    percent: row.total > 0 ? Math.min(100, Math.round((row.progress / row.total) * 100)) : row.status === 'succeeded' ? 100 : 0,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  }));
}

function countRows(db: SqliteDb, batchId: number | null): WorkbenchDto['counts'] {
  if (!batchId) return { runs: 0, invalidatedRuns: 0, snapshots: 0, preallocations: 0 };
  const runs = (db.prepare('SELECT COUNT(*) AS c FROM allocation_runs WHERE batch_id = ?').get(batchId) as { c: number }).c;
  const invalidatedRuns = (
    db.prepare('SELECT COUNT(*) AS c FROM allocation_runs WHERE batch_id = ? AND invalidated_at IS NOT NULL').get(batchId) as {
      c: number;
    }
  ).c;
  const snapshots = (
    db.prepare('SELECT COUNT(*) AS c FROM batch_snapshots WHERE batch_id = ? AND invalidated_at IS NULL').get(batchId) as {
      c: number;
    }
  ).c;
  const preallocations = (
    db.prepare('SELECT COUNT(*) AS c FROM preallocation_results WHERE batch_id = ?').get(batchId) as { c: number }
  ).c;
  return { runs, invalidatedRuns, snapshots, preallocations };
}

/** 未提交志愿的学生名单（首页“查看未提交名单”用） */
export function listNotSubmitted(
  db: SqliteDb,
  batchId: number,
  options: { limit: number; offset: number },
): { items: Array<{ studentId: number; studentNo: string; name: string; grade: string | null; major: string | null }>; total: number } {
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM students s
         WHERE NOT EXISTS (
           SELECT 1 FROM preference_submissions ps
           WHERE ps.student_id = s.user_id AND ps.batch_id = ? AND ps.status = 'submitted'
         )`,
      )
      .get(batchId) as { c: number }
  ).c;
  const items = db
    .prepare(
      `SELECT s.user_id AS studentId, s.student_no AS studentNo, s.name, s.grade, s.major
       FROM students s
       WHERE NOT EXISTS (
         SELECT 1 FROM preference_submissions ps
         WHERE ps.student_id = s.user_id AND ps.batch_id = ? AND ps.status = 'submitted'
       )
       ORDER BY s.student_no LIMIT ? OFFSET ?`,
    )
    .all(batchId, options.limit, options.offset) as Array<{
    studentId: number;
    studentNo: string;
    name: string;
    grade: string | null;
    major: string | null;
  }>;
  return { items, total };
}

/** 阶段的简短说明，用于导航与学生端提示 */
export function stageHintFor(status: BatchStatus): string {
  return batchStateLabel(status);
}

/**
 * 学生端当前阶段视图。
 * 学生页面（尤其是已经打开的页面）据此判断按钮是否可用，
 * 与后端写接口的阶段限制保持一致。
 */
export function buildStudentStage(db: SqliteDb): {
  batchId: number | null;
  batchName: string | null;
  term: string | null;
  status: BatchStatus | null;
  stageKey: StageKey;
  stageLabel: string;
  studentCan: string[];
  /** 退改选是否已经开放 */
  admissionOpen: boolean;
  canSubmitPreference: boolean;
  canUseWaitlist: boolean;
  closeAt: string | null;
  publishedAt: string | null;
} {
  const batch = resolveBatch(db, null);
  if (!batch) {
    return {
      batchId: null,
      batchName: null,
      term: null,
      status: null,
      stageKey: 'no_activity',
      stageLabel: NO_ACTIVITY_STAGE.label,
      studentCan: NO_ACTIVITY_STAGE.studentCan,
      admissionOpen: false,
      canSubmitPreference: false,
      canUseWaitlist: false,
      closeAt: null,
      publishedAt: null,
    };
  }
  const plan = loadPlan(db, batch);
  const stage = stageOf(batch, plan);
  return {
    batchId: batch.id,
    batchName: batch.name,
    term: batch.term,
    status: batch.status,
    stageKey: stage.key,
    stageLabel: stage.label,
    studentCan: stage.studentCan,
    admissionOpen: stage.admissionOpen,
    canSubmitPreference: batch.status === 'preview' || batch.status === 'open',
    canUseWaitlist: batch.status === 'waitlist',
    closeAt: batch.closeAt,
    publishedAt: batch.publishedAt,
  };
}
