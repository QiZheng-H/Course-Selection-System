<script setup lang="ts">
/**
 * 历史选课活动与资料版本。
 *
 * 历史活动必须明确标注为历史，不能与当前活动混淆；
 * 资料版本与导入来源属于“详情”，不占主操作区。
 */
import { onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { reportApiError } from '@/stores/toast';
import { useActivity, loadActivities } from '@/stores/activity';
import type { BatchDto, DataVersionRow, ImportBatchRow } from '@/api/types';
import { batchStatusLabel, formatDateTime, importKindLabel } from '@/utils/labels';

const activity = useActivity();
const loading = ref(true);
const loadError = ref('');
const versions = ref<DataVersionRow[]>([]);
const imports = ref<ImportBatchRow[]>([]);
const scopeFilter = ref('');

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    await loadActivities(true);
    const [versionData, importData] = await Promise.all([
      api.get<{ versions: DataVersionRow[] }>('/admin/versions', { scope: scopeFilter.value || undefined }),
      api.get<{ batches: ImportBatchRow[] }>('/admin/imports'),
    ]);
    versions.value = versionData.versions;
    imports.value = importData.batches;
  } catch (error) {
    loadError.value = apiErrorInfo(error, '读取失败').message;
  } finally {
    loading.value = false;
  }
}

async function changeScope(): Promise<void> {
  try {
    const data = await api.get<{ versions: DataVersionRow[] }>('/admin/versions', {
      scope: scopeFilter.value || undefined,
    });
    versions.value = data.versions;
  } catch (error) {
    reportApiError(error, '读取资料版本失败');
  }
}

/** 内部批次标识不必为了改名而重建，这里只在详细信息里展示 */
function batchDetail(batch: BatchDto): string {
  return [
    `内部编号 #${batch.id}`,
    batch.snapshotHash ? `冻结快照 ${batch.snapshotHash.slice(0, 12)}…` : '尚无冻结快照',
    (batch.reopenCount ?? 0) > 0 ? `重新开放提交 ${batch.reopenCount} 次` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">历史活动与版本</h1>
        <p class="page__desc">已结束的选课活动、资料版本与导入来源。历史数据不会混入当前活动的统计。</p>
      </div>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
    </div>

    <p v-if="loadError" class="alert alert--error">
      <strong>读取失败</strong>：{{ loadError }}
      <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="load">重试</button>
    </p>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">全部选课活动（{{ activity.batches.value.length }}）</h3>
      </div>
      <div v-if="activity.batches.value.length === 0" class="empty">还没有任何选课活动。</div>
      <div v-else class="list">
        <div v-for="batch in activity.batches.value" :key="batch.id" class="list__item">
          <div class="inline">
            <strong>{{ batch.name }}</strong>
            <span class="badge badge--muted">{{ batch.term }}</span>
            <span class="badge" :class="batch.status === 'closed' ? 'badge--muted' : 'badge--ok'">
              {{ batchStatusLabel(batch.status) }}
            </span>
            <span v-if="batch.status === 'closed'" class="badge badge--muted">历史</span>
            <span v-else-if="batch.id === activity.selectedId.value" class="badge badge--ok">当前选择</span>
          </div>
          <div class="small muted">
            开放 {{ formatDateTime(batch.openAt) }} · 截止 {{ formatDateTime(batch.closeAt) }} · 结果发布
            {{ formatDateTime(batch.publishedAt) }} · 结束 {{ formatDateTime(batch.closedAt) }}<br />
            提交：有效 {{ batch.submissions.submitted }} / 撤回 {{ batch.submissions.withdrawn }} / 涉及学生
            {{ batch.submissions.students }}
          </div>
          <div class="small muted">{{ batchDetail(batch) }}</div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">资料版本（{{ versions.length }}）</h3>
        <select v-model="scopeFilter" class="select" @change="changeScope">
          <option value="">全部类型</option>
          <option value="courses">课程</option>
          <option value="classes">教学班</option>
          <option value="program">培养方案</option>
          <option value="records">修读记录</option>
          <option value="preallocation">专业课预分配</option>
        </select>
      </div>
      <div v-if="versions.length === 0" class="empty">还没有发布过任何资料版本。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>版本</th>
              <th>资料类型</th>
              <th>摘要</th>
              <th>发布人</th>
              <th>发布时间</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in versions" :key="row.id">
              <td>v{{ row.versionNo }}</td>
              <td>{{ importKindLabel(row.scope) }}</td>
              <td class="small">{{ row.summary }}</td>
              <td class="small muted">{{ row.publishedBy ?? '—' }}</td>
              <td class="small muted">{{ formatDateTime(row.publishedAt) }}</td>
              <td>
                <span class="badge" :class="row.active ? 'badge--ok' : 'badge--muted'">
                  {{ row.active ? '生效中' : '历史版本' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">导入来源（最近 {{ imports.length }} 次）</h3>
      </div>
      <div v-if="imports.length === 0" class="empty">还没有导入记录。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>类型</th>
              <th>原文件</th>
              <th>状态</th>
              <th>行数 / 错误</th>
              <th>导入时间</th>
              <th>发布时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in imports" :key="row.id">
              <td>{{ importKindLabel(row.kind) }}</td>
              <td>
                {{ row.fileName }}
                <div class="mono small muted">{{ row.fileHash.slice(0, 12) }}…</div>
              </td>
              <td>
                <span
                  class="badge"
                  :class="row.status === 'published' ? 'badge--ok' : row.errorCount > 0 ? 'badge--danger' : 'badge--warn'"
                >
                  {{ row.status === 'published' ? '已发布' : row.errorCount > 0 ? '待修正' : '已校验未发布' }}
                </span>
              </td>
              <td>{{ row.rowCount }} / {{ row.errorCount }}</td>
              <td class="small muted">{{ formatDateTime(row.createdAt) }}</td>
              <td class="small muted">{{ formatDateTime(row.publishedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
