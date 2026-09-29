<script setup lang="ts">
/**
 * 资料导入与发布（面向业务管理员的四步向导）。
 *
 * ① 选择资料类型 → ② 下载模板 / 上传文件 → ③ 查看校验结果 → ④ 确认发布。
 *
 * 主操作区只出现业务名称与业务说法，不出现接口地址、请求字段等技术细节；
 * 原文件、解析来源、版本号与历史记录统一放在页面下方的“详细信息”里。
 * 校验未通过时保留预览与问题列表，方便管理员改完原文件后重新上传。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import { useActivity, loadActivities } from '@/stores/activity';
import type { DataVersionRow, ImportBatchRow, ImportIssue, ImportPreview } from '@/api/types';
import { formatDateTime, importKindLabel } from '@/utils/labels';

/** 后端支持的资料类型：为避免改动公共类型文件，只在本页声明 */
type ImportKind = 'courses' | 'classes' | 'program' | 'records' | 'preallocation';
type Step = 1 | 2 | 3 | 4;

interface MaterialType {
  value: ImportKind;
  label: string;
  purpose: string;
  /** 模板表头：与后端解析器识别的常见中文写法保持一致 */
  templateHeaders: string[];
}

interface BatchReport {
  headers?: string[];
  issues?: ImportIssue[];
  source?: string;
}

const MATERIAL_TYPES: MaterialType[] = [
  {
    value: 'courses',
    label: '课程',
    purpose: '这份资料用来建立全校课程库：课程号、学分与开课院系，是教学班和培养方案的基础。',
    templateHeaders: ['课程号', '课程名', '学分', '院系', '课程类型'],
  },
  {
    value: 'classes',
    label: '教学班',
    purpose: '这份资料用来登记本学期实际开课的教学班、容量与上课时间，学生只能选到这里的班。',
    templateHeaders: ['教学班号', '课程号', '容量', '教师', '星期', '开始节次', '结束节次', '起始周', '结束周', '单双周'],
  },
  {
    value: 'program',
    label: '培养方案',
    purpose: '这份资料用来登记各专业毕业需要的课程与学分要求，系统据此判断学生该修哪些课。',
    templateHeaders: ['需求代码', '需求名称', '要求学分', '课程号'],
  },
  {
    value: 'records',
    label: '修读记录',
    purpose: '这份资料用来登记学生已修、在修课程与成绩状态，用于学分核算和毕业资格判断。',
    templateHeaders: ['学号', '课程号', '状态', '学期', '学分'],
  },
  {
    value: 'preallocation',
    label: '专业课预分配名单',
    purpose: '这份资料用来提前为学生锁定专业课名额，正式选课开始前先占好位置。',
    templateHeaders: ['学号', '教学班号', '余量'],
  },
];

/** 业务名称：对外一律使用中文称谓，不暴露内部取值 */
const KIND_LABEL: Record<string, string> = {
  courses: '课程',
  classes: '教学班',
  program: '培养方案',
  records: '修读记录',
  preallocation: '专业课预分配名单',
};

/** 解析来源的中文说法，用于“详细信息” */
const SOURCE_LABEL: Record<string, string> = {
  xlsx: 'Excel 表格',
  csv: 'CSV / 文字表格',
  json: '结构化数据表格',
  'docx-text': 'Word 文档中的文字表格',
  'pdf-text': 'PDF 中的文字表格',
};

function kindName(value: string): string {
  return KIND_LABEL[value] ?? importKindLabel(value);
}

function sourceName(value: string | null | undefined): string {
  if (!value) return '—';
  return SOURCE_LABEL[value] ?? value;
}

const toast = useToast();
const activity = useActivity();
const currentActivity = computed(() => activity.selected.value);

const step = ref<Step>(1);
const kind = ref<ImportKind>('courses');
const programCode = ref('CS-2024');
const term = ref('');
const selectedFile = ref<File | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const publishing = ref(false);
const preview = ref<ImportPreview | null>(null);
const wizardPublished = ref<number | null>(null);

