<script setup lang="ts">
/**
 * 选课工作台（管理端首页）。
 *
 * 版式对齐设计稿：页头 → 阶段大卡（含学生提交情况）→ 五段进度 → 两栏内容
 * （左：需要你看一下的待办；右：本轮准备情况与最近操作）→ 可折叠的提交情况。
 *
 * 阶段、允许动作、阻塞原因、待办、准备清单与最近操作全部来自后端
 * /admin/workbench；页面不猜状态，也不展示内部状态名、接口地址与幂等键，
 * 技术性细节只放在默认收起的“显示详细信息”里。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { fetchTask, isTaskActive, waitForTask } from '@/api/tasks';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import { useActivity, loadActivities } from '@/stores/activity';
import type {
  BackgroundTask,
  BlockerFix,
  StageKey,
  WorkbenchAction,
  WorkbenchDto,
  WorkbenchTodo,
} from '@/api/types';
import { formatDateTime, toDateTimeLocal, toIsoOrNull } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

/* ------------------------- 本页使用的数据结构 ------------------------- */

interface SubmissionRow {
  id: number;
  studentNo: string;
  name: string;
  versionNo: number;
  status: string;
  submittedAt: string;
  courseCount: number;
  summary: string | null;
}

interface SubmissionsPayload {
  items: SubmissionRow[];
  total: number;
  pending: Array<{ studentId: number; studentNo: string; name: string }>;
}

interface NotSubmittedRow {
  studentId: number;
  studentNo: string;
  name: string;
  grade: string | null;
  major: string | null;
}

interface NotSubmittedPayload {
  items: NotSubmittedRow[];
  total: number;
}

/** 设计稿里阶段大卡的标题说法（不外露内部状态名） */
interface StageHeadline {
  title: string;
  desc: string;
}

/* ------------------------------ 基础状态 ------------------------------ */

const toast = useToast();
const router = useRouter();
const activity = useActivity();

const loading = ref(false);
const loadError = ref('');
const view = ref<WorkbenchDto | null>(null);

/** 需要补充输入的动作（新的截止时间 / 原因） */
const pendingAction = ref<WorkbenchAction | null>(null);
const form = reactive({ closeAt: '', reason: '' });
const busy = ref(false);

/** 正在后台计算的分配方案（可离开页面，回来继续看进度） */
const task = ref<BackgroundTask | null>(null);
const taskPercent = ref(0);
let pollTimer: number | null = null;
let unmounted = false;

/** 提交情况 / 未提交名单默认收起，点按钮或链接后展开 */
const showSubmissions = ref(false);
const submissions = ref<SubmissionsPayload | null>(null);
const submissionPage = ref(1);
const submissionPageSize = ref(20);
const loadingSubmissions = ref(false);

const showNotSubmitted = ref(false);
const notSubmitted = ref<NotSubmittedPayload | null>(null);
const notSubmittedPage = ref(1);
const notSubmittedPageSize = ref(20);
const loadingNotSubmitted = ref(false);

const showPlanDetail = ref(false);
const showTechDetail = ref(false);

const ACTION_PATH: Record<string, string> = {
  open_preference: 'open-preference',
  close_submission: 'close-submission',
  generate_plan: 'generate-plan',
  publish_result: 'publish-result',
  open_change: 'open-change',
  close_activity: 'close-activity',
  reopen_submission: 'reopen-submission',
  adjust_deadline: 'adjust-deadline',
};

/** 每个阶段在学生视角的一句话标题；措辞面向管理员，不含内部状态名 */
const STAGE_HEADLINE: Record<StageKey, StageHeadline> = {
  no_activity: { title: '还没有选课活动', desc: '先创建本次选课活动，再按“准备资料 → 开放预选”的顺序推进。' },
  materials: { title: '资料准备中，尚未开放预选', desc: '这个阶段学生可以查看培养方案、修读记录与可选课程。' },
  preference_open: { title: '预选正在进行', desc: '这个阶段学生可以规划课表、调整志愿顺序并提交或撤回志愿。' },
  plan_pending: { title: '已结束提交，正在生成方案', desc: '这个阶段学生不能再修改志愿，只能查看自己已提交的志愿。' },
  plan_ready: { title: '方案已就绪，等待发布结果', desc: '这个阶段学生还不能修改志愿，发布后可以查看录取情况。' },
  result_published: { title: '结果已公布，等待开放退改选', desc: '这个阶段学生可以查看首轮结果与候补顺位，但还不能选退换课。' },
  change_open: { title: '退改选正在进行', desc: '这个阶段学生可以选课、退课、同课换班，候补会自动递补。' },
  closed: { title: '本次选课已结束', desc: '这个阶段学生只能查看历史选课结果与课表。' },
};

