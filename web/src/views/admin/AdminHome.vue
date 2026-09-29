<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { reportApiError } from '@/stores/toast';
import type { AdminStats, BatchDto, ExceptionRow } from '@/api/types';
import { batchStatusLabel, formatDateTime, severityLabel } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

const loading = ref(true);
const errorMessage = ref('');
const stats = ref<AdminStats | null>(null);
const openExceptions = ref<ExceptionRow[]>([]);
const exceptionTotal = ref(0);
const exceptionPage = ref(1);
const exceptionPageSize = 20;
const batches = ref<BatchDto[]>([]);
const currentBatch = ref<BatchDto | null>(null);
const configReady = ref(true);
const configIssues = ref<string[]>([]);

const criticalCount = computed(() => openExceptions.value.filter((row) => row.severity === 'critical').length);

async function loadExceptions(page = 1): Promise<void> {
  try {
    const data = await api.get<{ items: ExceptionRow[]; total: number }>('/admin/exceptions', {
      status: 'open',
      page,
      pageSize: exceptionPageSize,
    });
    openExceptions.value = data.items;
    exceptionTotal.value = data.total;
    exceptionPage.value = page;
  } catch (error) {
    reportApiError(error, '读取异常清单失败');
  }
}

async function load(): Promise<void> {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [statsRes, batchRes, configRes] = await Promise.all([
      api.get<{ stats: AdminStats }>('/admin/stats'),
      api.get<{ batches: BatchDto[]; current: BatchDto | null }>('/admin/batches'),
      api.get<{ configReady: boolean; issues: string[] }>('/admin/configs'),
    ]);
    stats.value = statsRes.stats;
    batches.value = batchRes.batches;
    currentBatch.value = batchRes.current;
    configReady.value = configRes.configReady;
    configIssues.value = configRes.issues;
    await loadExceptions(1);
  } catch (error) {
    errorMessage.value = apiErrorInfo(error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">管理端总览</h1>
        <p class="page__desc">系统统计、进行中批次状态与待处理的关键异常。</p>
      </div>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
    </div>

    <p v-if="errorMessage" class="alert alert--error">{{ errorMessage }}</p>

    <p v-if="!configReady" class="alert alert--warning">
      必需配置尚未齐全，批次不能开放：{{ configIssues.join('；') }}
    </p>

    <div class="grid grid--4">
      <div class="stat">
        <div class="stat__label">学生数</div>
        <div class="stat__value">{{ stats?.students ?? '—' }}</div>
      </div>
      <div class="stat">
        <div class="stat__label">课程数</div>
        <div class="stat__value">{{ stats?.courses ?? '—' }}</div>
      </div>
      <div class="stat">
        <div class="stat__label">教学班数</div>
        <div class="stat__value">{{ stats?.classes ?? '—' }}</div>
      </div>
      <div class="stat">
        <div class="stat__label">有效选课记录</div>
        <div class="stat__value">{{ stats?.enrollments ?? '—' }}</div>
      </div>
      <div class="stat">
        <div class="stat__label">候补排队</div>
        <div class="stat__value">{{ stats?.waiting ?? '—' }}</div>
      </div>
      <div class="stat">
        <div class="stat__label">候补暂挂</div>
        <div class="stat__value">{{ stats?.suspended ?? '—' }}</div>
      </div>
      <div class="stat">
        <div class="stat__label">未处理异常</div>
        <div class="stat__value">{{ stats?.openExceptions ?? '—' }}</div>
        <div class="stat__extra">其中严重 {{ criticalCount }} 条（当前页统计）</div>
      </div>
      <div class="stat">
        <div class="stat__label">进行中批次</div>
        <div class="stat__value" style="font-size: 15px">
          {{ currentBatch ? batchStatusLabel(currentBatch.status) : '无' }}
        </div>
        <div class="stat__extra">{{ currentBatch ? `${currentBatch.name}（${currentBatch.term}）` : '—' }}</div>
      </div>
    </div>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">批次列表</h3>
        <router-link class="btn btn--ghost btn--sm" :to="{ name: 'admin-batches' }">批次控制</router-link>
      </div>
      <div v-if="batches.length === 0" class="muted">还没有任何批次。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>批次</th>
              <th>学期</th>
              <th>状态</th>
              <th>提交情况</th>
              <th>开放 / 截止</th>
              <th>配置</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in batches" :key="batch.id">
              <td>{{ batch.name }}</td>
              <td>{{ batch.term }}</td>
              <td>
                <span class="badge" :class="batch.status === 'closed' ? 'badge--muted' : 'badge--ok'">
                  {{ batchStatusLabel(batch.status) }}
                </span>
              </td>
              <td class="small">
                有效 {{ batch.submissions.submitted }} · 撤回 {{ batch.submissions.withdrawn }} · 学生
                {{ batch.submissions.students }}
              </td>
              <td class="small muted">
                开放 {{ formatDateTime(batch.openAt) }}<br />
                截止 {{ formatDateTime(batch.closeAt) }}
              </td>
              <td>
                <span class="badge" :class="batch.configReady ? 'badge--ok' : 'badge--warn'">
                  {{ batch.configReady ? '就绪' : '缺失' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">待办：开放异常（status=open）</h3>
        <router-link class="btn btn--ghost btn--sm" :to="{ name: 'admin-exceptions' }">异常与操作记录</router-link>
      </div>
      <div v-if="openExceptions.length === 0" class="muted">没有未处理的异常。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>类型</th>
              <th>严重程度</th>
              <th>学生</th>
              <th>课程</th>
              <th>详情</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in openExceptions" :key="row.id">
              <td class="mono">{{ row.kind }}</td>
              <td>
                <span class="badge" :class="row.severity === 'critical' ? 'badge--danger' : 'badge--warn'">
                  {{ severityLabel(row.severity) }}
                </span>
              </td>
              <td>{{ row.studentName ?? '—' }}<span class="small muted">{{ row.studentNo ? `（${row.studentNo}）` : '' }}</span></td>
              <td>{{ row.courseName ?? '—' }}</td>
              <td class="small muted">{{ row.detail ?? '—' }}</td>
              <td class="small muted">{{ formatDateTime(row.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager
        :page="exceptionPage"
        :page-size="exceptionPageSize"
        :total="exceptionTotal"
        :disabled="loading"
        @change="loadExceptions"
      />
    </section>
  </div>
</template>
