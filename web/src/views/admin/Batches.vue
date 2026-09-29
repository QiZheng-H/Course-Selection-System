<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type { BatchDto, BatchStatus } from '@/api/types';
import { batchStatusLabel, formatDateTime, toDateTimeLocal, toIsoOrNull } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

const toast = useToast();

const batches = ref<BatchDto[]>([]);
const current = ref<BatchDto | null>(null);
const loading = ref(false);
const errorMessage = ref('');
const transitionError = ref<{ title: string; message: string; lines: string[] } | null>(null);

const createForm = reactive({
  term: '2026-2027-1',
  name: '',
  creditLimit: 30,
  openAt: '',
  closeAt: '',
  note: '',
});
const creating = ref(false);

const editingId = ref<number | null>(null);
const editForm = reactive({ name: '', creditLimit: 30, openAt: '', closeAt: '', note: '' });
const savingEdit = ref(false);

const transitionTarget = ref<BatchStatus>('open');
const transitionReason = ref('');
const force = ref(false);
const transitioning = ref(false);

const selectedBatchId = ref<number | null>(null);
const submissions = ref<{
  items: Array<{
    id: number;
    studentNo: string;
    name: string;
    versionNo: number;
    status: string;
    submittedAt: string;
    summary: string | null;
    courseCount: number;
  }>;
  total: number;
  page: number;
  pageSize: number;
  pending: Array<{ studentId: number; studentNo: string; name: string }>;
} | null>(null);
const submissionPage = ref(1);
const submissionPageSize = 20;
const loadingSubmissions = ref(false);

const statusOptions: BatchStatus[] = ['preparing', 'preview', 'open', 'frozen', 'published', 'waitlist', 'closed'];

async function load(): Promise<void> {
  loading.value = true;
  errorMessage.value = '';
  try {
    const data = await api.get<{ batches: BatchDto[]; current: BatchDto | null }>('/admin/batches');
    batches.value = data.batches;
    current.value = data.current;
  } catch (error) {
    errorMessage.value = apiErrorInfo(error).message;
  } finally {
    loading.value = false;
  }
}

async function createBatch(): Promise<void> {
  if (!createForm.term.trim() || !createForm.name.trim()) {
    toast.warning('请填写学期与批次名称');
    return;
  }
  creating.value = true;
  try {
    await api.post<BatchDto>('/admin/batches', {
      term: createForm.term.trim(),
      name: createForm.name.trim(),
      creditLimit: createForm.creditLimit,
      openAt: toIsoOrNull(createForm.openAt),
      closeAt: toIsoOrNull(createForm.closeAt),
      note: createForm.note || null,
    });
    toast.success('批次已创建', ['新批次初始状态为“资料准备”，不会立即开放提交。']);
    createForm.name = '';
    createForm.note = '';
    await load();
  } catch (error) {
    reportApiError(error, '创建批次失败');
  } finally {
    creating.value = false;
  }
}

function startEdit(batch: BatchDto): void {
  editingId.value = batch.id;
  editForm.name = batch.name;
  editForm.creditLimit = batch.creditLimit;
  editForm.openAt = toDateTimeLocal(batch.openAt);
  editForm.closeAt = toDateTimeLocal(batch.closeAt);
  editForm.note = batch.note ?? '';
}

async function saveEdit(): Promise<void> {
  if (editingId.value === null) return;
  savingEdit.value = true;
  try {
    await api.patch(`/admin/batches/${editingId.value}`, {
      name: editForm.name,
      creditLimit: editForm.creditLimit,
      openAt: toIsoOrNull(editForm.openAt),
      closeAt: toIsoOrNull(editForm.closeAt),
      note: editForm.note || null,
    });
    toast.success('批次配置已更新');
    editingId.value = null;
    await load();
  } catch (error) {
    reportApiError(error, '更新批次失败');
  } finally {
    savingEdit.value = false;
  }
}

async function transition(batch: BatchDto): Promise<void> {
  transitionError.value = null;
  const details = [
    `批次：${batch.name}（${batch.term}）`,
    `状态：${batchStatusLabel(batch.status)} → ${batchStatusLabel(transitionTarget.value)}`,
  ];
  if (force.value) {
    details.push('已勾选“强制执行”：系统会跳过部分保护性校验，可能产生不一致结果，风险由操作人承担。');
  }
  const ok = await askConfirm({
    title: '变更批次状态',
    message: force.value
      ? '强制流转会绕过“必需配置缺失 / 资料未确认”等保护性校验（发布环节的校验不能强制绕过）。'
      : '状态流转会立即影响学生端可用的操作，是否继续？',
    details,
    confirmText: force.value ? '强制执行' : '确认流转',
    danger: force.value,
  });
  if (!ok) return;
  transitioning.value = true;
  try {
    await api.post(`/admin/batches/${batch.id}/transition`, {
      status: transitionTarget.value,
      force: force.value,
      reason: transitionReason.value || undefined,
    });
    toast.success('状态已变更', [`${batch.name} → ${batchStatusLabel(transitionTarget.value)}`]);
    transitionReason.value = '';
    force.value = false;
    await load();
  } catch (error) {
    const info = apiErrorInfo(error, '状态流转失败');
    transitionError.value = { title: info.title, message: info.message, lines: info.lines };
    reportApiError(error, '状态流转失败');
  } finally {
    transitioning.value = false;
  }
}

