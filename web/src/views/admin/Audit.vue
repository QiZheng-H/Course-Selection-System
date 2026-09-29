<script setup lang="ts">
/**
 * 操作记录。
 *
 * 面向管理人员与排查：谁在什么时候做了什么。
 * 默认只展示业务可读的摘要，技术错误码放在详细信息里。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { reportApiError } from '@/stores/toast';
import type { AdminOperationRow, AuditRow } from '@/api/types';
import { formatDateTime, opTypeLabel } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

const tab = ref<'audit' | 'operations'>('audit');
const loading = ref(true);
const loadError = ref('');
const showTechnical = ref(false);

const auditRows = ref<AuditRow[]>([]);
const auditTotal = ref(0);
const auditPage = ref(1);
const auditAction = ref('');

const operationRows = ref<AdminOperationRow[]>([]);
const operationTotal = ref(0);
const operationPage = ref(1);
const pageSize = 30;

/** 常见操作的中文说明，避免直接显示内部动作名 */
const ACTION_LABEL: Record<string, string> = {
  'batch.create': '创建选课活动',
  'batch.update': '修改选课活动设置',
  'batch.transition': '变更选课阶段',
  'batch.open_preference': '开放预选',
  'batch.close_submission': '结束志愿提交',
  'batch.open_change': '开放退改选',
  'batch.close_activity': '结束本次选课',
  'batch.reopen_submission': '重新开放志愿提交',
  'batch.adjust_deadline': '调整截止时间',
  'batch.freeze': '生成冻结快照',
  'allocation.simulate': '生成分配方案',
  'allocation.publish': '发布选课结果',
  'allocation.stale': '作废过期方案',
  'allocation.failed': '分配计算失败',
  'guarantee.release_reserved': '释放毕业保障预留名额',
  'waitlist.promote': '候补递补',
  'task.failed': '后台任务失败',
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

async function loadAudit(page = 1): Promise<void> {
  try {
    const data = await api.get<{ items: AuditRow[]; total: number }>('/admin/audit', {
      page,
      pageSize,
      action: auditAction.value || undefined,
    });
    auditRows.value = data.items;
    auditTotal.value = data.total;
    auditPage.value = page;
  } catch (error) {
    loadError.value = apiErrorInfo(error, '读取失败').message;
  }
}

async function loadOperations(page = 1): Promise<void> {
  try {
    const data = await api.get<{ items: AdminOperationRow[]; total: number }>('/admin/operations', { page, pageSize });
    operationRows.value = data.items;
    operationTotal.value = data.total;
    operationPage.value = page;
  } catch (error) {
    reportApiError(error, '读取学生选课操作失败');
  }
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  await Promise.all([loadAudit(1), loadOperations(1)]);
  loading.value = false;
}

const actionOptions = computed(() => {
  const actions = new Set(Object.keys(ACTION_LABEL));
  return Array.from(actions);
});

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">操作记录</h1>
        <p class="page__desc">管理员操作与学生选退课过程记录，用于交接与排查。</p>
      </div>
      <div class="inline">
        <button class="btn btn--ghost btn--sm" type="button" @click="showTechnical = !showTechnical">
          {{ showTechnical ? '隐藏技术信息' : '显示技术信息' }}
        </button>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <p v-if="loadError" class="alert alert--error">
      <strong>读取失败</strong>：{{ loadError }}
      <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="load">重试</button>
    </p>

    <div class="inline" style="margin-bottom: 10px">
      <button class="btn btn--sm" :class="tab === 'audit' ? 'btn--primary' : 'btn--ghost'" type="button" @click="tab = 'audit'">
        管理员操作
      </button>
      <button
        class="btn btn--sm"
        :class="tab === 'operations' ? 'btn--primary' : 'btn--ghost'"
        type="button"
        @click="tab = 'operations'"
      >
        学生选退课
      </button>
    </div>

    <section v-if="tab === 'audit'" class="card">
      <div class="card__header">
        <h3 class="card__title">管理员操作（{{ auditTotal }} 条）</h3>
        <select v-model="auditAction" class="select" @change="loadAudit(1)">
          <option value="">全部操作</option>
          <option v-for="item in actionOptions" :key="item" :value="item">{{ actionLabel(item) }}</option>
        </select>
      </div>
      <div v-if="auditRows.length === 0" class="muted">没有符合条件的操作记录。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>操作人</th>
              <th>做了什么</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in auditRows" :key="row.id">
              <td class="small muted">{{ formatDateTime(row.created_at) }}</td>
              <td>{{ row.actor_name ?? '系统' }}</td>
              <td>{{ actionLabel(row.action) }}</td>
              <td class="small">
                {{ row.summary }}
                <div v-if="showTechnical" class="mono small muted">
                  {{ row.action }} · {{ row.entity_type }}#{{ row.entity_id }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager :page="auditPage" :page-size="pageSize" :total="auditTotal" :disabled="loading" @change="loadAudit" />
    </section>

    <section v-else class="card">
      <div class="card__header">
        <h3 class="card__title">学生选退课记录（{{ operationTotal }} 条）</h3>
      </div>
      <div v-if="operationRows.length === 0" class="muted">还没有学生的选退课记录。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>学生</th>
              <th>操作</th>
              <th>结果</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in operationRows" :key="row.id">
              <td class="small muted">{{ formatDateTime(row.createdAt) }}</td>
              <td>{{ row.studentName ?? '—' }}<span class="mono small muted"> {{ row.studentNo ?? '' }}</span></td>
              <td>{{ opTypeLabel(row.opType) }}</td>
              <td>
                <span class="badge" :class="row.status === 'success' ? 'badge--ok' : 'badge--danger'">
                  {{ row.status === 'success' ? '成功' : '未完成' }}
                </span>
              </td>
              <td class="small">
                {{ row.message ?? '—' }}
                <div v-if="showTechnical && row.errorCode" class="mono small muted">{{ row.errorCode }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager
        :page="operationPage"
        :page-size="pageSize"
        :total="operationTotal"
        :disabled="loading"
        @change="loadOperations"
      />
    </section>
  </div>
</template>
