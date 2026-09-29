<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { newIdempotencyKey } from '@/api/idempotency';
import { fetchTask, isTaskActive, waitForTask } from '@/api/tasks';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type {
  AllocationItem,
  AllocationRun,
  AllocationRunDetail,
  BackgroundTask,
  BatchDto,
  PreallocationRow,
  PreallocationsPayload,
} from '@/api/types';
import { batchStatusLabel, decisionLabel, formatDateTime } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

interface AllocationReportView {
  totalStudents?: number;
  totalPreferences?: number;
  allocated?: number;
  rejected?: number;
  guaranteeAttempted?: number;
  guaranteeFulfilled?: number;
  releasedReservedSeats?: number;
  durationMs?: number;
  exceptions?: Array<{ kind: string; severity: string; studentId: number | null; courseId: number | null }>;
}

const toast = useToast();

const batches = ref<BatchDto[]>([]);
const batchId = ref<number | null>(null);
const batch = computed(() => batches.value.find((item) => item.id === batchId.value) ?? null);

const preallocations = ref<PreallocationsPayload | null>(null);
const preallocationStatus = ref('');
const preallocationPage = ref(1);
const preallocationPageSize = 20;
const loadingPreallocations = ref(false);
const applying = ref(false);
const actionRowId = ref<number | null>(null);

const freezing = ref(false);
const allocating = ref(false);
const publishing = ref<number | null>(null);
const enqueuing = ref(false);
const runs = ref<AllocationRun[]>([]);
const lastRun = ref<AllocationRun | null>(null);
const runDetail = ref<AllocationRunDetail | null>(null);
const detailFilter = ref('');
const loadingDetail = ref(false);
const publishKeys = reactive<Record<number, string>>({});
const term = ref('2026-2027-1');

/** 当前后台任务状态（页面展示处理中 / 成功 / 失败 / 超时） */
const task = ref<BackgroundTask | null>(null);
const taskError = ref<string | null>(null);
const taskKind = ref<'simulate' | 'publish' | 'publish-run' | null>(null);
let pollTimer: number | null = null;
let unmounted = false;

const freezeForce = ref(false);

const preallocationStatusOptions = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待落实' },
  { value: 'applied', label: '已落实' },
  { value: 'failed', label: '落实失败' },
  { value: 'reverted', label: '已撤销' },
];

function publishKeyFor(id: number): string {
  if (!publishKeys[id]) publishKeys[id] = newIdempotencyKey();
  return publishKeys[id];
}

async function loadBatches(): Promise<void> {
  try {
    const data = await api.get<{ batches: BatchDto[]; current: BatchDto | null }>('/admin/batches');
    batches.value = data.batches;
    if (batchId.value === null && data.batches.length > 0) {
      batchId.value = (data.current ?? data.batches[0]).id;
    }
    if (batchId.value !== null) {
      const found = data.batches.find((item) => item.id === batchId.value);
      if (found) term.value = found.term;
      await Promise.all([loadPreallocations(1), loadRuns()]);
    }
  } catch (error) {
    reportApiError(error, '读取批次失败');
  }
}

async function onBatchChange(): Promise<void> {
  const found = batch.value;
  if (found) term.value = found.term;
  runDetail.value = null;
  lastRun.value = null;
  await Promise.all([loadPreallocations(1), loadRuns()]);
}

async function loadPreallocations(page = 1): Promise<void> {
  if (batchId.value === null) return;
  loadingPreallocations.value = true;
  try {
    preallocations.value = await api.get<PreallocationsPayload>('/admin/preallocations', {
      batchId: batchId.value,
      status: preallocationStatus.value || undefined,
      page,
      pageSize: preallocationPageSize,
    });
    preallocationPage.value = page;
  } catch (error) {
    reportApiError(error, '读取预分配失败');
  } finally {
    loadingPreallocations.value = false;
  }
}

