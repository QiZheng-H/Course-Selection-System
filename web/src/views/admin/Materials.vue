<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type { DataVersionRow, ImportBatchRow, ImportPreview } from '@/api/types';
import { formatDateTime, importKindLabel } from '@/utils/labels';

const toast = useToast();

const kindOptions = [
  { value: 'courses', label: '课程（courses）' },
  { value: 'classes', label: '教学班（classes）' },
  { value: 'program', label: '培养方案（program）' },
  { value: 'records', label: '修读记录（records）' },
  { value: 'preallocation', label: '预分配（preallocation）' },
];

const uploadForm = reactive({ kind: 'courses', programCode: 'CS-2024', term: '2026-2027-1' });
const selectedFile = ref<File | null>(null);
const uploading = ref(false);
const preview = ref<ImportPreview | null>(null);
const publishing = ref(false);

const history = ref<ImportBatchRow[]>([]);
const versions = ref<DataVersionRow[]>([]);
const scopeFilter = ref('');
const loading = ref(false);

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement | null;
  selectedFile.value = input?.files?.[0] ?? null;
}

async function upload(): Promise<void> {
  if (!selectedFile.value) {
    toast.warning('请先选择要导入的文件');
    return;
  }
  const formData = new FormData();
  formData.append('file', selectedFile.value);
  formData.append('kind', uploadForm.kind);
  uploading.value = true;
  try {
    preview.value = await api.upload<ImportPreview>('/admin/imports', formData);
    toast.success('导入完成，已生成校验报告', [
      `共 ${preview.value.rowCount} 行，错误 ${preview.value.issues.filter((issue) => issue.level === 'error').length} 个`,
      preview.value.valid ? '校验通过，可以发布' : '存在错误，需要修正后重新导入',
    ]);
    await loadHistory();
  } catch (error) {
    reportApiError(error, '导入失败');
  } finally {
    uploading.value = false;
  }
}

async function publish(batchId: number, kind: string): Promise<void> {
  const ok = await askConfirm({
    title: '发布该导入批次',
    message: '发布会把校验通过的数据写入正式表，并生成新的资料版本；关键资料（培养方案/修读记录）更新后，相关确认与授权会失效并进入异常清单。',
    details:
      kind === 'program'
        ? ['培养方案发布需要指定 programCode', `当前 programCode：${uploadForm.programCode}`]
        : [`学期：${uploadForm.term}`],
    confirmText: '确认发布',
  });
  if (!ok) return;
  publishing.value = true;
  try {
    const result = await api.post<{ versionNo: number; contentHash: string; applied: number }>(
      `/admin/imports/${batchId}/publish`,
      {
        programCode: kind === 'program' ? uploadForm.programCode : undefined,
        term: uploadForm.term || undefined,
      },
    );
    toast.success(`已发布资料 v${result.versionNo}`, [`生效 ${result.applied} 行`, `内容哈希 ${result.contentHash.slice(0, 16)}…`]);
    await Promise.all([loadHistory(), loadVersions()]);
  } catch (error) {
    reportApiError(error, '发布失败');
  } finally {
    publishing.value = false;
  }
}

async function loadHistory(): Promise<void> {
  try {
    const data = await api.get<{ batches: ImportBatchRow[] }>('/admin/imports');
    history.value = data.batches;
  } catch (error) {
    reportApiError(error, '读取导入历史失败');
  }
}

async function loadVersions(): Promise<void> {
  try {
    const data = await api.get<{ versions: DataVersionRow[] }>('/admin/versions', {
      scope: scopeFilter.value || undefined,
    });
    versions.value = data.versions;
  } catch (error) {
    reportApiError(error, '读取版本列表失败');
  }
}

function parsedIssues(row: ImportBatchRow): Array<{ row: number; level: string; message: string }> {
  if (!row.report) return [];
  try {
    const parsed = JSON.parse(row.report) as { issues?: Array<{ row: number; level: string; message: string }> };
    return parsed.issues ?? [];
  } catch {
    return [];
  }
}