const batchId = computed(() => view.value?.batchId ?? null);
const primaryAction = computed(() => view.value?.primaryAction ?? view.value?.actions.find((item) => item.primary) ?? null);
const secondaryActions = computed(() => (view.value?.actions ?? []).filter((item) => !item.primary));
const primaryBlockers = computed(() =>
  (primaryAction.value?.blockers ?? []).filter((item) => item.severity === 'block'),
);
const stageHeadline = computed<StageHeadline>(() => {
  const key = view.value?.stage.key;
  if (key && STAGE_HEADLINE[key]) return STAGE_HEADLINE[key];
  return { title: view.value?.stage.label ?? '—', desc: '正在读取当前进度。' };
});
const studentCanFirst = computed(() => view.value?.stage.studentCan[0] ?? '');
const todos = computed(() => view.value?.todos ?? []);
const checklist = computed(() => view.value?.checklist ?? []);
const recentActivity = computed(() => view.value?.recentActivity ?? []);
const steps = computed(() => view.value?.steps ?? []);

/** 已提交 / 总人数：总人数为 0 时不做除法，避免显示成 0% */
const submittedCount = computed<number | null>(() => (view.value ? view.value.stats.submittedStudents : null));
const totalStudents = computed<number | null>(() => (view.value ? view.value.stats.totalStudents : null));
const notSubmittedCount = computed<number | null>(() => (view.value ? view.value.stats.notSubmittedStudents : null));
const submittedPercent = computed<number | null>(() => {
  const total = totalStudents.value;
  const done = submittedCount.value;
  if (total === null || done === null || total <= 0) return null;
  return Math.round((done / total) * 100);
});
const progressWidth = computed(() => `${submittedPercent.value ?? 0}%`);

function countText(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** 待办卡片的样式名（严重 / 提示 / 普通） */
function todoClass(todo: WorkbenchTodo): string {
  if (todo.severity === 'critical') return 'todo todo--critical';
  if (todo.severity === 'info') return 'todo todo--info';
  return 'todo';
}

/** 步骤圆点：已完成为 ✓，进行中用序号并高亮，未开始用序号 */
function stepMark(state: 'done' | 'active' | 'todo', index: number): string {
  return state === 'done' ? '✓' : String(index + 1);
}

function stepClass(state: 'done' | 'active' | 'todo'): string {
  if (state === 'done') return 'stepper__item stepper__item--done';
  if (state === 'active') return 'stepper__item stepper__item--active';
  return 'stepper__item';
}

/* ------------------------------ 读取数据 ------------------------------ */

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    await loadActivities();
    const id = activity.selectedId.value;
    view.value = await api.get<WorkbenchDto>('/admin/workbench', id ? { batchId: id } : undefined);
    // 刷新页面后接着看正在进行的计算，而不是重新发起一次
    const activeTask = view.value.tasks.find((item) => item.status === 'queued' || item.status === 'running');
    if (activeTask) await trackTask(activeTask.id, activeTask.percent);
  } catch (error) {
    loadError.value = apiErrorInfo(error, '读取失败').message;
    view.value = null;
  } finally {
    loading.value = false;
  }
}

async function afterMutation(): Promise<void> {
  await loadActivities(true);
  await load();
}

/* ------------------------------ 跳转规则 ------------------------------ */

const FIX_ROUTE: Partial<Record<BlockerFix, string>> = {
  config: 'admin-records-config',
  materials: 'admin-teaching-courses',
  exceptions: 'admin-records-exceptions',
  guarantee: 'admin-students-guarantee',
  preallocations: 'admin-teaching-preallocation',
  users: 'admin-students',
};

function handleFix(fix: BlockerFix | undefined): void {
  if (!fix) return;
  if (fix === 'confirmations') {
    void openSubmissions(1);
    return;
  }
  if (fix === 'submissions') {
    // 能生成方案就直接生成；缺少冻结快照时只能重新开放志愿提交（唯一的受控恢复路径）
    const generate = view.value?.actions.find((item) => item.key === 'generate_plan');
    if (generate?.enabled) {
      void clickAction(generate);
      return;
    }
    const reopen = view.value?.actions.find((item) => item.key === 'reopen_submission');
    if (reopen) {
      void clickAction(reopen);
      return;
    }
    void openSubmissions(1);
    return;
  }
  const name = FIX_ROUTE[fix];
  if (name) void router.push({ name });
}

/* ------------------------------ 动作执行 ------------------------------ */