async function applyPreallocations(): Promise<void> {
  if (batchId.value === null) return;
  const validation = preallocations.value?.validation;
  const ok = await askConfirm({
    title: '落实专业课预分配',
    message: '预分配会通过正式选课服务占用名额（不含毕业预留）。失败的行会保留失败原因，可以修正后重复执行。',
    details: validation
      ? [
          `待落实 ${validation.total} 条，预计可落实 ${validation.applicable} 条`,
          validation.wouldFail.length > 0 ? `预计失败 ${validation.wouldFail.length} 条` : '预计没有失败项',
        ]
      : [],
    confirmText: '确认落实',
  });
  if (!ok) return;
  applying.value = true;
  try {
    const result = await api.post<{ applied: number; failed: number }>('/admin/preallocations/apply', {
      batchId: batchId.value,
      term: term.value || undefined,
    });
    toast.success('预分配已执行', [`成功 ${result.applied} 条，失败 ${result.failed} 条`]);
    await loadPreallocations(preallocationPage.value);
  } catch (error) {
    reportApiError(error, '落实预分配失败');
  } finally {
    applying.value = false;
  }
}

async function revertPreallocation(row: PreallocationRow): Promise<void> {
  const ok = await askConfirm({
    title: '撤销该条预分配',
    message: `将撤销「${row.studentName}（${row.studentNo}）→ ${row.courseName} ${row.classCode}」的预分配选课记录。`,
    confirmText: '确认撤销',
  });
  if (!ok) return;
  actionRowId.value = row.id;
  try {
    const result = await api.post<{ ok: boolean; message: string }>(`/admin/preallocations/${row.id}/revert`, {});
    if (result.ok) toast.success('已撤销', [result.message]);
    else toast.warning('未能撤销', [result.message]);
    await loadPreallocations(preallocationPage.value);
  } catch (error) {
    reportApiError(error, '撤销失败');
  } finally {
    actionRowId.value = null;
  }
}

async function freeze(): Promise<void> {
  if (batchId.value === null || !batch.value) return;
  const ok = await askConfirm({
    title: '冻结批次生成快照',
    message: '冻结后分配使用的所有输入都来自快照：之后修改资料、重新提交或新增选课都不会影响本轮结果。',
    details: [
      `批次：${batch.value.name}（${batch.value.term}）`,
      freezeForce.value ? '已勾选强制重新冻结：旧快照与旧结果会作废。' : '如果已有快照，重新冻结需要显式勾选强制。',
      '冻结前会检查“已提交志愿但资料未确认”的学生，若存在会返回 MATERIAL_NOT_CONFIRMED。',
    ],
    confirmText: '确认冻结',
    danger: freezeForce.value,
  });
  if (!ok) return;
  freezing.value = true;
  try {
    const result = await api.post<{ snapshotId: number; contentHash: string; summary: Record<string, number> }>(
      `/admin/batches/${batchId.value}/freeze`,
      { force: freezeForce.value },
    );
    toast.success('已冻结并生成快照', [
      `快照 #${result.snapshotId}`,
      `内容哈希 ${result.contentHash.slice(0, 16)}…`,
      Object.entries(result.summary)
        .map(([key, value]) => `${key}: ${value}`)
        .join('，'),
    ]);
    freezeForce.value = false;
    await loadBatches();
  } catch (error) {
    reportApiError(error, '冻结失败');
  } finally {
    freezing.value = false;
  }
}

async function allocateRun(mode: 'simulate' | 'publish'): Promise<void> {
  if (batchId.value === null || !batch.value) return;
  const idempotencyKey = mode === 'publish' ? publishKeyFor(batchId.value) : undefined;
  const ok = await askConfirm({
    title: mode === 'publish' ? '试算并发布（新建一次执行）' : '试算分配（不发布）',
    message:
      mode === 'publish'
        ? '本次会先试算并校验（保障异常未处理时会拒绝），再在一个事务里落实全部结果、释放预留、自动生成候补并发布批次；任何一步失败都会整体回滚。'
        : '试算只生成执行记录、判定明细与异常记录，不改动学生课表、保障状态与预留数量。',
    details: [
      `批次：${batch.value.name}（${batch.value.term}）`,
      batch.value.snapshotHash ? `快照：${batch.value.snapshotHash.slice(0, 16)}…` : '尚未冻结：请先冻结批次',
      mode === 'publish'
        ? `幂等键：${String(idempotencyKey).slice(0, 18)}…`
        : '推荐流程：试算 → 处理异常 → 在“执行历史”里发布指定的试算结果',
    ],
    confirmText: mode === 'publish' ? '确认执行并发布' : '开始试算',
    danger: mode === 'publish',
  });
  if (!ok) return;
  allocating.value = true;
  taskError.value = null;
  taskKind.value = mode;
  try {
    const start = await api.post<{ taskId: number; reused: boolean }>(`/admin/batches/${batchId.value}/allocate`, {
      mode,
      idempotencyKey,
    });
    // 后台任务：接口立即返回任务标识，页面轮询到终态
    const finished = await trackTask(start.taskId);
    if (!finished) return;
    if (finished.status === 'succeeded' || finished.status === 'timeout' || finished.status === 'failed') {
      await loadRuns();
      const runId = finished.result?.runId ?? finished.runId;
      if (runId) await loadRunDetail(runId);
      if (mode === 'publish' && finished.status === 'succeeded' && batchId.value !== null) {
        delete publishKeys[batchId.value];
      }
    }
  } catch (error) {
    reportApiError(error, mode === 'publish' ? '发布失败' : '试算失败');
  } finally {
    allocating.value = false;
  }
}

