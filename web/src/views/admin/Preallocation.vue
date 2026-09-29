<script setup lang="ts">
/**
 * 专业课预分配（教学资料）。
 *
 * 先回答“能安排多少人、有多少人安排不了、为什么”，
 * 失败项可以点开看原因；落实结果与撤销都在这一页完成。
 * 统一分配的“生成方案 / 发布结果”属于工作台，本页不提供。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import { useActivity, loadActivities } from '@/stores/activity';
import type { AllocationRun, PreallocationRow, PreallocationsPayload } from '@/api/types';
import { formatDateTime } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

const toast = useToast();
const activity = useActivity();

const loading = ref(false);
const loadError = ref('');
const applying = ref(false);
const actionRowId = ref<number | null>(null);
const preallocations = ref<PreallocationsPayload | null>(null);
const statusFilter = ref('');
const page = ref(1);
const pageSize = 20;
const term = ref('');
const showDetails = ref(false);
const showFailures = ref(false);
const runs = ref<AllocationRun[]>([]);

const statusOptions = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待落实' },
  { value: 'applied', label: '已落实' },
  { value: 'failed', label: '落实失败' },
  { value: 'reverted', label: '已撤销' },
];

const batch = computed(() => activity.selected.value);
const validation = computed(() => preallocations.value?.validation ?? null);

async function load(pageNumber = 1): Promise<void> {
  const batchId = activity.selectedId.value;
  if (!batchId) {
    preallocations.value = null;
    return;
  }
  loading.value = true;
  loadError.value = '';
  try {
    preallocations.value = await api.get<PreallocationsPayload>('/admin/preallocations', {
      batchId,
      status: statusFilter.value || undefined,
      page: pageNumber,
      pageSize,
    });
    page.value = pageNumber;
  } catch (error) {
    loadError.value = apiErrorInfo(error, '读取失败').message;
    preallocations.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadRuns(): Promise<void> {
  const batchId = activity.selectedId.value;
  if (!batchId) return;
  try {
    const data = await api.get<{ runs: AllocationRun[] }>(`/admin/batches/${batchId}/runs`);
    runs.value = data.runs;
  } catch (error) {
    reportApiError(error, '读取计算历史失败');
  }
}

async function applyPreallocations(): Promise<void> {
  const batchId = activity.selectedId.value;
  if (!batchId) return;
  const info = validation.value;
  const ok = await askConfirm({
    title: '落实专业课预分配',
    message: '按名单为学生占用名额（不含毕业保障预留）。失败的行会保留原因，可以修正后重复执行。',
    details: info
      ? [`待落实 ${info.total} 条，预计可落实 ${info.applicable} 条`, `预计失败 ${info.wouldFail.length} 条`]
      : [],
    confirmText: '确认落实',
  });
  if (!ok) return;
  applying.value = true;
  try {
    const result = await api.post<{ applied: number; failed: number }>('/admin/preallocations/apply', {
      batchId,
      term: term.value || undefined,
    });
    toast.success('预分配已落实', [`成功 ${result.applied} 条，失败 ${result.failed} 条`]);
    await load(page.value);
  } catch (error) {
    reportApiError(error, '落实预分配失败');
  } finally {
    applying.value = false;
  }
}

async function revertPreallocation(row: PreallocationRow): Promise<void> {
  const ok = await askConfirm({
    title: '撤销该条预分配',
    message: `将撤销「${row.studentName}（${row.studentNo}）→ ${row.courseName} ${row.classCode}」的选课记录。`,
    details: ['撤销后该名额会释放给其他学生。'],
    confirmText: '确认撤销',
  });
  if (!ok) return;
  actionRowId.value = row.id;
  try {
    const result = await api.post<{ ok: boolean; message: string }>(`/admin/preallocations/${row.id}/revert`, {});
    if (result.ok) toast.success('已撤销', [result.message]);
    else toast.warning('未能撤销', [result.message]);
    await load(page.value);
  } catch (error) {
    reportApiError(error, '撤销失败');
  } finally {
    actionRowId.value = null;
  }
}

function runSummary(run: AllocationRun): string {
  if (!run.report) return '—';
  try {
    const report = JSON.parse(run.report) as { allocated?: number; rejected?: number };
    return `已安排 ${report.allocated ?? 0} · 未落实 ${report.rejected ?? 0}`;
  } catch {
    return '—';
  }
}

onMounted(async () => {
  await loadActivities();
  term.value = activity.selected.value?.term ?? '';
  await Promise.all([load(1), loadRuns()]);
});

watch(
  () => activity.selectedId.value,
  async (next, previous) => {
    if (next === previous) return;
    term.value = activity.selected.value?.term ?? '';
    await Promise.all([load(1), loadRuns()]);
  },
);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">专业课预分配</h1>
        <p class="page__desc">
          按管理员导入的专业课名单提前占位。这里只处理“能安排多少、安排不了多少、为什么”。
        </p>
      </div>
      <div class="inline">
        <button class="btn btn--ghost btn--sm" type="button" @click="showDetails = !showDetails">
          {{ showDetails ? '隐藏详细信息' : '显示详细信息' }}
        </button>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load(page)">刷新</button>
      </div>
    </div>

    <p v-if="!batch" class="alert alert--warning">还没有选择选课活动，请先在导航栏选择或创建一个活动。</p>

    <p v-if="loadError" class="alert alert--error">
      <strong>读取失败</strong>：{{ loadError }}
      <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="load(page)">重试</button>
    </p>

    <template v-if="batch">
      <div class="inline" style="margin-bottom: 10px">
        <span class="badge badge--muted">{{ batch.term }}</span>
        <span class="muted small">{{ batch.name }}</span>
      </div>

      <div class="grid grid--4">
        <div class="stat">
          <div class="stat__label">待落实人数</div>
          <div class="stat__value">{{ validation?.total ?? '—' }}</div>
          <div class="stat__extra">名单中还没落实的记录</div>
        </div>
        <div class="stat">
          <div class="stat__label">可安排人数</div>
          <div class="stat__value">{{ validation?.applicable ?? '—' }}</div>
          <div class="stat__extra">按当前名额可以落实</div>
        </div>
        <div class="stat">
          <div class="stat__label">无法安排人数</div>
          <div class="stat__value">{{ validation?.wouldFail.length ?? '—' }}</div>
          <div class="stat__extra">
            <button
              v-if="(validation?.wouldFail.length ?? 0) > 0"
              class="btn btn--ghost btn--sm"
              type="button"
              @click="showFailures = !showFailures"
            >
              {{ showFailures ? '收起详情' : '查看原因' }}
            </button>
          </div>
        </div>
        <div class="stat">
          <div class="stat__label">涉及教学班</div>
          <div class="stat__value">{{ validation?.byClass.length ?? '—' }}</div>
          <div class="stat__extra">按教学班统计名额</div>
        </div>
      </div>

      <section class="card">
        <div class="card__header">
          <h3 class="card__title">落实预分配</h3>
          <div class="inline">
            <select v-model="statusFilter" class="select" @change="load(1)">
              <option v-for="item in statusOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
            <button class="btn btn--primary btn--sm" type="button" :disabled="applying" @click="applyPreallocations">
              {{ applying ? '落实中…' : '落实预分配' }}
            </button>
          </div>
        </div>

        <div v-if="showFailures && validation && validation.wouldFail.length > 0" class="alert alert--warning">
          <strong>以下记录按当前名额无法安排</strong>
          <ul>
            <li v-for="item in validation.wouldFail" :key="item.id">
              {{ item.studentNo }} → {{ item.courseName }} {{ item.classCode }}：{{ item.reason }}
            </li>
          </ul>
          <span class="small">可以调整教学班容量或预分配名单后重新落实。</span>
        </div>

        <div v-if="showDetails && validation && validation.byClass.length > 0" class="table-wrap" style="margin-top: 10px">
          <table class="table table--compact">
            <thead>
              <tr>
                <th>教学班</th>
                <th>课程</th>
                <th>可安排上限</th>
                <th>申请数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in validation.byClass" :key="row.classId">
                <td class="mono">{{ row.classCode }}</td>
                <td>{{ row.courseName }}</td>
                <td>{{ row.limit }}</td>
                <td :class="row.requested > row.limit ? 'badge--danger' : ''">{{ row.requested }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!preallocations || preallocations.items.length === 0" class="muted" style="margin-top: 10px">
          没有符合条件的预分配记录。可以在“资料导入”里上传专业课预分配名单。
        </div>
        <div v-else class="table-wrap" style="margin-top: 10px">
          <table class="table">
            <thead>
              <tr>
                <th>学生</th>
                <th>课程 / 教学班</th>
                <th>状态</th>
                <th>说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in preallocations.items" :key="row.id">
                <td>{{ row.studentName }}<div class="mono small muted">{{ row.studentNo }}</div></td>
                <td>{{ row.courseName }}<div class="mono small muted">{{ row.classCode }}</div></td>
                <td>
                  <span
                    class="badge"
                    :class="row.status === 'applied' ? 'badge--ok' : row.status === 'failed' ? 'badge--danger' : 'badge--muted'"
                  >
                    {{
                      row.status === 'applied'
                        ? '已落实'
                        : row.status === 'failed'
                          ? '落实失败'
                          : row.status === 'reverted'
                            ? '已撤销'
                            : '待落实'
                    }}
                  </span>
                </td>
                <td class="small muted">
                  {{ row.reason ?? '—' }}
                  <div v-if="showDetails" class="mono small muted">
                    容量 {{ row.capacity }} / 预留 {{ row.reservedSeats }} / 余量 {{ row.margin }}
                  </div>
                </td>
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
          :page="page"
          :page-size="pageSize"
          :total="preallocations?.total ?? 0"
          :disabled="loading"
          @change="load"
        />
      </section>

      <section v-if="showDetails" class="card">
        <div class="card__header">
          <h3 class="card__title">统一分配计算历史（详细信息）</h3>
          <span class="muted small">生成与发布在“选课工作台”操作</span>
        </div>
        <div v-if="runs.length === 0" class="muted">还没有计算记录。</div>
        <div v-else class="list">
          <div v-for="run in runs" :key="run.id" class="list__item">
            <div class="inline">
              <strong>第 {{ run.attempt }} 次</strong>
              <span class="badge" :class="run.status === 'published' ? 'badge--ok' : run.status === 'failed' ? 'badge--danger' : 'badge--muted'">
                {{
                  run.status === 'published'
                    ? '已发布'
                    : run.status === 'succeeded'
                      ? '已生成'
                      : run.status === 'failed'
                        ? '失败'
                        : run.status
                }}
              </span>
              <span class="muted small">{{ formatDateTime(run.startedAt) }}</span>
              <span class="spacer"></span>
              <span class="small muted">{{ runSummary(run) }}</span>
            </div>
            <div v-if="run.failureReason" class="alert alert--error small" style="margin-top: 6px">{{ run.failureReason }}</div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