const history = ref<ImportBatchRow[]>([]);
const versions = ref<DataVersionRow[]>([]);
const historyLoading = ref(false);
const versionsLoading = ref(false);
const historyError = ref('');
const versionsError = ref('');
const showDetails = ref(false);

const currentType = computed<MaterialType>(
  () => MATERIAL_TYPES.find((item) => item.value === kind.value) ?? MATERIAL_TYPES[0],
);

const errorIssues = computed<ImportIssue[]>(() => (preview.value?.issues ?? []).filter((issue) => issue.level === 'error'));
const warningIssues = computed<ImportIssue[]>(() =>
  (preview.value?.issues ?? []).filter((issue) => issue.level === 'warning'),
);

function goStep(next: Step): void {
  step.value = next;
}

/** 选择资料类型后进入第 2 步；换类型时清掉上一类的文件与校验结果 */
function chooseKind(value: ImportKind): void {
  if (kind.value !== value) {
    kind.value = value;
    preview.value = null;
    selectedFile.value = null;
    wizardPublished.value = null;
    if (fileInput.value) fileInput.value.value = '';
  }
  goStep(2);
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement | null;
  selectedFile.value = input?.files?.[0] ?? null;
}

/** 纯前端生成 CSV 模板并下载，不让管理员去猜表头 */
function downloadTemplate(): void {
  const headers = currentType.value.templateHeaders;
  const csv = `\uFEFF${headers.join(',')}\n`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${currentType.value.label}模板.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast.info(`已下载《${currentType.value.label}模板.csv》`, ['按模板表头填写，一行填写一份资料。']);
}

async function upload(): Promise<void> {
  if (!selectedFile.value) {
    toast.warning('请先选择要上传的文件');
    return;
  }
  const formData = new FormData();
  formData.append('file', selectedFile.value);
  formData.append('kind', kind.value);
  uploading.value = true;
  try {
    const result = await api.upload<ImportPreview>('/admin/imports', formData);
    preview.value = result;
    wizardPublished.value = null;
    goStep(3);
    const errors = result.issues.filter((issue) => issue.level === 'error').length;
    if (result.valid) {
      toast.success('校验通过，可以发布', [`共读取 ${result.rowCount} 行资料`]);
    } else {
      toast.warning('校验未通过，需要修改原文件', [`必须修改 ${errors} 处，改完重新上传即可`]);
    }
    await loadHistory();
  } catch (error) {
    // 失败时保留上一次的预览与问题列表，方便对照修正
    reportApiError(error, '上传失败');
  } finally {
    uploading.value = false;
  }
}

/** 回到第 2 步重新选文件：保留校验结果，但必须重新选择修改后的文件 */
function restartUpload(): void {
  selectedFile.value = null;
  if (fileInput.value) fileInput.value.value = '';
  goStep(2);
}

function publishBody(kindValue: string): { programCode?: string; term?: string } {
  if (kindValue === 'program') return { programCode: programCode.value.trim() || undefined };
  if (kindValue === 'classes') return { term: term.value.trim() || currentActivity.value?.term || undefined };
  return {};
}

function summaryLines(kindValue: string, rowCount: number, errors: number, warnings: number): string[] {
  const lines = [`本次新增或更新 ${rowCount} 行资料`, `必须修改的问题 ${errors} 个，建议核对的问题 ${warnings} 个`];
  if (kindValue === 'program') lines.push(`培养方案代码：${programCode.value.trim() || '未填写（按系统默认方案发布）'}`);
  if (kindValue === 'classes') lines.push(`开课学期：${term.value.trim() || currentActivity.value?.term || '未填写（沿用现有学期）'}`);
  if (kindValue === 'records' || kindValue === 'program') {
    lines.push('发布后相关学生的确认需要重新确认，系统会把这些学生放入异常清单。');
  }
  return lines;
}