async function loadSubmissions(batchId: number, page = 1): Promise<void> {
  loadingSubmissions.value = true;
  selectedBatchId.value = batchId;
  try {
    submissions.value = await api.get('/admin/batches/' + batchId + '/submissions', {
      page,
      pageSize: submissionPageSize,
    });
    submissionPage.value = page;
  } catch (error) {
    reportApiError(error, '读取提交情况失败');
  } finally {
    loadingSubmissions.value = false;
  }
}

/** 提交情况列表翻页 */
function changeSubmissionPage(page: number): void {
  if (selectedBatchId.value === null) return;
  void loadSubmissions(selectedBatchId.value, page);
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">批次控制</h1>
        <p class="page__desc">
          状态含义：资料准备（不开放提交）→ 预览开放 → 正式受理 → 截止冻结 → 结果已发布 → 候补与补选 → 结束。
        </p>
      </div>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
    </div>

    <p v-if="errorMessage" class="alert alert--error">{{ errorMessage }}</p>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">新建批次</h3>
      </div>
      <div class="grid grid--3">
        <label class="field">
          <span class="field__label">学期（如 2026-2027-1）</span>
          <input v-model="createForm.term" class="input" type="text" />
        </label>
        <label class="field">
          <span class="field__label">批次名称</span>
          <input v-model="createForm.name" class="input" type="text" placeholder="例如 2026-2027 学年第一学期选课" />
        </label>
        <label class="field">
          <span class="field__label">学分上限</span>
          <input v-model.number="createForm.creditLimit" class="input" type="number" min="1" step="1" />
        </label>
        <label class="field">
          <span class="field__label">开放时间</span>
          <input v-model="createForm.openAt" class="input" type="datetime-local" />
        </label>
        <label class="field">
          <span class="field__label">截止时间</span>
          <input v-model="createForm.closeAt" class="input" type="datetime-local" />
        </label>
        <label class="field">
          <span class="field__label">备注</span>
          <input v-model="createForm.note" class="input" type="text" />
        </label>
      </div>
      <button class="btn btn--primary" type="button" :disabled="creating" @click="createBatch">
        {{ creating ? '创建中…' : '创建批次' }}
      </button>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">批次列表</h3>
        <span v-if="current" class="muted small">当前批次：{{ current.name }}（{{ batchStatusLabel(current.status) }}）</span>
      </div>
      <div v-if="batches.length === 0" class="empty">还没有任何批次。</div>
      <div v-else class="list">
        <div v-for="batch in batches" :key="batch.id" class="list__item">
          <div class="inline">
            <strong>{{ batch.name }}</strong>
            <span class="badge badge--muted">{{ batch.term }}</span>
            <span class="badge" :class="batch.status === 'closed' ? 'badge--muted' : 'badge--ok'">
              {{ batchStatusLabel(batch.status) }}
            </span>
            <span class="badge" :class="batch.configReady ? 'badge--ok' : 'badge--warn'">
              配置{{ batch.configReady ? '就绪' : '缺失' }}
            </span>
            <span class="spacer"></span>
            <button class="btn btn--sm btn--ghost" type="button" @click="startEdit(batch)">改配置</button>
            <button class="btn btn--sm btn--ghost" type="button" @click="loadSubmissions(batch.id, 1)">查看提交情况</button>
          </div>
          <div class="small muted">
            开放 {{ formatDateTime(batch.openAt) }} · 截止 {{ formatDateTime(batch.closeAt) }} · 发布
            {{ formatDateTime(batch.publishedAt) }}<br />
            提交：有效 {{ batch.submissions.submitted }} / 撤回 {{ batch.submissions.withdrawn }} / 涉及学生
            {{ batch.submissions.students }}
            <template v-if="batch.snapshotHash"><br />冻结快照：<span class="mono">{{ batch.snapshotHash.slice(0, 16) }}…</span></template>
          </div>
          <p v-if="!batch.configReady" class="alert alert--warning small" style="margin-top: 6px">
            {{ batch.configIssues.join('；') }}
          </p>

          <div v-if="editingId === batch.id" class="card card--flat" style="margin-top: 10px">
            <h4>修改批次配置</h4>
            <div class="grid grid--3">
              <label class="field">
                <span class="field__label">名称</span>
                <input v-model="editForm.name" class="input" type="text" />
              </label>
              <label class="field">
                <span class="field__label">学分上限</span>
                <input v-model.number="editForm.creditLimit" class="input" type="number" min="1" step="1" />
              </label>
              <label class="field">
                <span class="field__label">开放时间</span>
                <input v-model="editForm.openAt" class="input" type="datetime-local" />
              </label>
              <label class="field">
                <span class="field__label">截止时间</span>
                <input v-model="editForm.closeAt" class="input" type="datetime-local" />
              </label>
              <label class="field">
                <span class="field__label">备注</span>
                <input v-model="editForm.note" class="input" type="text" />
              </label>
            </div>
            <div class="inline">
              <button class="btn btn--primary btn--sm" type="button" :disabled="savingEdit" @click="saveEdit">
                {{ savingEdit ? '保存中…' : '保存' }}
              </button>
              <button class="btn btn--ghost btn--sm" type="button" @click="editingId = null">取消</button>
            </div>
          </div>

          <div class="card card--flat" style="margin-top: 10px">
            <h4>状态流转</h4>
            <div class="toolbar">
              <label class="field" style="margin-bottom: 0">
                <span class="field__label">目标状态</span>
                <select v-model="transitionTarget" class="select">
                  <option v-for="status in statusOptions" :key="status" :value="status">{{ batchStatusLabel(status) }}</option>
                </select>
              </label>
              <label class="field" style="margin-bottom: 0">
                <span class="field__label">原因（可选，会写入审计日志）</span>
                <input v-model="transitionReason" class="input" type="text" />
              </label>
              <label class="checkbox">
                <input v-model="force" type="checkbox" />
                强制执行（跳过保护性校验）
              </label>
              <button class="btn btn--sm" :class="force ? 'btn--danger' : 'btn--primary'" type="button" :disabled="transitioning" @click="transition(batch)">
                {{ transitioning ? '执行中…' : '变更状态' }}
              </button>
            </div>
            <p v-if="force" class="alert alert--error small" style="margin-top: 8px">
              风险提示：强制执行只绕过“必需配置缺失 / 已提交志愿但资料未确认”等前置校验。发布环节不能强制绕过：必须先试算、处理关键保障异常，再在“预分配与统一分配”页发布指定的试算结果。
            </p>
            <p class="tips" style="margin-top: 6px">
              常见失败原因：必需配置缺失（BATCH_CONFIG_MISSING，需先在“资料核对/配置”补齐学分上限与教学班数据）；资料待确认（MATERIAL_NOT_CONFIRMED，需学生先确认修读记录）；状态不允许（BATCH_STATE_INVALID，需按合法顺序流转；发布需先有成功发布的分配结果）。提交与撤回还会按服务器时间校验管理员配置的开放/截止时刻，未到点或已过点都会被拒绝（SUBMISSION_CLOSED）。
            </p>
          </div>
        </div>
      </div>
    </section>

    <p v-if="transitionError" class="alert alert--error">
      <strong>{{ transitionError.title }}</strong>：{{ transitionError.message }}
      <span v-for="(line, index) in transitionError.lines" :key="index" class="alert__line">{{ line }}</span>
    </p>

    <section v-if="submissions" class="card">
      <div class="card__header">
        <h3 class="card__title">提交情况（批次 #{{ selectedBatchId }}）</h3>
        <button class="btn btn--ghost btn--sm" type="button" @click="submissions = null">关闭</button>
      </div>
      <div v-if="submissions.pending.length > 0" class="alert alert--warning">
        <strong>已提交志愿但尚未确认资料的学生：{{ submissions.pending.length }} 人</strong>
        <ul>
          <li v-for="student in submissions.pending.slice(0, 20)" :key="student.studentId">
            {{ student.name }}（{{ student.studentNo }}）
          </li>
        </ul>
        <span class="small">冻结批次前需要先处理这些确认，否则会返回 MATERIAL_NOT_CONFIRMED。</span>
      </div>
      <div v-if="submissions.items.length === 0" class="muted">还没有提交记录。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>学号</th>
              <th>姓名</th>
              <th>版本</th>
              <th>状态</th>
              <th>课程数</th>
              <th>摘要</th>
              <th>提交时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in submissions.items" :key="row.id">
              <td class="mono">{{ row.studentNo }}</td>
              <td>{{ row.name }}</td>
              <td>v{{ row.versionNo }}</td>
              <td>
                <span class="badge" :class="row.status === 'submitted' ? 'badge--ok' : 'badge--muted'">
                  {{ row.status === 'submitted' ? '有效' : '已撤回' }}
                </span>
              </td>
              <td>{{ row.courseCount }}</td>
              <td class="small muted">{{ row.summary ?? '—' }}</td>
              <td class="small muted">{{ formatDateTime(row.submittedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager
        :page="submissionPage"
        :page-size="submissionPageSize"
        :total="submissions.total"
        :disabled="loadingSubmissions"
        @change="changeSubmissionPage"
      />
    </section>
  </div>
</template>
