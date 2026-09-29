<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type { ConfirmationStatus, EnrolledRow, RecordRow } from '@/api/types';
import { formatCredits, formatDateTime, recordStatusLabel, sourceLabel } from '@/utils/labels';

const toast = useToast();

const loading = ref(true);
const errorMessage = ref('');
const records = ref<RecordRow[]>([]);
const enrolled = ref<EnrolledRow[]>([]);
const confirmation = ref<ConfirmationStatus | null>(null);
const confirming = ref(false);
const activeTab = ref<'passed' | 'in_progress' | 'failed' | 'enrolled'>('passed');

const groups = computed(() => ({
  passed: records.value.filter((row) => row.status === 'passed'),
  in_progress: records.value.filter((row) => row.status === 'in_progress' || row.status === 'selected'),
  failed: records.value.filter((row) => row.status === 'failed'),
}));

const currentRows = computed<RecordRow[]>(() => {
  if (activeTab.value === 'enrolled') return [];
  return groups.value[activeTab.value];
});

const credits = computed(() => ({
  passed: groups.value.passed.reduce((sum, row) => sum + row.credits, 0),
  inProgress: groups.value.in_progress.reduce((sum, row) => sum + row.credits, 0),
  failed: groups.value.failed.length,
}));

async function load(): Promise<void> {
  loading.value = true;
  errorMessage.value = '';
  try {
    const data = await api.get<{ records: RecordRow[]; enrolled: EnrolledRow[]; confirmation: ConfirmationStatus }>(
      '/student/records',
    );
    records.value = data.records;
    enrolled.value = data.enrolled;
    confirmation.value = data.confirmation;
  } catch (error) {
    errorMessage.value = apiErrorInfo(error).message;
  } finally {
    loading.value = false;
  }
}

async function confirmRecords(): Promise<void> {
  const ok = await askConfirm({
    title: '确认个人修读记录',
    message: '确认仅表示你认可学校导入的修读记录，不会修改任何成绩或选课结果。',
    confirmText: '确认',
    danger: false,
  });
  if (!ok) return;
  confirming.value = true;
  try {
    await api.post('/student/records/confirm');
    toast.success('已确认个人修读记录');
    await load();
  } catch (error) {
    reportApiError(error, '确认失败');
  } finally {
    confirming.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">个人修读记录</h1>
        <p class="page__desc">记录来自学校导入的资料，需要你确认后才会作为正式竞争的依据。</p>
      </div>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
    </div>

    <p v-if="errorMessage" class="alert alert--error">{{ errorMessage }}</p>

    <section class="card" :class="confirmation?.confirmed && !confirmation?.needsReconfirm ? '' : 'card--flat'">
      <div class="inline">
        <strong>资料确认状态：</strong>
        <span v-if="confirmation?.needsReconfirm" class="badge badge--danger">需重新确认（关键资料已更新）</span>
        <span v-else-if="confirmation?.confirmed" class="badge badge--ok">已确认</span>
        <span v-else class="badge badge--warn">未确认</span>
        <span class="muted small">确认时间：{{ formatDateTime(confirmation?.confirmedAt) }}</span>
        <span class="spacer"></span>
        <button
          v-if="!confirmation?.confirmed || confirmation?.needsReconfirm"
          class="btn btn--primary btn--sm"
          type="button"
          :disabled="confirming"
          @click="confirmRecords"
        >
          {{ confirming ? '提交中…' : '确认我的修读记录' }}
        </button>
      </div>
      <p v-if="!confirmation?.confirmed" class="alert alert--warning" style="margin-top: 10px">
        未确认资料时，系统仍可保存草稿，但在正式冻结与竞争中会以“资料未确认”为由拒绝，请先确认。
      </p>
    </section>

    <div class="grid grid--3">
      <div class="stat">
        <div class="stat__label">已通过</div>
        <div class="stat__value">{{ groups.passed.length }}</div>
        <div class="stat__extra">共 {{ formatCredits(credits.passed) }} 学分</div>
      </div>
      <div class="stat">
        <div class="stat__label">在修 / 已选</div>
        <div class="stat__value">{{ groups.in_progress.length }}</div>
        <div class="stat__extra">共 {{ formatCredits(credits.inProgress) }} 学分</div>
      </div>
      <div class="stat">
        <div class="stat__label">未通过</div>
        <div class="stat__value">{{ groups.failed.length }}</div>
        <div class="stat__extra">需要重修或替代</div>
      </div>
    </div>

    <section class="card">
      <div class="tabs">
        <button class="tab" :class="{ 'tab--active': activeTab === 'passed' }" type="button" @click="activeTab = 'passed'">
          已通过（{{ groups.passed.length }}）
        </button>
        <button
          class="tab"
          :class="{ 'tab--active': activeTab === 'in_progress' }"
          type="button"
          @click="activeTab = 'in_progress'"
        >
          在修（{{ groups.in_progress.length }}）
        </button>
        <button class="tab" :class="{ 'tab--active': activeTab === 'failed' }" type="button" @click="activeTab = 'failed'">
          未通过（{{ groups.failed.length }}）
        </button>
        <button class="tab" :class="{ 'tab--active': activeTab === 'enrolled' }" type="button" @click="activeTab = 'enrolled'">
          本学期已选（{{ enrolled.length }}）
        </button>
      </div>

      <div v-if="activeTab === 'enrolled'">
        <div v-if="enrolled.length === 0" class="empty">本学期还没有已选课程。</div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>课程号</th>
                <th>课程名</th>
                <th>学分</th>
                <th>来源</th>
                <th>使用预留</th>
                <th>落实时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in enrolled" :key="row.id">
                <td class="mono">{{ row.courseCode }}</td>
                <td>{{ row.courseName }}</td>
                <td>{{ formatCredits(row.credits) }}</td>
                <td>{{ sourceLabel(row.source) }}</td>
                <td>{{ row.usesReserved ? '是' : '否' }}</td>
                <td class="small muted">{{ formatDateTime(row.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-else>
        <div v-if="currentRows.length === 0" class="empty">该分组暂无记录。</div>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>课程号</th>
                <th>课程名</th>
                <th>学分</th>
                <th>状态</th>
                <th>学期</th>
                <th>数据来源</th>
                <th>是否核实</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in currentRows" :key="row.id">
                <td class="mono">{{ row.courseCode }}</td>
                <td>{{ row.courseName }}</td>
                <td>{{ formatCredits(row.credits) }}</td>
                <td>{{ recordStatusLabel(row.status) }}</td>
                <td>{{ row.term ?? '—' }}</td>
                <td>{{ row.source }}</td>
                <td>
                  <span class="badge" :class="row.verified ? 'badge--ok' : 'badge--warn'">
                    {{ row.verified ? '已核实' : '需确认' }}
                  </span>
                </td>
                <td class="small muted">{{ formatDateTime(row.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>