async function publishPreview(): Promise<void> {
  const current = preview.value;
  if (!current || !current.valid) return;
  const ok = await askConfirm({
    title: '确认发布这批资料',
    message: `发布后「${kindName(current.kind)}」资料的 ${current.rowCount} 行会写入正式数据，并生成一个新的资料版本。`,
    details: summaryLines(current.kind, current.rowCount, errorIssues.value.length, warningIssues.value.length),
    confirmText: '确认发布',
  });
  if (!ok) return;
  publishing.value = true;
  try {
    const result = await api.post<{ versionNo: number; applied: number }>(
      `/admin/imports/${current.batchId}/publish`,
      publishBody(current.kind),
    );
    wizardPublished.value = result.versionNo;
    toast.success(`已发布资料 v${result.versionNo}`, [`本次生效 ${result.applied} 行`]);
    await refreshAll();
  } catch (error) {
    reportApiError(error, '发布失败');
  } finally {
    publishing.value = false;
  }
}

async function publishHistory(row: ImportBatchRow): Promise<void> {
  if (row.status === 'published' || row.errorCount > 0) return;
  const warnings = reportIssues(row).filter((issue) => issue.level === 'warning').length;
  const ok = await askConfirm({
    title: `确认发布「${kindName(row.kind)}」资料`,
    message: `发布后 ${row.fileName} 的 ${row.rowCount} 行会写入正式数据，并生成一个新的资料版本。`,
    details: summaryLines(row.kind, row.rowCount, row.errorCount, warnings),
    confirmText: '确认发布',
  });
  if (!ok) return;
  publishing.value = true;
  try {
    const result = await api.post<{ versionNo: number; applied: number }>(
      `/admin/imports/${row.id}/publish`,
      publishBody(row.kind),
    );
    toast.success(`已发布资料 v${result.versionNo}`, [`本次生效 ${result.applied} 行`]);
    await refreshAll();
  } catch (error) {
    reportApiError(error, '发布失败');
  } finally {
    publishing.value = false;
  }
}

function resetWizard(): void {
  preview.value = null;
  selectedFile.value = null;
  wizardPublished.value = null;
  if (fileInput.value) fileInput.value.value = '';
  goStep(1);
}

function parsedReport(row: ImportBatchRow): BatchReport {
  if (!row.report) return {};
  try {
    return JSON.parse(row.report) as BatchReport;
  } catch {
    return {};
  }
}

function reportIssues(row: ImportBatchRow): ImportIssue[] {
  return parsedReport(row).issues ?? [];
}

function reportSource(row: ImportBatchRow): string {
  return parsedReport(row).source ?? '';
}

/** 版本列表里资料类型的中文名称（不让内部取值出现在页面上） */
function versionKindName(row: DataVersionRow): string {
  return kindName(row.scope);
}

function batchStatusText(row: ImportBatchRow): string {
  if (row.status === 'published') return '已发布';
  if (row.errorCount > 0) return '待修正';
  return '已校验，待发布';
}

function batchStatusClass(row: ImportBatchRow): string {
  if (row.status === 'published') return 'badge badge--ok';
  if (row.errorCount > 0) return 'badge badge--danger';
  return 'badge badge--warn';
}

async function loadHistory(): Promise<void> {
  historyLoading.value = true;
  historyError.value = '';
  try {
    const data = await api.get<{ batches: ImportBatchRow[] }>('/admin/imports');
    history.value = data.batches;
  } catch (error) {
    historyError.value = apiErrorInfo(error, '读取导入历史失败').message;
  } finally {
    historyLoading.value = false;
  }
}

async function loadVersions(): Promise<void> {
  versionsLoading.value = true;
  versionsError.value = '';
  try {
    const data = await api.get<{ versions: DataVersionRow[] }>('/admin/versions');
    versions.value = data.versions;
  } catch (error) {
    versionsError.value = apiErrorInfo(error, '读取资料版本失败').message;
  } finally {
    versionsLoading.value = false;
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadHistory(), loadVersions()]);
}