onMounted(async () => {
  loading.value = true;
  await Promise.all([loadHistory(), loadVersions()]);
  loading.value = false;
});
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">资料核对与发布</h1>
        <p class="page__desc">
          导入只生成“批次 + 校验报告”，不会直接改正式数据；管理员核对通过后发布，发布会产生资料版本与内容哈希。
        </p>
      </div>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="loadHistory(); loadVersions()">刷新</button>
    </div>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">上传导入（multipart：file + kind）</h3>
      </div>
      <div class="grid grid--3">
        <label class="field">
          <span class="field__label">资料类型 kind</span>
          <select v-model="uploadForm.kind" class="select">
            <option v-for="item in kindOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">培养方案代码（kind=program 时使用）</span>
          <input v-model="uploadForm.programCode" class="input" type="text" />
        </label>
        <label class="field">
          <span class="field__label">学期（kind=classes 缺省学期时使用）</span>
          <input v-model="uploadForm.term" class="input" type="text" />
        </label>
      </div>
      <label class="field">
        <span class="field__label">选择文件（支持 xlsx / csv / txt / md / json / docx / pdf 文字型）</span>
        <input class="input" type="file" accept=".xlsx,.xls,.csv,.txt,.md,.json,.docx,.pdf" @change="onFileChange" />
      </label>
      <div class="inline">
        <button class="btn btn--primary" type="button" :disabled="uploading || !selectedFile" @click="upload">
          {{ uploading ? '上传解析中…' : '上传并生成校验报告' }}
        </button>
        <span v-if="selectedFile" class="muted small">已选择：{{ selectedFile.name }}</span>
      </div>
      <p class="tips" style="margin-top: 8px">
        表头字段示例：课程 courses（课程号/课程名/学分/院系/课程类型）；教学班 classes（教学班号/课程号/容量/教师/星期/开始节次/结束节次/起始周/结束周/单双周）；
        修读记录 records（学号/课程号/状态/学期/学分）；预分配 preallocation（学号/教学班号/余量）；培养方案 program（需求代码/需求名称/要求学分/课程号）。
      </p>
    </section>

    <section v-if="preview" class="card">
      <div class="card__header">
        <h3 class="card__title">校验报告（批次 #{{ preview.batchId }} · {{ importKindLabel(preview.kind) }}）</h3>
        <span class="badge" :class="preview.valid ? 'badge--ok' : 'badge--danger'">
          {{ preview.valid ? '校验通过，可发布' : '存在错误，不能发布' }}
        </span>
      </div>
      <div class="inline">
        <span class="badge">文件：{{ preview.fileName }}</span>
        <span class="badge">解析来源：{{ preview.source }}</span>
        <span class="badge">行数：{{ preview.rowCount }}</span>
        <span class="badge">错误：{{ preview.issues.filter((issue) => issue.level === 'error').length }}</span>
        <span class="badge">警告：{{ preview.issues.filter((issue) => issue.level === 'warning').length }}</span>
        <span class="spacer"></span>
        <button class="btn btn--primary btn--sm" type="button" :disabled="publishing || !preview.valid" @click="publish(preview.batchId, preview.kind)">
          {{ publishing ? '发布中…' : '发布该批次' }}
        </button>
      </div>

      <div v-if="preview.issues.length > 0" class="stack" style="margin-top: 10px">
        <div class="alert alert--error">
          <strong>错误</strong>
          <ul>
            <li v-for="(issue, index) in preview.issues.filter((item) => item.level === 'error')" :key="index">
              第 {{ issue.row }} 行：{{ issue.message }}
            </li>
          </ul>
        </div>
        <div class="alert alert--warning">
          <strong>警告</strong>
          <ul>
            <li v-for="(issue, index) in preview.issues.filter((item) => item.level === 'warning')" :key="index">
              第 {{ issue.row }} 行：{{ issue.message }}
            </li>
          </ul>
        </div>
      </div>

      <div v-if="preview.rows.length > 0" class="table-wrap" style="margin-top: 10px">
        <table class="table table--compact">
          <thead>
            <tr>
              <th v-for="header in preview.headers" :key="header">{{ header }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in preview.rows.slice(0, 20)" :key="index">
              <td v-for="header in preview.headers" :key="header">{{ row[header] ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="tips">最多预览前 20 行；完整数据保存在导入批次中，发布时全量生效。</p>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">批次历史（GET /api/admin/imports）</h3>
      </div>
      <div v-if="history.length === 0" class="empty">还没有导入记录。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>类型</th>
              <th>文件</th>
              <th>状态</th>
              <th>行数 / 错误</th>
              <th>创建</th>
              <th>发布</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in history" :key="row.id">
              <td>{{ row.id }}</td>
              <td>{{ importKindLabel(row.kind) }}</td>
              <td>
                {{ row.fileName }}
                <div class="mono small muted">{{ row.fileHash.slice(0, 12) }}…</div>
              </td>
              <td>
                <span class="badge" :class="row.status === 'published' ? 'badge--ok' : row.errorCount > 0 ? 'badge--danger' : 'badge--warn'">
                  {{ row.status === 'published' ? '已发布' : row.errorCount > 0 ? '待修正' : '已校验' }}
                </span>
                <div v-if="parsedIssues(row).length > 0" class="small muted">
                  问题 {{ parsedIssues(row).length }} 个
                </div>
              </td>
              <td>{{ row.rowCount }} / {{ row.errorCount }}</td>
              <td class="small muted">{{ formatDateTime(row.createdAt) }}<br />{{ row.createdBy ?? '—' }}</td>
              <td class="small muted">{{ formatDateTime(row.publishedAt) }}</td>
              <td>
                <button
                  class="btn btn--sm btn--primary"
                  type="button"
                  :disabled="publishing || row.status === 'published' || row.errorCount > 0"
                  @click="publish(row.id, row.kind)"
                >
                  发布
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">资料版本（GET /api/admin/versions）</h3>
        <div class="inline">
          <select v-model="scopeFilter" class="select" @change="loadVersions">
            <option value="">全部 scope</option>
            <option value="courses">courses</option>
            <option value="classes">classes</option>
            <option value="program">program</option>
            <option value="records">records</option>
            <option value="preallocation">preallocation</option>
          </select>
        </div>
      </div>
      <div v-if="versions.length === 0" class="empty">还没有发布过任何资料版本。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>版本</th>
              <th>Scope</th>
              <th>内容哈希</th>
              <th>摘要</th>
              <th>发布人</th>
              <th>发布时间</th>
              <th>是否生效</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in versions" :key="row.id">
              <td>v{{ row.versionNo }}</td>
              <td>{{ importKindLabel(row.scope) }}</td>
              <td class="mono small">{{ row.contentHash.slice(0, 16) }}…</td>
              <td class="small">{{ row.summary }}</td>
              <td class="small muted">{{ row.publishedBy ?? '—' }}</td>
              <td class="small muted">{{ formatDateTime(row.publishedAt) }}</td>
              <td>
                <span class="badge" :class="row.active ? 'badge--ok' : 'badge--muted'">{{ row.active ? '生效中' : '历史' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