/** 确认框里要说明：影响谁、会发生什么、能不能恢复 */
function actionDetails(action: WorkbenchAction): string[] {
  const lines: string[] = [];
  const current = view.value;
  if (!current?.batch) return lines;
  lines.push(`选课活动：${current.batch.name}（${current.batch.term}）`);
  lines.push(`当前阶段：${stageHeadline.value.title}`);
  if (action.key === 'open_preference') {
    lines.push('开放后学生可以规划课表、提交或撤回志愿。');
    lines.push('截止时间之前可以随时调整，也可以重新开放。');
  }
  if (action.key === 'close_submission') {
    lines.push('结束后学生不能再提交或撤回志愿，系统会生成本轮冻结快照。');
    lines.push('如需继续修改，需要重新开放志愿提交，已有分配方案会作废。');
  }
  if (action.key === 'generate_plan') {
    lines.push('按公平规则在后台计算，期间可以离开本页，回来后仍能看到进度。');
    lines.push('这次计算只是试算，不会直接改变学生的选课结果。');
  }
  if (action.key === 'open_change') {
    lines.push('开放后学生可以选课、退课、同课换班，候补开始自动递补。');
    lines.push('此操作只影响本系统内的选课，不改变已发布的成绩或课表记录。');
  }
  if (action.key === 'close_activity') {
    lines.push('结束后学生只能查看结果，候补不再递补。历史记录会保留。');
  }
  if (action.key === 'publish_result') {
    lines.push('发布后学生立刻能看到录取结果，但还不能选退换课。');
    lines.push('整轮结果不能回退；退改选需要另行开放。');
    if (current.plan?.report) {
      lines.push(
        `方案摘要：已安排 ${current.plan.report.allocated} 项 · 未落实 ${current.plan.report.rejected} 项`,
      );
      lines.push(
        `毕业保障满足 ${current.plan.report.guaranteeFulfilled} 人 · 可释放预留 ${current.plan.report.releasedReservedSeats} 个`,
      );
    }
  }
  if (action.key === 'reopen_submission') {
    lines.push('已有志愿会保留，学生可以继续修改。');
    lines.push('旧的冻结快照与分配方案会作废，需要重新生成方案。');
    lines.push('固定随机信息保留，不会重新抽签。');
  }
  if (action.key === 'adjust_deadline') {
    lines.push('只修改志愿提交截止时间，不影响已提交的志愿与其它配置。');
  }
  return lines;
}

/** 点击阶段主按钮或辅助按钮 */
async function clickAction(action: WorkbenchAction | null): Promise<void> {
  if (!action || busy.value) return;
  if (action.key === 'create_activity') {
    await router.push({ name: 'admin-workspace-activities' });
    return;
  }
  if (action.key === 'review_result') {
    showPlanDetail.value = true;
    return;
  }
  // 需要补充输入的动作先在页面上收集，再确认执行
  if (action.input === 'closeAt') {
    openDeadlineForm(action);
    return;
  }
  await runAction(action, {});
}

/** 收集新的截止时间（开放预选 / 重新开放提交 / 调整截止时间都走这里） */
function openDeadlineForm(action: WorkbenchAction): void {
  pendingAction.value = action;
  form.closeAt = toDateTimeLocal(view.value?.batch?.closeAt ?? null) || defaultCloseAt();
  form.reason = '';
}

