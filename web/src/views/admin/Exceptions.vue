<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type { AdminOperationRow, AuditPayload, BatchDto, ExceptionRow } from '@/api/types';
import { batchStatusLabel, formatDateTime, opTypeLabel, severityLabel } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

const toast = useToast();

const batches = ref<BatchDto[]>([]);
const batchFilter = ref<number | null>(null);
const statusFilter = ref('open');

const exceptions = ref<ExceptionRow[]>([]);
const exceptionTotal = ref(0);
const exceptionPage = ref(1);
const exceptionPageSize = 20;
const loadingExceptions = ref(false);
const resolving = reactive<Record<number, boolean>>({});
const resolutionText = reactive<Record<number, string>>({});
const resolutionStatus = reactive<Record<number, 'resolved' | 'ignored'>>({});

const audit = ref<AuditPayload | null>(null);
const auditAction = ref('');
const auditPage = ref(1);
const auditPageSize = 20;
const loadingAudit = ref(false);

const operations = ref<{ items: AdminOperationRow[]; total: number } | null>(null);
const operationPage = ref(1);
const operationPageSize = 20;
const loadingOperations = ref(false);

async function loadExceptions(page = 1): Promise<void> {
  loadingExceptions.value = true;
  try {
    const data = await api.get<{ items: ExceptionRow[]; total: number }>('/admin/exceptions', {
      batchId: batchFilter.value ?? undefined,
      status: statusFilter.value || undefined,
      page,
      pageSize: exceptionPageSize,
    });
    exceptions.value = data.items;
    exceptionTotal.value = data.total;
    exceptionPage.value = page;
  } catch (error) {
    reportApiError(error, '读取异常清单失败');
  } finally {
    loadingExceptions.value = false;
  }
}

async function resolveException(row: ExceptionRow): Promise<void> {
  const text = (resolutionText[row.id] ?? '').trim();
  if (!text) {
    toast.warning('必须填写处理说明', ['处理说明会写入异常记录与审计日志。']);
    return;
  }
  const status = resolutionStatus[row.id] ?? 'resolved';
  const ok = await askConfirm({
    title: status === 'resolved' ? '标记异常已处理' : '忽略该异常',
    message:
      status === 'resolved'
        ? '标记为已处理表示问题已经形成明确结论（例如调整教学班、替换课程或已通知学生）。'
        : '忽略表示经评估不构成需要处理的问题，请务必在说明中写清理由。',
    details: [`异常 #${row.id}（${row.kind}）`, `处理说明：${text}`],
    confirmText: '提交处理结果',
    danger: status === 'ignored',
  });
  if (!ok) return;
  resolving[row.id] = true;
  try {
    await api.post(`/admin/exceptions/${row.id}/resolve`, { resolution: text, status });
    toast.success('处理结果已保存');
    await Promise.all([loadExceptions(exceptionPage.value), loadAudit(auditPage.value)]);
  } catch (error) {
    reportApiError(error, '保存处理结果失败');
  } finally {
    resolving[row.id] = false;
  }
}

async function loadAudit(page = 1): Promise<void> {
  loadingAudit.value = true;
  try {
    audit.value = await api.get<AuditPayload>('/admin/audit', {
      action: auditAction.value.trim() || undefined,
      page,
      pageSize: auditPageSize,
    });
    auditPage.value = page;
  } catch (error) {
    reportApiError(error, '读取审计日志失败');
  } finally {
    loadingAudit.value = false;
  }
}

async function loadOperations(page = 1): Promise<void> {
  loadingOperations.value = true;
  try {
    operations.value = await api.get<{ items: AdminOperationRow[]; total: number }>('/admin/operations', {
      page,
      pageSize: operationPageSize,
    });
    operationPage.value = page;
  } catch (error) {
    reportApiError(error, '读取选课操作记录失败');
  } finally {
    loadingOperations.value = false;
  }
}