/** 轮询后台任务并展示状态；返回终态任务（失败时也返回，交由调用方处理） */
async function trackTask(taskId: number): Promise<BackgroundTask | null> {
  stopPolling();
  try {
    const initial = await fetchTask(taskId);
    task.value = initial;
    if (!isTaskActive(initial)) {
      onTaskSettled(initial);
      return initial;
    }
    const finished = await waitForTask(taskId, {
      intervalMs: 500,
      timeoutMs: 180_000,
      onUpdate: (update) => {
        task.value = update;
      },
      shouldStop: () => unmounted,
    });
    task.value = finished;
    if (isTaskActive(finished)) {
      // 超时仍未结束：继续后台轮询，页面提示“处理中”
      toast.warning('任务仍在处理中', ['可以稍后刷新查看结果，计算不会阻塞其它操作']);
      schedulePoll(taskId);
      return null;
    }
    onTaskSettled(finished);
    return finished;
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : String(error);
    reportApiError(error, '读取任务状态失败');
    return null;
  }
}

function schedulePoll(taskId: number): void {
  pollTimer = window.setTimeout(() => {
    void (async () => {
      const latest = await fetchTask(taskId);
      task.value = latest;
      if (isTaskActive(latest)) {
        schedulePoll(taskId);
      } else {
        onTaskSettled(latest);
      }
    })();
  }, 1500);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function onTaskSettled(finished: BackgroundTask): void {
  if (finished.status === 'succeeded') {
    const report = finished.result?.report;
    toast.success(taskKind.value === 'publish' ? '分配结果已发布' : '试算完成', [
      `任务 #${finished.id} 成功${finished.result?.idempotentReplay ? '（命中幂等键，复用已有结果）' : ''}`,
      report ? `已分配 ${report.allocated ?? 0} / 未分配 ${report.rejected ?? 0}` : '',
      report ? `释放预留 ${report.releasedReservedSeats ?? 0}，兜底满足 ${report.guaranteeFulfilled ?? 0}` : '',
      (report?.exceptions?.length ?? 0) > 0 ? `产生 ${report?.exceptions?.length ?? 0} 条异常，请到“异常处理”逐条确认` : '',
    ]);
    void loadRuns();
  } else if (finished.status === 'timeout') {
    toast.error('任务超时，未发布任何结果', ['可以缩小数据范围或提高超时上限后重试']);
  } else if (finished.status === 'failed') {
    toast.error('任务失败，正式数据未改变', [`[${finished.errorCode ?? 'INTERNAL'}] ${finished.errorMessage ?? '未知原因'}`]);
  }
}

/** 重新执行同一种任务（失败 / 超时后的重试） */
async function retryTask(): Promise<void> {
  const kind = taskKind.value;
  if (kind === 'publish-run') {
    const runId = task.value?.result?.runId ?? null;
    if (runId) await publishRunById(runId);
    return;
  }
  if (kind === 'simulate' || kind === 'publish') await allocateRun(kind);
}

/** 发布指定的、检查通过的试算结果 */
async function publishRunById(runId: number): Promise<void> {
  const ok = await askConfirm({
    title: `发布试算结果 #${runId}`,
    message:
      '发布前会校验批次状态、快照版本、保障异常与实际容量；选课落位、保护状态、预留释放、自动候补与批次发布在同一个事务里完成，任何一步失败都会整体回滚。',
    details: ['重复发布同一结果只会返回已有结果，不会取消学生已有课程。'],
    confirmText: '确认发布',
    danger: true,
  });
  if (!ok) return;
  publishing.value = runId;
  taskKind.value = 'publish-run';
  try {
    const result = await api.post<{ runId: number; status: string; alreadyPublished: boolean }>(
      `/admin/runs/${runId}/publish`,
      {},
    );
    toast.success('已发布试算结果', [
      `执行 #${result.runId}`,
      result.alreadyPublished ? '该结果此前已发布，本次返回已有结果' : '批次已进入“结果已发布”，首轮候补已自动生成',
    ]);
    taskError.value = null;
    await loadBatches();
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : String(error);
    reportApiError(error, '发布失败');
  } finally {
    publishing.value = null;
  }
}

function canPublishRun(run: AllocationRun): boolean {
  return run.status === 'succeeded' && run.mode === 'simulate';
}

async function loadRuns(): Promise<void> {
  if (batchId.value === null) return;
  try {
    const data = await api.get<{ runs: AllocationRun[] }>(`/admin/batches/${batchId.value}/runs`);
    runs.value = data.runs;
    lastRun.value = data.runs[0] ?? null;
  } catch (error) {
    reportApiError(error, '读取执行历史失败');
  }
}

async function loadRunDetail(runId: number): Promise<void> {
  loadingDetail.value = true;
  try {
    runDetail.value = await api.get<AllocationRunDetail>(`/admin/runs/${runId}`);
    detailFilter.value = '';
  } catch (error) {
    reportApiError(error, '读取执行详情失败');
  } finally {
    loadingDetail.value = false;
  }
}

async function enqueueWaitlist(): Promise<void> {
  if (batchId.value === null) return;
  const runId = lastRun.value?.mode === 'publish' ? lastRun.value.id : undefined;
  const ok = await askConfirm({
    title: '把首轮落选的申请转入候补',
    message: '只把“可等待”的落选申请转入候补；资格不符、课程不存在、重复课程等永久失效原因会直接关闭并说明原因。',
    details: runId ? [`使用发布记录 #${runId}`] : ['未检测到发布记录，将由后端尝试使用最近一次发布记录'],
    confirmText: '转入候补',
    danger: false,
  });
  if (!ok) return;
  enqueuing.value = true;
  try {
    const result = await api.post<{ queued: number; runId: number }>(`/admin/batches/${batchId.value}/enqueue-waitlist`, {
      runId,
    });
    toast.success('已转入候补', [`新增排队 ${result.queued} 条`, `来源发布记录 #${result.runId}`]);
  } catch (error) {
    reportApiError(error, '转入候补失败');
  } finally {
    enqueuing.value = false;
  }
}

function parseReport(run: AllocationRun): AllocationReportView | null {
  if (!run.report) return null;
  try {
    return JSON.parse(run.report) as AllocationReportView;
  } catch {
    return null;
  }
}

const filteredItems = computed<AllocationItem[]>(() => {
  const items = runDetail.value?.items ?? [];
  if (!detailFilter.value) return items;
  return items.filter((item) => item.decision === detailFilter.value);
});

const decisionCounts = computed(() => {
  const counts: Record<string, number> = {};
  for (const item of runDetail.value?.items ?? []) {
    counts[item.decision] = (counts[item.decision] ?? 0) + 1;
  }
  return counts;
});

onMounted(() => {
  void loadBatches();
});

onUnmounted(() => {
  unmounted = true;
  stopPolling();
});
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">预分配与统一分配</h1>
        <p class="page__desc">
          排序规则：培养需求等级（D2 &gt; D1 &gt; D0）→ 全局志愿排名 → 固定随机键。随机键在提交志愿时固定，重交与重试都不会重抽。
        </p>
      </div>
      <div class="inline">
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">批次</span>
          <select v-model.number="batchId" class="select" @change="onBatchChange">
            <option v-for="item in batches" :key="item.id" :value="item.id">
              {{ item.name }}（{{ item.term }} · {{ batchStatusLabel(item.status) }}）
            </option>
          </select>
        </label>
        <button class="btn btn--ghost btn--sm" type="button" @click="loadBatches">刷新</button>
      </div>
    </div>

    <section v-if="batch" class="card">
      <div class="inline">
        <span class="badge">{{ batchStatusLabel(batch.status) }}</span>
        <span class="badge badge--muted">{{ batch.term }}</span>
        <span class="badge" :class="batch.snapshotHash ? 'badge--ok' : 'badge--warn'">
          {{ batch.snapshotHash ? `已冻结快照 ${batch.snapshotHash.slice(0, 12)}…` : '尚未冻结' }}
        </span>
        <span class="badge" :class="batch.configReady ? 'badge--ok' : 'badge--warn'">
          配置{{ batch.configReady ? '就绪' : '缺失' }}
        </span>
      </div>
      <div class="toolbar" style="margin-top: 10px">
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">学期（预分配落实用）</span>
          <input v-model="term" class="input" type="text" />
        </label>
        <label class="checkbox">
          <input v-model="freezeForce" type="checkbox" />
          强制重新冻结（旧快照作废）
        </label>
        <button class="btn" :class="freezeForce ? 'btn--danger' : 'btn--primary'" type="button" :disabled="freezing || batchId === null" @click="freeze">
          {{ freezing ? '冻结中…' : '冻结批次' }}
        </button>
        <button class="btn btn--ghost" type="button" :disabled="allocating || batchId === null" @click="allocateRun('simulate')">
          {{ allocating && taskKind === 'simulate' ? '试算中…' : '试算（simulate）' }}
        </button>
        <button class="btn btn--danger" type="button" :disabled="allocating || batchId === null" @click="allocateRun('publish')">
          {{ allocating && taskKind === 'publish' ? '执行中…' : '试算并发布（新建执行）' }}
        </button>
        <button class="btn btn--ghost" type="button" :disabled="enqueuing || batchId === null" @click="enqueueWaitlist">
          {{ enqueuing ? '处理中…' : '首轮落选转候补' }}
        </button>
      </div>
      <ol class="tips" style="margin-top: 8px">
        <li>冻结批次生成快照（之后资料变化不影响本轮结果）。</li>
        <li>执行“试算”，只生成判定、报告与异常记录，不改变任何正式数据。</li>
        <li>到“异常处理”页对关键保障异常逐条形成处理结果。</li>
        <li>在下方“执行历史”里，对检查通过的试算结果点“发布此结果”。</li>
        <li>发布成功后批次进入“结果已发布”，首轮候补自动生成；退改选与公开补选在候补阶段进行。</li>
      </ol>
      <p class="tips" style="margin-top: 6px">
        发布使用整体事务：选课落位、保护状态、预留释放、自动候补与批次发布必须全部成功，否则整体回滚。重复发布同一结果只会返回已有结果，不会取消学生已有课程。
      </p>

      <div v-if="task" class="alert" style="margin-top: 10px">
        <div class="inline">
          <span
            class="badge"
            :class="{
              'badge--warn': task.status === 'queued' || task.status === 'running',
              'badge--ok': task.status === 'succeeded',
              'badge--danger': task.status === 'failed' || task.status === 'timeout',
            }"
          >
            {{
              task.status === 'queued'
                ? '排队中'
                : task.status === 'running'
                  ? '处理中'
                  : task.status === 'succeeded'
                    ? '成功'
                    : task.status === 'timeout'
                      ? '超时'
                      : task.status === 'failed'
                        ? '失败'
                        : task.status
            }}
          </span>
          <span class="muted small">任务 #{{ task.id }} · 进度 {{ task.percent }}%</span>
          <span v-if="task.runId" class="muted small">执行 #{{ task.runId }}</span>
          <span class="spacer"></span>
          <button v-if="isTaskActive(task)" class="btn btn--ghost btn--sm" type="button" @click="stopPolling">停止刷新</button>
          <button v-else-if="task.retryable && taskKind" class="btn btn--primary btn--sm" type="button" @click="retryTask">重试</button>
        </div>
        <div v-if="task.status === 'failed' || task.status === 'timeout'" class="small" style="margin-top: 6px">
          [{{ task.errorCode ?? 'INTERNAL' }}] {{ task.errorMessage ?? '任务未完成' }}
          <span v-if="task.status === 'timeout'">—— 超时不发布任何部分结果，可缩小范围后重试。</span>
        </div>
        <div v-if="taskError" class="small" style="margin-top: 6px">{{ taskError }}</div>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">预分配（GET /api/admin/preallocations）</h3>
        <div class="inline">
          <select v-model="preallocationStatus" class="select" @change="loadPreallocations(1)">
            <option v-for="item in preallocationStatusOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
          <button class="btn btn--primary btn--sm" type="button" :disabled="applying || batchId === null" @click="applyPreallocations">
            {{ applying ? '落实中…' : '落实预分配' }}
          </button>
        </div>
      </div>

      <div v-if="preallocations" class="grid grid--3">
        <div class="stat">
          <div class="stat__label">待落实总数</div>
          <div class="stat__value">{{ preallocations.validation.total }}</div>
          <div class="stat__extra">预计可落实 {{ preallocations.validation.applicable }}</div>
        </div>
        <div class="stat">
          <div class="stat__label">预计失败</div>
          <div class="stat__value">{{ preallocations.validation.wouldFail.length }}</div>
          <div class="stat__extra">名额不足（已扣除毕业预留与调整余量）</div>
        </div>
        <div class="stat">
          <div class="stat__label">涉及教学班</div>
          <div class="stat__value">{{ preallocations.validation.byClass.length }}</div>
          <div class="stat__extra">按教学班统计可分配上限与申请数</div>
        </div>
      </div>

      <div v-if="preallocations && preallocations.validation.wouldFail.length > 0" class="alert alert--warning" style="margin-top: 10px">
        <strong>预计落实失败</strong>
        <ul>
          <li v-for="item in preallocations.validation.wouldFail" :key="item.id">
            {{ item.studentNo }} → {{ item.courseName }} {{ item.classCode }}：{{ item.reason }}
          </li>
        </ul>
      </div>

      <div v-if="preallocations && preallocations.validation.byClass.length > 0" class="table-wrap" style="margin-top: 10px">
        <table class="table table--compact">
          <thead>
            <tr>
              <th>教学班</th>
              <th>课程</th>
              <th>可预分配上限</th>
              <th>申请数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in preallocations.validation.byClass" :key="row.classId">
              <td class="mono">{{ row.classCode }}</td>
              <td>{{ row.courseName }}</td>
              <td>{{ row.limit }}</td>
              <td :class="row.requested > row.limit ? 'badge--danger' : ''">{{ row.requested }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="!preallocations || preallocations.items.length === 0" class="muted" style="margin-top: 10px">没有符合条件的预分配记录。</div>
      <div v-else class="table-wrap" style="margin-top: 10px">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>学生</th>
              <th>课程 / 教学班</th>
              <th>容量 / 预留 / 余量</th>
              <th>状态</th>
              <th>失败原因</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in preallocations.items" :key="row.id">
              <td>{{ row.id }}</td>
              <td>{{ row.studentName }}<div class="mono small">{{ row.studentNo }}</div></td>
              <td>{{ row.courseName }}<div class="mono small">{{ row.classCode }}</div></td>
              <td class="small">{{ row.capacity }} / {{ row.reservedSeats }} / {{ row.margin }}</td>
              <td>
                <span
                  class="badge"
                  :class="row.status === 'applied' ? 'badge--ok' : row.status === 'failed' ? 'badge--danger' : 'badge--muted'"
                >
                  {{ row.status }}
                </span>
              </td>
              <td class="small muted">{{ row.reason ?? '—' }}</td>
              <td>
                <button
                  class="btn btn--sm btn--ghost"
                  type="button"
                  :disabled="row.status !== 'applied' || actionRowId === row.id"
                  @click="revertPreallocation(row)"
                >
                  撤销
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager
        :page="preallocationPage"
        :page-size="preallocationPageSize"
        :total="preallocations?.total ?? 0"
        :disabled="loadingPreallocations"
        @change="loadPreallocations"
      />
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">执行历史（GET /api/admin/batches/:id/runs）</h3>
        <button class="btn btn--ghost btn--sm" type="button" @click="loadRuns">刷新</button>
      </div>
      <div v-if="runs.length === 0" class="muted">还没有执行记录。</div>
      <div v-else class="list">
        <div v-for="run in runs" :key="run.id" class="list__item">
          <div class="inline">
            <strong>#{{ run.id }} 第 {{ run.attempt }} 次</strong>
            <span class="badge" :class="run.mode === 'publish' ? 'badge--danger' : 'badge--elective'">
              {{ run.mode === 'publish' ? '发布' : '试算' }}
            </span>
            <span class="badge" :class="run.status === 'failed' ? 'badge--danger' : 'badge--ok'">{{ run.status }}</span>
            <span class="muted small">
              {{ formatDateTime(run.startedAt) }} · 用时 {{ run.durationMs ?? '—' }} ms
            </span>
            <span class="spacer"></span>
            <button class="btn btn--sm btn--ghost" type="button" @click="loadRunDetail(run.id)">查看逐条判定</button>
            <button
              v-if="canPublishRun(run)"
              class="btn btn--sm btn--primary"
              type="button"
              :disabled="publishing === run.id"
              @click="publishRunById(run.id)"
            >
              {{ publishing === run.id ? '发布中…' : '发布此结果' }}
            </button>
            <span v-else-if="run.status === 'published'" class="badge badge--ok">已发布</span>
          </div>
          <div v-if="run.failureReason" class="alert alert--error small" style="margin-top: 6px">
            [{{ run.failureCode }}] {{ run.failureReason }}
          </div>
          <div v-if="parseReport(run)" class="small muted" style="margin-top: 4px">
            学生 {{ parseReport(run)?.totalStudents ?? 0 }} · 志愿 {{ parseReport(run)?.totalPreferences ?? 0 }} · 已分配
            {{ parseReport(run)?.allocated ?? 0 }} · 未分配 {{ parseReport(run)?.rejected ?? 0 }} · 兜底满足
            {{ parseReport(run)?.guaranteeFulfilled ?? 0 }} · 释放预留 {{ parseReport(run)?.releasedReservedSeats ?? 0 }} ·
            异常 {{ parseReport(run)?.exceptions?.length ?? 0 }}
          </div>
        </div>
      </div>
    </section>

    <section v-if="runDetail" class="card">
      <div class="card__header">
        <h3 class="card__title">执行详情 #{{ runDetail.run.id }}（逐条判定）</h3>
        <div class="inline">
          <select v-model="detailFilter" class="select">
            <option value="">全部判定</option>
            <option value="allocated">已分配（{{ decisionCounts.allocated ?? 0 }}）</option>
            <option value="rejected">未分配（{{ decisionCounts.rejected ?? 0 }}）</option>
            <option value="waitlisted">转入候补（{{ decisionCounts.waitlisted ?? 0 }}）</option>
            <option value="error">异常（{{ decisionCounts.error ?? 0 }}）</option>
          </select>
          <button class="btn btn--ghost btn--sm" type="button" @click="runDetail = null">关闭</button>
        </div>
      </div>
      <p class="tips">
        判定依据：需求等级 {{ 'D2 > D1 > D0' }} → 全局志愿排名 → 固定随机键。下表展示每一条申请实际使用的排序依据与原因。
      </p>
      <div v-if="filteredItems.length === 0" class="empty">没有符合条件的判定明细。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>学生</th>
              <th>课程</th>
              <th>教学班</th>
              <th>需求等级</th>
              <th>全局排名</th>
              <th>随机键</th>
              <th>判定</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredItems" :key="item.id">
              <td>{{ item.studentName }}<div class="mono small">{{ item.studentNo }}</div></td>
              <td>{{ item.courseName }}</td>
              <td class="mono">{{ item.classCode ?? '—' }}</td>
              <td>{{ item.demandLevel }}</td>
              <td>{{ item.globalRank }}</td>
              <td class="mono small">{{ item.randomKey ? `${item.randomKey.slice(0, 10)}…` : '—' }}</td>
              <td>
                <span class="badge" :class="item.decision === 'allocated' ? 'badge--ok' : item.decision === 'error' ? 'badge--danger' : 'badge--warn'">
                  {{ decisionLabel(item.decision) }}
                </span>
                <div class="mono small muted">{{ item.reasonCode }}</div>
              </td>
              <td class="small">{{ item.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