onMounted(async () => {
  await loadActivities();
  term.value = currentActivity.value?.term ?? '';
  await refreshAll();
});

// 切换选课活动后，教学班的默认学期跟着新活动走
watch(
  () => activity.selectedId.value,
  (next, previous) => {
    if (next === previous) return;
    term.value = currentActivity.value?.term ?? '';
  },
);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">资料导入与发布</h1>
        <p class="page__desc">
          按四个步骤把课程、教学班、培养方案等资料安全地导入系统：先按模板准备文件，上传后逐行校验，确认无误再发布。
          上传只生成校验结果，不会直接改动正式资料；发布才会生成新的资料版本。
        </p>
      </div>
      <div class="inline">
        <span v-if="currentActivity" class="badge badge--muted">{{ currentActivity.term }}</span>
        <button
          class="btn btn--ghost btn--sm"
          type="button"
          :disabled="historyLoading || versionsLoading"
          @click="refreshAll"
        >
          刷新
        </button>
      </div>
    </div>

    <div class="wizard-steps">
      <div class="wizard-step" :class="{ 'wizard-step--active': step === 1, 'wizard-step--done': step > 1 }">
        <span class="wizard-step__index">1</span>选择资料类型
      </div>
      <div class="wizard-step" :class="{ 'wizard-step--active': step === 2, 'wizard-step--done': step > 2 }">
        <span class="wizard-step__index">2</span>下载模板 / 上传文件
      </div>
      <div class="wizard-step" :class="{ 'wizard-step--active': step === 3, 'wizard-step--done': step > 3 }">
        <span class="wizard-step__index">3</span>查看校验结果
      </div>
      <div class="wizard-step" :class="{ 'wizard-step--active': step === 4 }">
        <span class="wizard-step__index">4</span>确认发布
      </div>
    </div>

    <!-- 第 1 步：选择资料类型 -->
    <section v-if="step === 1" class="card">
      <div class="card__header">
        <h3 class="card__title">第 1 步：这次要导入哪一类资料？</h3>
        <span class="muted small">点一下卡片即可进入下一步</span>
      </div>
      <div class="grid grid--2">
        <label
          v-for="item in MATERIAL_TYPES"
          :key="item.value"
          class="card card--flat"
          :class="{ 'wizard-step--active': kind === item.value }"
          style="cursor: pointer"
          @click="chooseKind(item.value)"
        >
          <span class="inline">
            <input
              type="radio"
              name="material-kind"
              :value="item.value"
              :checked="kind === item.value"
              @change="chooseKind(item.value)"
            />
            <strong>{{ item.label }}</strong>
          </span>
          <span class="small muted" style="display: block; margin-top: 6px">{{ item.purpose }}</span>
        </label>
      </div>
      <p class="tips">不确定选哪一个时：第一次使用请先导入“课程”，再导入“教学班”。</p>
    </section>

    <!-- 第 2 步：下载模板 / 上传文件 -->
    <section v-else-if="step === 2" class="card">
      <div class="card__header">
        <h3 class="card__title">第 2 步：下载「{{ currentType.label }}」模板并上传文件</h3>
        <span class="badge badge--muted">{{ currentType.label }}</span>
      </div>
      <p class="small muted">{{ currentType.purpose }}</p>

      <div class="inline" style="margin-top: 6px">
        <button class="btn btn--ghost" type="button" @click="downloadTemplate">下载模板（CSV）</button>
        <span class="small muted">模板已经写好表头，按列填写即可；一行填写一份资料。</span>
      </div>

      <div v-if="kind === 'program' || kind === 'classes'" class="grid grid--2" style="margin-top: 10px">
        <label v-if="kind === 'program'" class="field">
          <span class="field__label">培养方案代码</span>
          <input v-model="programCode" class="input" type="text" placeholder="例如 CS-2024" />
          <span class="small muted">说明这批培养要求属于哪个专业的方案。</span>
        </label>
        <label v-if="kind === 'classes'" class="field">
          <span class="field__label">开课学期</span>
          <input v-model="term" class="input" type="text" placeholder="例如 2026-2027-1" />
          <span class="small muted">
            文件里没有写学期时，按这里填写的学期开课。
            <template v-if="currentActivity">当前活动学期：{{ currentActivity.term }}</template>
          </span>
        </label>
      </div>

      <label class="field" style="margin-top: 10px">
        <span class="field__label">选择文件</span>
        <input
          ref="fileInput"
          class="input"
          type="file"
          accept=".xlsx,.xls,.csv,.txt,.md,.json,.docx,.pdf"
          @change="onFileChange"
        />
        <span v-if="selectedFile" class="small muted">已选择：{{ selectedFile.name }}</span>
        <span v-else class="small muted">支持 Excel、CSV、Word、PDF（文字型）等表格文件。</span>
      </label>

      <div class="inline" style="margin-top: 12px">
        <button class="btn btn--primary" type="button" :disabled="uploading || !selectedFile" @click="upload">
          {{ uploading ? '正在校验…' : '上传并查看校验结果' }}
        </button>
        <button class="btn btn--ghost" type="button" @click="goStep(1)">上一步：换资料类型</button>
        <span v-if="preview" class="small muted">上一次的校验结果仍然保留，重新上传会生成新的结果。</span>
      </div>
      <p class="tips">上传只是把文件读进来逐行检查，不会改动系统里的正式资料。</p>
    </section>

    <!-- 第 3 步：查看校验结果 -->
    <section v-else-if="step === 3 && preview" class="card">
      <div class="card__header">
        <h3 class="card__title">第 3 步：「{{ kindName(preview.kind) }}」资料的校验结果</h3>
        <span class="badge" :class="preview.valid ? 'badge--ok' : 'badge--danger'">
          {{ preview.valid ? '校验通过' : '校验未通过' }}
        </span>
      </div>

      <div class="grid grid--3">
        <div class="stat">
          <div class="stat__label">文件里读到的资料行数</div>
          <div class="stat__value">{{ preview.rowCount }}</div>
          <div class="stat__extra">原文件：{{ preview.fileName }}</div>
        </div>
        <div class="stat">
          <div class="stat__label">必须修改的问题</div>
          <div class="stat__value">{{ errorIssues.length }}</div>
          <div class="stat__extra">存在时必须改完才能发布</div>
        </div>
        <div class="stat">
          <div class="stat__label">建议核对的问题</div>
          <div class="stat__value">{{ warningIssues.length }}</div>
          <div class="stat__extra">不影响发布，建议顺手确认</div>
        </div>
      </div>

      <div v-if="errorIssues.length > 0" class="stack" style="margin-top: 10px">
        <p class="tips">按下面的提示修改原文件后重新上传即可。预览和问题列表会一直保留，方便边改边对照。</p>
        <div class="alert alert--error">
          <strong>必须修改的问题</strong>
          <ul>
            <li v-for="(issue, index) in errorIssues" :key="`error-${index}`">
              第 {{ issue.row }} 行：{{ issue.message }}
            </li>
          </ul>
        </div>
      </div>
      <div v-else class="alert" style="margin-top: 10px">
        <strong>资料内容没有问题</strong>
        <div class="small">可以进入下一步确认发布，发布后学生端会看到这一版资料。</div>
      </div>

      <div v-if="warningIssues.length > 0" class="alert alert--warning" style="margin-top: 10px">
        <strong>建议核对的问题（不影响发布）</strong>
        <ul>
          <li v-for="(issue, index) in warningIssues" :key="`warning-${index}`">
            第 {{ issue.row }} 行：{{ issue.message }}
          </li>
        </ul>
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
      <p class="tips">这里最多预览前 20 行；文件里的全部内容都会在发布时生效。</p>

      <div class="inline" style="margin-top: 10px">
        <button class="btn btn--primary" type="button" :disabled="!preview.valid" @click="goStep(4)">
          下一步：确认发布
        </button>
        <button class="btn btn--ghost" type="button" @click="restartUpload">重新上传修改后的文件</button>
        <span v-if="!preview.valid" class="small muted">先按上面的提示改完原文件，才能进入发布。</span>
      </div>
    </section>

    <!-- 第 4 步：确认发布 -->
    <section v-else-if="step === 4 && preview" class="card">
      <div class="card__header">
        <h3 class="card__title">第 4 步：确认发布「{{ kindName(preview.kind) }}」资料</h3>
        <span class="badge badge--ok">校验通过</span>
      </div>

      <template v-if="wizardPublished !== null">
        <div class="alert">
          <strong>已发布资料 v{{ wizardPublished }}</strong>
          <div class="small">学生端现在以这一版资料为准；版本记录可在下方“详细信息”里查看。</div>
        </div>
        <div class="inline" style="margin-top: 10px">
          <button class="btn btn--primary" type="button" @click="resetWizard">继续导入下一批资料</button>
          <button class="btn btn--ghost" type="button" @click="showDetails = true">查看详细信息</button>
        </div>
      </template>

      <template v-else>
        <div class="grid grid--3">
          <div class="stat">
            <div class="stat__label">资料类型</div>
            <div class="stat__value" style="font-size: 18px">{{ kindName(preview.kind) }}</div>
            <div class="stat__extra">原文件：{{ preview.fileName }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">本次新增 / 更新</div>
            <div class="stat__value">{{ preview.rowCount }}</div>
            <div class="stat__extra">行资料将写入正式数据</div>
          </div>
          <div class="stat">
            <div class="stat__label">问题数量</div>
            <div class="stat__value">{{ errorIssues.length }} / {{ warningIssues.length }}</div>
            <div class="stat__extra">必须修改 / 建议核对</div>
          </div>
        </div>

        <ul class="list" style="margin-top: 10px">
          <li class="list__item">
            <strong>将发布的资料</strong>
            <div class="small muted">
              {{ kindName(preview.kind) }} · 共 {{ preview.rowCount }} 行 · 错误 {{ errorIssues.length }} 个 · 警告
              {{ warningIssues.length }} 个
            </div>
          </li>
          <li v-if="preview.kind === 'program'" class="list__item">
            <strong>培养方案代码</strong>
            <div class="small muted">{{ programCode.trim() || '未填写（按系统默认方案发布）' }}</div>
          </li>
          <li v-if="preview.kind === 'classes'" class="list__item">
            <strong>开课学期</strong>
            <div class="small muted">{{ term.trim() || currentActivity?.term || '未填写（沿用现有学期）' }}</div>
          </li>
          <li v-if="preview.kind === 'records' || preview.kind === 'program'" class="list__item">
            <strong>需要留意的影响</strong>
            <div class="small muted">发布后相关学生的资料确认需要重新确认，系统会把这些学生放入异常清单，不会静默删除已选课程。</div>
          </li>
        </ul>

        <div class="inline" style="margin-top: 10px">
          <button class="btn btn--primary" type="button" :disabled="publishing" @click="publishPreview">
            {{ publishing ? '发布中…' : '确认发布' }}
          </button>
          <button class="btn btn--ghost" type="button" @click="goStep(3)">返回校验结果</button>
        </div>
        <p class="tips">发布前会再确认一次；确认后生成新的资料版本，学生端立即以这一版为准。</p>
      </template>
    </section>

    <!-- 详细信息：原文件、来源、版本与历史记录 -->
    <section class="card">
      <div class="card__header">
        <h3 class="card__title">详细信息：原文件、来源、版本与历史记录</h3>
        <div class="inline">
          <button class="btn btn--ghost btn--sm" type="button" @click="showDetails = !showDetails">
            {{ showDetails ? '收起详细信息' : '展开详细信息' }}
          </button>
          <button
            class="btn btn--ghost btn--sm"
            type="button"
            :disabled="historyLoading || versionsLoading"
            @click="refreshAll"
          >
            刷新
          </button>
        </div>
      </div>

      <p v-if="!showDetails" class="small muted">
        这里放导入批次的原文件、解析来源、资料版本与历史记录，不占用上面的操作区。
      </p>

      <div v-else class="stack">
        <div v-if="preview" class="grid grid--4">
          <div class="stat">
            <div class="stat__label">原文件</div>
            <div class="small">{{ preview.fileName }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">解析来源</div>
            <div class="small">{{ sourceName(preview.source) }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">资料类型</div>
            <div class="small">{{ kindName(preview.kind) }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">读到行数</div>
            <div class="small">{{ preview.rowCount }}</div>
          </div>
        </div>

        <div>
          <div class="card__header">
            <h3 class="card__title">导入历史</h3>
            <span class="muted small">“已校验，待发布”的批次可以直接发布</span>
          </div>

          <p v-if="historyError" class="alert alert--error">
            <strong>读取失败</strong>：{{ historyError }}
            <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="loadHistory">
              重试
            </button>
          </p>
          <div v-else-if="historyLoading && history.length === 0" class="muted">正在读取导入历史…</div>
          <div v-else-if="history.length === 0" class="empty">还没有导入记录。</div>
          <div v-else class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>资料类型</th>
                  <th>原文件</th>
                  <th>解析来源</th>
                  <th>状态</th>
                  <th>行数 / 问题</th>
                  <th>创建</th>
                  <th>发布</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in history" :key="row.id">
                  <td>{{ kindName(row.kind) }}</td>
                  <td>{{ row.fileName }}</td>
                  <td class="small muted">{{ sourceName(reportSource(row)) }}</td>
                  <td>
                    <span :class="batchStatusClass(row)">{{ batchStatusText(row) }}</span>
                    <div v-if="reportIssues(row).length > 0" class="small muted">
                      问题 {{ reportIssues(row).length }} 个
                    </div>
                  </td>
                  <td>{{ row.rowCount }} / {{ row.errorCount }}</td>
                  <td class="small muted">
                    {{ formatDateTime(row.createdAt) }}<br />{{ row.createdBy ?? '—' }}
                  </td>
                  <td class="small muted">{{ formatDateTime(row.publishedAt) }}</td>
                  <td>
                    <button
                      v-if="row.status !== 'published' && row.errorCount === 0"
                      class="btn btn--sm btn--primary"
                      type="button"
                      :disabled="publishing"
                      @click="publishHistory(row)"
                    >
                      发布
                    </button>
                    <span v-else-if="row.status === 'published'" class="small muted">已发布</span>
                    <span v-else class="small muted">需先修正</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div class="card__header">
            <h3 class="card__title">资料版本</h3>
            <span class="muted small">每次发布生成一个新版本，只有最新版本生效</span>
          </div>

          <p v-if="versionsError" class="alert alert--error">
            <strong>读取失败</strong>：{{ versionsError }}
            <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="loadVersions">
              重试
            </button>
          </p>
          <div v-else-if="versionsLoading && versions.length === 0" class="muted">正在读取资料版本…</div>
          <div v-else-if="versions.length === 0" class="empty">还没有发布过任何资料版本。</div>
          <div v-else class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>资料类型</th>
                  <th>摘要</th>
                  <th>发布人</th>
                  <th>发布时间</th>
                  <th>是否生效</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in versions" :key="row.id">
                  <td>v{{ row.versionNo }}</td>
                  <td>{{ versionKindName(row) }}</td>
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
        </div>
      </div>
    </section>
  </div>
</template>