function defaultCloseAt(): string {
  const date = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 只调整志愿提交截止时间：不改变阶段，也不作废任何方案 */
function startAdjustDeadline(): void {
  openDeadlineForm({
    key: 'adjust_deadline',
    label: '调整截止时间',
    description: '只修改志愿提交截止时间，不影响已提交的志愿、冻结快照与其它配置。',
    primary: false,
    enabled: true,
    input: 'closeAt',
    blockers: [],
  });
}

async function confirmPendingAction(): Promise<void> {
  const action = pendingAction.value;
  if (!action) return;
  if (!form.closeAt) {
    toast.warning('请填写截止时间');
    return;
  }
  await runAction(action, { closeAt: toIsoOrNull(form.closeAt), reason: form.reason || undefined });
}

async function runAction(action: WorkbenchAction, payload: Record<string, unknown>): Promise<void> {
  const current = view.value;
  if (!current?.batchId) return;
  const ok = await askConfirm({
    title: action.label,
    message: action.description,
    details: actionDetails(action),
    confirmText: `确认${action.label}`,
    danger: action.key === 'close_activity' || action.key === 'publish_result',
  });
  if (!ok) return;
  busy.value = true;
  try {
    const path = ACTION_PATH[action.key];
    if (!path) return;
    const result = await api.post<Record<string, unknown>>(
      `/admin/batches/${current.batchId}/actions/${path}`,
      payload,
    );
    pendingAction.value = null;
    if (action.key === 'generate_plan') {
      const taskId = Number(result.taskId ?? 0);
      if (taskId) {
        toast.info('已开始生成分配方案', ['可以离开本页，回来后仍能看到进度']);
        await afterMutation();
        await trackTask(taskId, 0);
        return;
      }
    }
    toast.success(`${action.label}已完成`, actionResultLines(action, result));
    await afterMutation();
  } catch (error) {
    const info = apiErrorInfo(error, `${action.label}失败`);
    toast.error(info.title, [info.message, ...info.lines]);
  } finally {
    busy.value = false;
  }
}

/** 成功后提示实际结果与下一步该做什么 */
function actionResultLines(action: WorkbenchAction, result: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const numberAt = (key: string): number | null => {
    const value = result[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  if (action.key === 'open_preference' || action.key === 'reopen_submission') {
    const closeAt = typeof result.closeAt === 'string' ? result.closeAt : null;
    lines.push(closeAt ? `学生可以在 ${formatDateTime(closeAt)} 之前提交或撤回志愿。` : '学生现在可以提交或撤回志愿。');
  }
  if (action.key === 'reopen_submission') {
    const runs = numberAt('invalidatedRuns');
    if (runs !== null && runs > 0) lines.push(`旧的分配方案（${runs} 份）已作废，请重新生成。`);
  }
  if (action.key === 'adjust_deadline') {
    const closeAt = typeof result.closeAt === 'string' ? result.closeAt : null;
    if (closeAt) lines.push(`新的截止时间是 ${formatDateTime(closeAt)}。`);
  }
  if (action.key === 'close_submission') {
    const students = numberAt('students');
    const classes = numberAt('classes');
    if (students !== null || classes !== null) {
      lines.push(`本轮检查了 ${students ?? 0} 名学生的志愿与 ${classes ?? 0} 个教学班。`);
    }
  }
  if (action.key === 'publish_result') {
    const report = result.report;
    if (report && typeof report === 'object') {
      const data = report as { allocated?: number; rejected?: number };
      if (typeof data.allocated === 'number' || typeof data.rejected === 'number') {
        lines.push(`已安排 ${data.allocated ?? 0} 项，未落实 ${data.rejected ?? 0} 项。`);
      }
    }
  }
  const next = view.value?.stage.nextStep;
  if (next) lines.push(`下一步：${next}`);
  return lines;
}

/* --------------------------- 后台计算进度 --------------------------- */

/** 任务百分比：接口直接给 percent，工作台列表只给状态时按 0 处理 */
function percentOf(update: BackgroundTask): number {
  return typeof update.percent === 'number' ? update.percent : 0;
}

async function trackTask(taskId: number, initialPercent = 0): Promise<void> {
  stopPolling();
  taskPercent.value = initialPercent;
  try {
    const initial = await fetchTask(taskId);
    task.value = initial;
    taskPercent.value = percentOf(initial);
    if (isTaskActive(initial)) {
      const finished = await waitForTask(taskId, {
        intervalMs: 500,
        timeoutMs: 180_000,
        onUpdate: (update) => {
          task.value = update;
          taskPercent.value = percentOf(update);
        },
        shouldStop: () => unmounted,
      });
      task.value = finished;
      taskPercent.value = percentOf(finished);
      if (isTaskActive(finished)) {
        toast.warning('任务仍在处理中', ['可以稍后刷新查看结果']);
        schedulePoll(taskId);
        return;
      }
    }
    onTaskSettled(task.value);
  } catch (error) {
    reportApiError(error, '读取任务进度失败');
  }
}

function schedulePoll(taskId: number): void {
  pollTimer = window.setTimeout(() => {
    void (async () => {
      const latest = await fetchTask(taskId);
      task.value = latest;
      taskPercent.value = percentOf(latest);
      if (isTaskActive(latest)) schedulePoll(taskId);
      else onTaskSettled(latest);
    })();
  }, 1500);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function onTaskSettled(settled: BackgroundTask | null): void {
  if (!settled) return;
  if (settled.status === 'succeeded') {
    toast.success('分配方案已生成', ['可以查看方案摘要，确认后发布选课结果']);
    void afterMutation();
  } else if (settled.status === 'timeout') {
    toast.error('计算超时，未生成可用方案', ['可以稍后重试；超时不会发布任何部分结果']);
  } else if (settled.status === 'failed' || settled.status === 'cancelled') {
    toast.error('计算未完成', [settled.errorMessage ?? '可以重新生成分配方案']);
  }
}

const taskTone = computed(() => {
  const status = task.value?.status;
  if (status === 'succeeded') return { text: '已完成', cls: 'badge badge--ok' };
  if (status === 'timeout') return { text: '超时', cls: 'badge badge--danger' };
  if (status === 'cancelled') return { text: '已取消', cls: 'badge badge--danger' };
  if (status === 'failed') return { text: '失败', cls: 'badge badge--danger' };
  if (status === 'queued') return { text: '排队中', cls: 'badge badge--warn' };
  return { text: '处理中', cls: 'badge badge--warn' };
});

/* --------------------------- 提交情况 / 名单 --------------------------- */

async function openSubmissions(page = 1): Promise<void> {
  if (!batchId.value) return;
  showSubmissions.value = true;
  loadingSubmissions.value = true;
  try {
    submissions.value = await api.get<SubmissionsPayload>(`/admin/batches/${batchId.value}/submissions`, {
      page,
      pageSize: submissionPageSize.value,
    });
    submissionPage.value = page;
  } catch (error) {
    reportApiError(error, '读取提交情况失败');
  } finally {
    loadingSubmissions.value = false;
  }
}

function toggleSubmissions(): void {
  if (showSubmissions.value) {
    showSubmissions.value = false;
    return;
  }
  void openSubmissions(1);
}

async function openNotSubmitted(page = 1): Promise<void> {
  if (!batchId.value) return;
  showNotSubmitted.value = true;
  loadingNotSubmitted.value = true;
  try {
    notSubmitted.value = await api.get<NotSubmittedPayload>(`/admin/batches/${batchId.value}/not-submitted`, {
      page,
      pageSize: notSubmittedPageSize.value,
    });
    notSubmittedPage.value = page;
  } catch (error) {
    reportApiError(error, '读取未提交名单失败');
  } finally {
    loadingNotSubmitted.value = false;
  }
}

function closeNotSubmitted(): void {
  showNotSubmitted.value = false;
}

function submissionStatusText(status: string): string {
  if (status === 'submitted') return '有效';
  if (status === 'withdrawn') return '已撤回';
  return '待确认';
}

function submissionStatusClass(status: string): string {
  if (status === 'submitted') return 'badge badge--ok';
  if (status === 'withdrawn') return 'badge badge--muted';
  return 'badge badge--warn';
}

/* ------------------------------ 生命周期 ------------------------------ */

onMounted(load);
onUnmounted(() => {
  unmounted = true;
  stopPolling();
});

// 导航栏切换选课活动后自动刷新本页数据
watch(
  () => activity.selectedId.value,
  (next, previous) => {
    if (next !== previous) {
      showSubmissions.value = false;
      showNotSubmitted.value = false;
      submissions.value = null;
      notSubmitted.value = null;
      void load();
    }
  },
);
</script>

<template>
  <div class="page">
    <!-- 1. 页头：标题 + 副标题；右侧两行小字是当前活动与学年学期 -->
    <div class="page__header">
      <div>
        <h1 class="page__title">选课工作台</h1>
        <p class="page__desc">本轮选课的进展和待办，都在这里。</p>
      </div>
      <div class="inline" style="gap: 12px">
        <div v-if="view?.batch" class="small muted" style="text-align: right">
          <div>{{ view.batch.name }}</div>
          <div>{{ view.batch.term }}</div>
        </div>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 读取失败：不把没拿到的数据显示成 0 -->
    <div v-if="loadError" class="alert alert--error">
      <strong>读取失败</strong>
      <div>{{ loadError }}</div>
      <button class="btn btn--primary btn--sm" type="button" style="margin-top: 8px" @click="load">重试</button>
    </div>

    <p v-else-if="loading && !view" class="muted">正在读取当前进度…</p>

    <!-- 10. 还没有选课活动：一张卡说明准备事项，并给出两个入口 -->
    <template v-else-if="view && !view.batch">
      <section class="card">
        <h3 class="card__title">还没有选课活动</h3>
        <p class="page__desc">先创建本次选课活动，再按“准备资料 → 检查并开放预选”的顺序推进。</p>
        <div class="action-row">
          <button class="btn btn--primary btn--lg" type="button" @click="router.push({ name: 'admin-workspace-activities' })">
            创建选课活动
          </button>
          <button class="btn btn--ghost" type="button" @click="router.push({ name: 'admin-teaching-courses' })">
            先准备教学资料
          </button>
        </div>
      </section>

      <section v-if="checklist.length > 0" class="card">
        <div class="card__header">
          <h3 class="card__title">资料准备情况</h3>
          <button class="link-btn" type="button" @click="router.push({ name: 'admin-teaching-courses' })">查看资料 ↗</button>
        </div>
        <div class="checklist">
          <div v-for="item in checklist" :key="item.key" class="checklist__row">
            <span class="checklist__mark" :class="{ 'checklist__mark--warn': !item.done }">{{ item.done ? '✓' : '!' }}</span>
            <span class="checklist__label">{{ item.label }}</span>
            <span class="checklist__value">{{ item.value }}</span>
          </div>
        </div>
      </section>

      <section v-if="todos.length > 0" class="card">
        <h3 class="card__title">需要你看一下</h3>
        <div v-for="todo in todos" :key="todo.key" :class="todoClass(todo)">
          <div class="todo__title">{{ todo.title }}</div>
          <div class="todo__detail">{{ todo.detail }}</div>
          <ul v-if="todo.items.length > 0" class="todo__items">
            <li v-for="(item, index) in todo.items" :key="index">
              {{ item.label }}<span v-if="item.sub" class="muted small"> · {{ item.sub }}</span>
            </li>
          </ul>
          <div v-if="todo.fix" class="action-row" style="margin-top: 10px">
            <button class="btn btn--sm btn--ghost" type="button" @click="handleFix(todo.fix)">{{ todo.fixLabel }}</button>
          </div>
        </div>
      </section>
    </template>

    <!-- 有选课活动：阶段大卡 → 五段进度 → 两栏内容 -->
    <template v-else-if="view && view.batch">
      <!-- 2. 阶段大卡（绿色）：左边说明当前阶段，右边看学生提交情况 -->
      <section class="hero">
        <div>
          <div class="hero__eyebrow">● 当前阶段</div>
          <h2 class="hero__title">{{ stageHeadline.title }}</h2>
          <p class="hero__desc">{{ studentCanFirst }}</p>
          <p v-if="view.batch.closeAt" class="hero__desc">本轮提交将于 {{ formatDateTime(view.batch.closeAt) }} 截止。</p>

          <div class="hero__actions">
            <button
              v-if="primaryAction"
              class="btn btn--primary btn--lg"
              type="button"
              :disabled="busy || loading || !primaryAction.enabled"
              @click="clickAction(primaryAction)"
            >
              {{ busy ? '处理中…' : primaryAction.label }}
            </button>
            <button
              v-for="item in secondaryActions"
              :key="item.key"
              class="btn btn--ghost"
              type="button"
              :disabled="busy || loading || !item.enabled"
              @click="clickAction(item)"
            >
              {{ item.label }}
            </button>
            <button
              v-if="view.stage.key === 'preference_open'"
              class="btn btn--ghost"
              type="button"
              :disabled="busy || loading"
              @click="startAdjustDeadline"
            >
              调整截止时间
            </button>
          </div>
        </div>

        <div class="hero__side">
          <div class="hero__side-head">
            <span>学生提交情况</span>
            <span>共 {{ countText(totalStudents) }} 人</span>
          </div>
          <div class="hero__stats">
            <div>
              <div class="hero__stat-value">{{ countText(submittedCount) }}</div>
              <div class="hero__stat-label">已提交</div>
            </div>
            <div>
              <div class="hero__stat-value">{{ countText(notSubmittedCount) }}</div>
              <div class="hero__stat-label">未提交</div>
            </div>
          </div>
          <div class="progress">
            <div class="progress__track">
              <div class="progress__bar" :style="{ width: progressWidth }"></div>
            </div>
            <div class="progress__meta">
              <span>已提交 {{ countText(submittedCount) }} / {{ countText(totalStudents) }} 人</span>
              <span>{{ submittedPercent === null ? '暂无提交数据' : `已完成 ${submittedPercent}%` }}</span>
            </div>
          </div>
          <div class="action-row">
            <button class="link-btn" type="button" @click="openNotSubmitted(1)">查看未提交名单 ↗</button>
          </div>
        </div>
      </section>

      <!-- 5. 主按钮暂时不能执行时，逐条说清原因并给出处理入口 -->
      <div v-if="primaryAction && !primaryAction.enabled && primaryBlockers.length > 0" class="alert alert--warning">
        <strong>还不能执行「{{ primaryAction.label }}」</strong>
        <div v-for="item in primaryBlockers" :key="item.code" class="inline" style="margin-top: 6px; align-items: flex-start">
          <span>{{ item.message }}</span>
          <button v-if="item.fix" class="btn btn--sm btn--ghost" type="button" @click="handleFix(item.fix)">
            {{ item.fixLabel ?? '去处理' }}
          </button>
        </div>
      </div>

      <!-- 需要补充截止时间的动作：先在本页填写，再确认一次 -->
      <section v-if="pendingAction" class="card card--flat">
        <h3 class="card__title">{{ pendingAction.label }}</h3>
        <p class="small muted">{{ pendingAction.description }}</p>
        <div class="grid grid--2">
          <label class="field">
            <span class="field__label">新的截止时间</span>
            <input v-model="form.closeAt" class="input" type="datetime-local" />
          </label>
          <label class="field">
            <span class="field__label">原因（可选，会写入操作记录）</span>
            <input v-model="form.reason" class="input" type="text" placeholder="例如：学生反馈漏选课程" />
          </label>
        </div>
        <div class="inline">
          <button class="btn btn--primary" type="button" :disabled="busy" @click="confirmPendingAction">
            {{ busy ? '处理中…' : '确认执行' }}
          </button>
          <button class="btn btn--ghost" type="button" @click="pendingAction = null">取消</button>
        </div>
      </section>

      <!-- 后台计算进度：可离开页面，刷新后继续跟踪 -->
      <section v-if="task" class="alert alert--info">
        <div class="inline">
          <span :class="taskTone.cls">{{ taskTone.text }}</span>
          <span class="muted small">已处理 {{ taskPercent }}%</span>
          <span class="spacer"></span>
          <button v-if="isTaskActive(task)" class="btn btn--ghost btn--sm" type="button" @click="stopPolling">暂停刷新</button>
        </div>
        <div v-if="task.errorMessage" class="small" style="margin-top: 6px">{{ task.errorMessage }}</div>
        <div class="action-row" style="margin-top: 6px">
          <button class="link-btn" type="button" @click="showTechDetail = !showTechDetail">
            {{ showTechDetail ? '收起详细信息' : '显示详细信息' }}
          </button>
          <span v-if="showTechDetail" class="small muted">本次计算开始于 {{ formatDateTime(task.createdAt) }}。</span>
        </div>
      </section>

      <!-- 3. 五段进度：资料准备 → 预选提交 → 分配与发布 → 退改选 → 结束 -->
      <section class="stepper">
        <template v-for="(step, index) in steps" :key="step.key">
          <span v-if="index > 0" class="stepper__line"></span>
          <span :class="stepClass(step.state)">
            <span class="stepper__dot">{{ stepMark(step.state, index) }}</span>
            <span class="stepper__label">{{ step.label }}</span>
          </span>
        </template>
      </section>

      <!-- 4. 两栏内容 -->
      <div class="two-col">
        <!-- 左栏：需要你看一下的待办 -->
        <section>
          <div class="card__header">
            <h2 class="section-title">
              需要你看一下
              <span class="section-title__count">{{ todos.length }} 项待处理</span>
            </h2>
          </div>

          <template v-if="todos.length > 0">
            <div v-for="todo in todos" :key="todo.key" :class="todoClass(todo)">
              <div class="inline" style="align-items: flex-start">
                <div>
                  <div class="todo__title">{{ todo.title }}</div>
                  <div class="todo__detail">{{ todo.detail }}</div>
                </div>
                <span class="spacer"></span>
                <button v-if="todo.fix" class="btn btn--sm btn--ghost" type="button" @click="handleFix(todo.fix)">
                  {{ todo.fixLabel }}
                </button>
              </div>
              <ul v-if="todo.items.length > 0" class="todo__items">
                <li v-for="(item, index) in todo.items" :key="index">
                  {{ item.label }}<span v-if="item.sub" class="muted small"> · {{ item.sub }}</span>
                </li>
              </ul>
            </div>
          </template>
          <div v-else class="todo todo--info">
            <div class="todo__title">当前没有待处理事项</div>
            <div class="todo__detail">按上面的下一步按钮推进即可。</div>
          </div>

          <p class="note">
            <span class="note__index">1</span>
            <span>结束提交后，系统会先检查资料和志愿，再生成分配方案。</span>
          </p>
          <p class="note">
            <span class="note__index">2</span>
            <span>结果发布后，需要另行开放退改选，学生不会提前进入下一阶段。</span>
          </p>
        </section>

        <!-- 右栏：本轮准备情况 + 最近操作 -->
        <div class="stack">
          <section class="card">
            <div class="card__header">
              <h3 class="card__title">本轮准备情况</h3>
              <button class="link-btn" type="button" @click="router.push({ name: 'admin-teaching-courses' })">查看资料 ↗</button>
            </div>
            <div class="checklist">
              <div v-for="item in checklist" :key="item.key" class="checklist__row">
                <span class="checklist__mark" :class="{ 'checklist__mark--warn': !item.done }">{{ item.done ? '✓' : '!' }}</span>
                <span class="checklist__label">{{ item.label }}</span>
                <span class="checklist__value">{{ item.value }}</span>
              </div>
            </div>
            <p class="note">
              <span class="note__index">ⓘ</span>
              <span>结果发布后，需要另行开放退改选，学生不会提前进入下一阶段。</span>
            </p>
          </section>

          <section class="card">
            <div class="card__header">
              <h3 class="card__title">最近操作</h3>
              <button class="link-btn" type="button" @click="router.push({ name: 'admin-records-audit' })">查看全部记录 ↗</button>
            </div>
            <div v-if="recentActivity.length === 0" class="muted">暂无操作记录</div>
            <div v-else class="recent">
              <div v-for="row in recentActivity" :key="row.id" class="recent__row">
                <span class="recent__time">{{ formatDateTime(row.createdAt) }}</span>
                <span>{{ row.actorName ?? '系统' }} {{ row.summary }}</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      <!-- 9. 分配方案摘要（可折叠） -->
      <section v-if="view.plan" class="card">
        <div class="card__header">
          <h3 class="card__title">分配方案摘要</h3>
          <div class="inline">
            <span v-if="view.plan.invalidated" class="badge badge--warn">已失效</span>
            <span v-else-if="view.plan.status === 'published'" class="badge badge--ok">已发布</span>
            <span v-else-if="view.plan.status === 'succeeded'" class="badge badge--ok">已生成，待发布</span>
            <span v-else class="badge badge--muted">尚无可用方案</span>
            <button class="btn btn--ghost btn--sm" type="button" @click="showPlanDetail = !showPlanDetail">
              {{ showPlanDetail ? '收起' : '展开' }}
            </button>
          </div>
        </div>

        <div v-if="view.plan.report" class="grid grid--4">
          <div class="stat">
            <div class="stat__label">已安排</div>
            <div class="stat__value">{{ view.plan.report.allocated }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">未落实</div>
            <div class="stat__value">{{ view.plan.report.rejected }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">毕业保障满足</div>
            <div class="stat__value">{{ view.plan.report.guaranteeFulfilled }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">可释放预留</div>
            <div class="stat__value">{{ view.plan.report.releasedReservedSeats }}</div>
          </div>
        </div>
        <p v-else class="muted small">这份方案没有生成摘要（可能未完成）。</p>

        <p v-if="view.plan.invalidated" class="alert alert--warning" style="margin-top: 10px">
          这份方案已失效：选课活动重新开放过志愿提交，请重新生成。
        </p>

        <div v-if="showPlanDetail" class="small muted" style="margin-top: 8px">
          <div>生成时间：{{ formatDateTime(view.plan.generatedAt) }}</div>
          <div>发布时间：{{ formatDateTime(view.plan.publishedAt) }}</div>
          <div>第 {{ view.plan.attempt ?? '—' }} 次计算</div>
        </div>
      </section>

      <!-- 8. 提交情况 / 未提交名单：默认收起 -->
      <section class="card">
        <div class="card__header">
          <h3 class="card__title">学生提交情况</h3>
          <div class="inline">
            <span class="muted small">
              已提交 {{ countText(submittedCount) }} 人 · 未提交 {{ countText(notSubmittedCount) }} 人
            </span>
            <button class="btn btn--ghost btn--sm" type="button" @click="toggleSubmissions">
              {{ showSubmissions ? '收起' : '展开' }}
            </button>
          </div>
        </div>

        <template v-if="showSubmissions">
          <div v-if="submissions && submissions.pending.length > 0" class="alert alert--warning">
            <strong>已提交志愿但还没有确认个人修读记录：{{ submissions.pending.length }} 人</strong>
            <ul>
              <li v-for="student in submissions.pending.slice(0, 20)" :key="student.studentId">
                {{ student.name }}（{{ student.studentNo }}）
              </li>
            </ul>
            <span class="small">需要学生本人确认后，才能结束提交并生成分配方案。</span>
          </div>

          <p v-if="loadingSubmissions" class="muted">正在读取…</p>
          <p v-else-if="!submissions || submissions.items.length === 0" class="muted">还没有提交记录。</p>
          <div v-else class="table-wrap">
            <table class="table table--compact">
              <thead>
                <tr>
                  <th>学号</th>
                  <th>姓名</th>
                  <th>版本</th>
                  <th>状态</th>
                  <th>志愿数</th>
                  <th>提交时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in submissions.items" :key="row.id">
                  <td class="mono">{{ row.studentNo }}</td>
                  <td>{{ row.name }}</td>
                  <td>v{{ row.versionNo }}</td>
                  <td>
                    <span :class="submissionStatusClass(row.status)">{{ submissionStatusText(row.status) }}</span>
                  </td>
                  <td>{{ row.courseCount }}</td>
                  <td class="small muted">{{ formatDateTime(row.submittedAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <Pager
            :page="submissionPage"
            :page-size="submissionPageSize"
            :total="submissions?.total ?? 0"
            :disabled="loadingSubmissions"
            @change="openSubmissions"
          />
        </template>
        <p v-else class="muted small">点“展开”查看每位学生的提交情况与未确认名单。</p>
      </section>

      <section v-if="showNotSubmitted" class="card">
        <div class="card__header">
          <h3 class="card__title">未提交名单（共 {{ notSubmitted?.total ?? 0 }} 人）</h3>
          <button class="btn btn--ghost btn--sm" type="button" @click="closeNotSubmitted">关闭</button>
        </div>
        <p v-if="loadingNotSubmitted" class="muted">正在读取…</p>
        <p v-else-if="!notSubmitted || notSubmitted.items.length === 0" class="muted">全部学生都已提交志愿。</p>
        <template v-else>
          <div class="table-wrap">
            <table class="table table--compact">
              <thead>
                <tr>
                  <th>学号</th>
                  <th>姓名</th>
                  <th>年级</th>
                  <th>专业</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in notSubmitted.items" :key="row.studentId">
                  <td class="mono">{{ row.studentNo }}</td>
                  <td>{{ row.name }}</td>
                  <td>{{ row.grade ?? '—' }}</td>
                  <td>{{ row.major ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <Pager
            :page="notSubmittedPage"
            :page-size="notSubmittedPageSize"
            :total="notSubmitted.total"
            :disabled="loadingNotSubmitted"
            @change="openNotSubmitted"
          />
        </template>
      </section>
    </template>
  </div>
</template>