function prettyDetail(detail: string | null): string {
  if (!detail) return '—';
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

onMounted(async () => {
  try {
    const data = await api.get<{ batches: BatchDto[] }>('/admin/batches');
    batches.value = data.batches;
  } catch {
    // 批次列表失败不影响异常处理
  }
  await Promise.all([loadExceptions(1), loadAudit(1), loadOperations(1)]);
});
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">异常与操作记录</h1>
        <p class="page__desc">异常必须形成明确处理结果；处理说明会写入异常记录，并保留在审计日志中。</p>
      </div>
      <button class="btn btn--ghost btn--sm" type="button" @click="loadExceptions(1); loadAudit(1); loadOperations(1)">
        刷新
      </button>
    </div>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">异常清单</h3>
        <div class="inline">
          <select v-model.number="batchFilter" class="select" @change="loadExceptions(1)">
            <option :value="null">全部批次</option>
            <option v-for="item in batches" :key="item.id" :value="item.id">
              {{ item.name }}（{{ batchStatusLabel(item.status) }}）
            </option>
          </select>
          <select v-model="statusFilter" class="select" @change="loadExceptions(1)">
            <option value="">全部状态</option>
            <option value="open">未处理</option>
            <option value="resolved">已处理</option>
            <option value="ignored">已忽略</option>
          </select>
        </div>
      </div>

      <div v-if="exceptions.length === 0" class="empty">没有符合条件的异常。</div>
      <div v-else class="list">
        <div
          v-for="row in exceptions"
          :key="row.id"
          class="list__item"
          :class="row.status === 'open' && row.severity === 'critical' ? 'list__item--danger' : ''"
        >
          <div class="inline">
            <strong>#{{ row.id }}</strong>
            <span class="badge" :class="row.severity === 'critical' ? 'badge--danger' : row.severity === 'warning' ? 'badge--warn' : 'badge--muted'">
              {{ severityLabel(row.severity) }}
            </span>
            <span class="badge mono">{{ row.kind }}</span>
            <span class="badge" :class="row.status === 'open' ? 'badge--warn' : 'badge--ok'">
              {{ row.status === 'open' ? '未处理' : row.status === 'resolved' ? '已处理' : '已忽略' }}
            </span>
            <span class="muted small">
              {{ row.studentName ?? '—' }}{{ row.studentNo ? `（${row.studentNo}）` : '' }}
              <template v-if="row.courseName"> · {{ row.courseName }}</template>
              · {{ formatDateTime(row.createdAt) }}
            </span>
            <span v-if="row.batchId" class="badge badge--muted">批次 #{{ row.batchId }}</span>
          </div>

          <details style="margin-top: 6px">
            <summary class="small muted">查看详情（detail）</summary>
            <pre class="mono" style="white-space: pre-wrap">{{ prettyDetail(row.detail) }}</pre>
          </details>

          <div v-if="row.resolution" class="alert alert--success small" style="margin-top: 6px">
            处理结果：{{ row.resolution }}（{{ formatDateTime(row.resolvedAt) }}）
          </div>

          <div v-if="row.status === 'open'" style="margin-top: 8px">
            <div class="toolbar">
              <label class="field" style="margin-bottom: 0; flex: 1; min-width: 260px">
                <span class="field__label">处理说明（必填）</span>
                <input
                  v-model="resolutionText[row.id]"
                  class="input"
                  type="text"
                  placeholder="例如：已联系学生改用另一教学班，并确认不再冲突"
                />
              </label>
              <label class="field" style="margin-bottom: 0">
                <span class="field__label">处理方式</span>
                <select v-model="resolutionStatus[row.id]" class="select">
                  <option value="resolved">已处理</option>
                  <option value="ignored">忽略</option>
                </select>
              </label>
              <button class="btn btn--primary" type="button" :disabled="resolving[row.id]" @click="resolveException(row)">
                {{ resolving[row.id] ? '提交中…' : '提交处理结果' }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <Pager
        :page="exceptionPage"
        :page-size="exceptionPageSize"
        :total="exceptionTotal"
        :disabled="loadingExceptions"
        @change="loadExceptions"
      />
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">审计日志（GET /api/admin/audit）</h3>
        <div class="inline">
          <input v-model="auditAction" class="input" type="text" placeholder="按 action 过滤，如 batch.transition" @keyup.enter="loadAudit(1)" />
          <button class="btn btn--ghost btn--sm" type="button" @click="loadAudit(1)">查询</button>
        </div>
      </div>
      <div v-if="!audit || audit.items.length === 0" class="empty">没有审计记录。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>操作人</th>
              <th>action</th>
              <th>对象</th>
              <th>摘要</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in audit.items" :key="row.id">
              <td>{{ row.id }}</td>
              <td>{{ row.actor_name ?? '—' }}</td>
              <td class="mono small">{{ row.action }}</td>
              <td class="small muted">{{ row.entity_type ?? '—' }}{{ row.entity_id ? ` #${row.entity_id}` : '' }}</td>
              <td class="small">{{ row.summary ?? '—' }}</td>
              <td class="small muted">{{ formatDateTime(row.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager :page="auditPage" :page-size="auditPageSize" :total="audit?.total ?? 0" :disabled="loadingAudit" @change="loadAudit" />
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">选课操作记录（GET /api/admin/operations）</h3>
      </div>
      <div v-if="!operations || operations.items.length === 0" class="empty">没有操作记录。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>学生</th>
              <th>操作</th>
              <th>结果</th>
              <th>错误码</th>
              <th>说明</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in operations.items" :key="row.id">
              <td>{{ row.id }}</td>
              <td>{{ row.studentName ?? '—' }}<div class="mono small muted">{{ row.studentNo ?? '' }}</div></td>
              <td>{{ opTypeLabel(row.opType) }}<div class="mono small muted">{{ row.opType }}</div></td>
              <td>
                <span class="badge" :class="row.status === 'succeeded' ? 'badge--ok' : 'badge--danger'">{{ row.status }}</span>
              </td>
              <td class="mono small">{{ row.errorCode ?? '—' }}</td>
              <td class="small muted">{{ row.message ?? '—' }}</td>
              <td class="small muted">{{ formatDateTime(row.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager
        :page="operationPage"
        :page-size="operationPageSize"
        :total="operations?.total ?? 0"
        :disabled="loadingOperations"
        @change="loadOperations"
      />
    </section>
  </div>
</template>
