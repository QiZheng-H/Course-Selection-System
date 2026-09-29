<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api } from '@/api/client';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type {
  BatchDto,
  ClassDto,
  CourseDto,
  DraftGroup,
  DraftPreference,
  PreferencesPayload,
  RandomKeyRow,
  ValidationIssue,
  ValidationResult,
} from '@/api/types';
import { batchStatusLabel, formatCredits, formatDateTime, preferenceStateLabel } from '@/utils/labels';

interface EditablePreference extends DraftPreference {
  courseCode: string;
  courseName: string;
  credits: number;
}

const toast = useToast();

const batches = ref<BatchDto[]>([]);
const batchId = ref<number | null>(null);
const batch = ref<BatchDto | null>(null);
const payload = ref<PreferencesPayload | null>(null);

const items = ref<EditablePreference[]>([]);
const groups = ref<DraftGroup[]>([]);

const courseCache = reactive<Record<number, { code: string; name: string; credits: number }>>({});
const classCache = reactive<Record<number, ClassDto[]>>({});

const loading = ref(false);
const saving = ref(false);
const validating = ref(false);
const submitting = ref(false);
const withdrawing = ref(false);
const validatingErrors = ref<ValidationIssue[]>([]);
const validatingWarnings = ref<ValidationIssue[]>([]);
const validation = ref<ValidationResult | null>(null);
const lastSavedAt = ref<string | null>(null);
const dirty = ref(false);
const hydrating = ref(false);

const randomKeys = ref<RandomKeyRow[]>([]);
const randomKeyTerm = ref('');
const loadingKeys = ref(false);

const courseSearchKeyword = ref('');
const courseSearchResults = ref<CourseDto[]>([]);
const searchingCourses = ref(false);

let saveTimer: number | null = null;

const canEdit = computed(() => {
  if (!batch.value) return false;
  return batch.value.status === 'preview' || batch.value.status === 'open';
});

const totalCredits = computed(() => items.value.reduce((sum, item) => sum + (item.credits || 0), 0));
const creditLimit = computed(() => batch.value?.creditLimit ?? validation.value?.creditPlan.creditLimit ?? null);

function serialize() {
  return {
    preferences: [...items.value]
      .sort((a, b) => a.globalRank - b.globalRank)
      .map((item) => ({
        courseId: item.courseId,
        globalRank: item.globalRank,
        classIds: item.classIds,
        note: item.note ?? null,
        groupCode: item.groupCode ?? null,
      })),
    groups: groups.value.map((group) => ({ code: group.code, name: group.name, note: group.note ?? null })),
  };
}

function markDirty(): void {
  if (hydrating.value) return;
  dirty.value = true;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void saveDraft(true);
  }, 900);
}

watch([items, groups], markDirty, { deep: true });

async function ensureCourseInfo(courseId: number): Promise<void> {
  if (courseCache[courseId]) return;
  try {
    const data = await api.get<{ course: CourseDto & { classes: ClassDto[] } }>(`/courses/${courseId}`);
    courseCache[courseId] = { code: data.course.code, name: data.course.name, credits: data.course.credits };
    classCache[courseId] = data.course.classes;
  } catch {
    courseCache[courseId] = { code: String(courseId), name: `课程 ${courseId}`, credits: 0 };
  }
}

async function loadBatch(targetBatchId: number): Promise<void> {
  loading.value = true;
  hydrating.value = true;
  try {
    const data = await api.get<PreferencesPayload>('/preferences', { batchId: targetBatchId });
    payload.value = data;
    batch.value = data.batch;
    batchId.value = data.batch.id;
    const draft = data.draft;
    const draftItems: EditablePreference[] = (draft.preferences ?? []).map((pref) => ({
      courseId: pref.courseId,
      globalRank: pref.globalRank,
      classIds: pref.classIds ?? [],
      note: pref.note ?? null,
      groupCode: pref.groupCode ?? null,
      courseCode: String(pref.courseId),
      courseName: `课程 ${pref.courseId}`,
      credits: 0,
    }));
    items.value = draftItems;
    groups.value = (draft.groups ?? []).map((group) => ({ code: group.code, name: group.name, note: group.note ?? null }));
    lastSavedAt.value = draft.updatedAt ?? null;
    validation.value = null;
    validatingErrors.value = [];
    validatingWarnings.value = [];
    randomKeys.value = [];

    await Promise.all(items.value.map((item) => ensureCourseInfo(item.courseId)));
    for (const item of items.value) {
      const info = courseCache[item.courseId];
      if (info) {
        item.courseCode = info.code;
        item.courseName = info.name;
        item.credits = info.credits;
      }
    }
  } catch (error) {
    reportApiError(error, '读取志愿失败');
  } finally {
    hydrating.value = false;
    dirty.value = false;
    loading.value = false;
  }
}

async function loadBatches(): Promise<void> {
  try {
    const data = await api.get<{ batches: BatchDto[]; current: BatchDto | null }>('/student/batches');
    batches.value = data.batches;
    const target = data.current ?? data.batches[0] ?? null;
    if (target) await loadBatch(target.id);
  } catch (error) {
    reportApiError(error, '读取批次失败');
  }
}

async function searchCourses(): Promise<void> {
  searchingCourses.value = true;
  try {
    const data = await api.get<{ items: CourseDto[] }>('/courses', {
      keyword: courseSearchKeyword.value.trim() || undefined,
      pageSize: 20,
    });
    courseSearchResults.value = data.items;
  } catch (error) {
    reportApiError(error, '搜索课程失败');
  } finally {
    searchingCourses.value = false;
  }
}

async function addCourse(course: CourseDto): Promise<void> {
  if (items.value.some((item) => item.courseId === course.id)) {
    toast.warning('同一门课程只能出现一次', ['如需更换教学班，请在“教学班偏好”里排序，不要重复添加课程。']);
    return;
  }
  const nextRank = items.value.length === 0 ? 1 : Math.max(...items.value.map((item) => item.globalRank)) + 1;
  const editable: EditablePreference = {
    courseId: course.id,
    globalRank: nextRank,
    classIds: [],
    note: null,
    groupCode: null,
    courseCode: course.code,
    courseName: course.name,
    credits: course.credits,
  };
  courseCache[course.id] = { code: course.code, name: course.name, credits: course.credits };
  items.value.push(editable);
  await ensureCourseInfo(course.id);
}

function removePreference(index: number): void {
  items.value.splice(index, 1);
  normalizeRanks();
}

function normalizeRanks(): void {
  const sorted = [...items.value].sort((a, b) => a.globalRank - b.globalRank);
  sorted.forEach((item, index) => {
    item.globalRank = index + 1;
  });
}

async function loadClasses(courseId: number): Promise<void> {
  if (classCache[courseId]) return;
  try {
    const data = await api.get<{ items: ClassDto[] }>('/classes', { courseId, pageSize: 100 });
    classCache[courseId] = data.items;
  } catch (error) {
    reportApiError(error, '读取教学班失败');
  }
}

function addClassChoice(item: EditablePreference, classId: number): void {
  if (!classId) return;
  if (item.classIds.includes(classId)) return;
  item.classIds.push(classId);
}

/** 下拉框选择教学班：值和事件都在脚本里转换，模板保持简单 */
function onClassSelect(item: EditablePreference, event: Event): void {
  const select = event.target as HTMLSelectElement | null;
  if (!select) return;
  const value = Number(select.value);
  select.value = '';
  addClassChoice(item, value);
}

/** 切换批次（下拉框的 v-model 已经写入 batchId） */
function onBatchChange(): void {
  if (batchId.value !== null) void loadBatch(batchId.value);
}

function removeClassChoice(item: EditablePreference, classId: number): void {
  item.classIds = item.classIds.filter((id) => id !== classId);
}

function moveClassChoice(item: EditablePreference, index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= item.classIds.length) return;
  const copy = [...item.classIds];
  const [moved] = copy.splice(index, 1);
  copy.splice(target, 0, moved);
  item.classIds = copy;
}

function className(item: EditablePreference, classId: number): string {
  const list = classCache[item.courseId] ?? [];
  const found = list.find((cls) => cls.id === classId);
  return found ? found.classCode : `教学班 ${classId}`;
}

function addGroup(): void {
  const index = groups.value.length + 1;
  let code = `G${index}`;
  while (groups.value.some((group) => group.code === code)) code = `${code}x`;
  groups.value.push({ code, name: `替代组 ${index}`, note: null });
}

function removeGroup(code: string): void {
  groups.value = groups.value.filter((group) => group.code !== code);
  for (const item of items.value) {
    if (item.groupCode === code) item.groupCode = null;
  }
}

async function saveDraft(silent = false): Promise<void> {
  if (batchId.value === null) return;
  saving.value = true;
  try {
    const result = await api.put<{ updatedAt: string }>('/preferences/draft', {
      batchId: batchId.value,
      ...serialize(),
    });
    lastSavedAt.value = result.updatedAt;
    dirty.value = false;
    if (!silent) toast.success('草稿已保存');
    await validateDraft(false);
  } catch (error) {
    reportApiError(error, '保存草稿失败');
  } finally {
    saving.value = false;
  }
}

async function validateDraft(showToast = true): Promise<void> {
  if (batchId.value === null) return;
  validating.value = true;
  try {
    const result = await api.post<ValidationResult>('/preferences/validate', {
      batchId: batchId.value,
      ...serialize(),
    });
    validation.value = result;
    validatingErrors.value = result.issues.filter((issue) => issue.level === 'error');
    validatingWarnings.value = result.issues.filter((issue) => issue.level === 'warning');
    if (showToast) {
      if (result.ok) toast.success('校验通过', [`计划学分 ${result.creditPlan.plannedCredits} / 上限 ${result.creditPlan.creditLimit}`]);
      else toast.error('校验未通过', validatingErrors.value.map((issue) => issue.message));
    }
  } catch (error) {
    reportApiError(error, '校验失败');
  } finally {
    validating.value = false;
  }
}

async function submitPreferences(): Promise<void> {
  if (batchId.value === null) return;
  const ok = await askConfirm({
    title: '提交志愿',
    message: '提交后会生成一个不可变的新版本，以最后一次成功提交的完整版本为准；提交失败会保留旧版本。',
    details: [
      `共 ${items.value.length} 门课程，计划 ${totalCredits.value} 学分`,
      '提交不会改变已固定的随机键（重交不重抽）。',
      '截止冻结后不能再提交或撤回。',
    ],
    confirmText: '确认提交',
  });
  if (!ok) return;
  submitting.value = true;
  try {
    const result = await api.post<{ versionNo: number; submittedAt: string; warnings: ValidationIssue[] }>(
      '/preferences/submit',
      { batchId: batchId.value, ...serialize() },
    );
    toast.success(`已提交 v${result.versionNo}`, [
      formatDateTime(result.submittedAt),
      ...result.warnings.map((issue) => `提示：${issue.message}`),
    ]);
    await loadBatch(batchId.value);
  } catch (error) {
    reportApiError(error, '提交失败');
  } finally {
    submitting.value = false;
  }
}

async function withdraw(): Promise<void> {
  if (batchId.value === null) return;
  const ok = await askConfirm({
    title: '撤回志愿',
    message: '撤回后当前有效提交会失效（草稿保留），随机键不会被重新抽取。',
    confirmText: '确认撤回',
  });
  if (!ok) return;
  withdrawing.value = true;
  try {
    const result = await api.post<{ withdrawn: number }>('/preferences/withdraw', { batchId: batchId.value });
    toast.success(`已撤回志愿（影响 ${result.withdrawn} 份提交）`);
    await loadBatch(batchId.value);
  } catch (error) {
    reportApiError(error, '撤回失败');
  } finally {
    withdrawing.value = false;
  }
}

async function loadRandomKeys(): Promise<void> {
  if (batchId.value === null) return;
  loadingKeys.value = true;
  try {
    const data = await api.get<{ term: string; keys: RandomKeyRow[] }>('/preferences/random-keys', {
      batchId: batchId.value,
    });
    randomKeyTerm.value = data.term;
    randomKeys.value = data.keys;
  } catch (error) {
    reportApiError(error, '读取随机键失败');
  } finally {
    loadingKeys.value = false;
  }
}

function issuesForCourse(courseId: number): ValidationIssue[] {
  return validation.value ? validation.value.issues.filter((issue) => issue.courseId === courseId) : [];
}

function availabilityFor(courseId: number): ValidationResult['availability'][number] | null {
  return validation.value?.availability.find((row) => row.courseId === courseId) ?? null;
}

function demandFor(courseId: number): ValidationResult['demandHints'][number] | null {
  return validation.value?.demandHints.find((row) => row.courseId === courseId) ?? null;
}

onMounted(loadBatches);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">志愿</h1>
        <p class="page__desc">
          所有申请课程共用一套不重复的全局排名；草稿会自动保存，提交后生成不可变版本，撤回只影响当前有效提交。
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
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading || batchId === null" @click="onBatchChange">
          刷新
        </button>
      </div>
    </div>

    <p v-if="!loading && batches.length === 0" class="alert alert--warning">
      当前没有任何选课批次，无法保存或提交志愿。请等待管理员创建并开放批次后再回来填写。
    </p>
    <p v-else-if="!loading && batchId === null" class="alert alert--warning">请先在上方选择一个批次。</p>

    <ul class="tips">
      <li>同一课程只能出现一次；多建替代组不会增加第一志愿，重复课程会被校验直接判为错误。</li>
      <li>备选之间允许时间冲突（草稿期自由），但最终落实的完整课表必须无冲突。</li>
      <li>已选上更低偏好的课程后，系统会关闭排名更低的志愿（状态会显示为“已被更高偏好关闭”）。</li>
      <li>随机键在首次提交时固定，重交、重试、退出后重新加入都不会重抽。</li>
    </ul>

    <section v-if="batch" class="card">
      <div class="inline">
        <span class="badge badge--muted">{{ batch.name }}</span>
        <span class="badge">{{ batchStatusLabel(batch.status) }}</span>
        <span class="badge">学分上限 {{ formatCredits(batch.creditLimit) }}</span>
        <span class="badge">开放 {{ formatDateTime(batch.openAt) }}</span>
        <span class="badge">截止 {{ formatDateTime(batch.closeAt) }}</span>
        <span v-if="batch.snapshotHash" class="badge badge--muted">快照 {{ batch.snapshotHash.slice(0, 12) }}…</span>
      </div>
      <p v-if="!canEdit" class="alert alert--warning" style="margin-top: 10px">
        当前批次状态为「{{ batchStatusLabel(batch.status) }}」，只有「预览开放」与「正式受理」阶段可以修改并提交志愿。
      </p>
      <p v-if="!batch.configReady" class="alert alert--warning" style="margin-top: 8px">
        批次必需配置缺失：{{ batch.configIssues.join('；') }}
      </p>
      <div class="inline" style="margin-top: 10px">
        <span class="muted small">
          草稿状态：{{ dirty ? '有未保存修改（将自动保存）' : saving ? '保存中…' : '已同步' }} · 最近保存
          {{ formatDateTime(lastSavedAt) }}
        </span>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">当前提交版本</h3>
        <div class="inline">
          <button class="btn btn--ghost btn--sm" type="button" :disabled="validating || batchId === null" @click="validateDraft(true)">
            {{ validating ? '校验中…' : '校验草稿' }}
          </button>
          <button class="btn btn--primary btn--sm" type="button" :disabled="saving || batchId === null" @click="saveDraft(false)">
            {{ saving ? '保存中…' : '立即保存草稿' }}
          </button>
          <button class="btn btn--primary btn--sm" type="button" :disabled="submitting || !canEdit" @click="submitPreferences">
            {{ submitting ? '提交中…' : '提交志愿' }}
          </button>
          <button class="btn btn--danger btn--sm" type="button" :disabled="withdrawing || !canEdit" @click="withdraw">
            {{ withdrawing ? '撤回中…' : '撤回志愿' }}
          </button>
        </div>
      </div>

      <div v-if="payload && payload.view.status !== 'none'" class="stack">
        <div class="inline">
          <span class="badge badge--ok">版本 v{{ payload.view.versionNo }}</span>
          <span class="badge" :class="payload.view.status === 'submitted' ? 'badge--ok' : 'badge--muted'">
            {{ payload.view.status === 'submitted' ? '有效提交' : '已撤回' }}
          </span>
          <span class="muted small">提交时间：{{ formatDateTime(payload.view.submittedAt) }}</span>
        </div>
        <div class="table-wrap">
          <table class="table table--compact">
            <thead>
              <tr>
                <th>排名</th>
                <th>课程</th>
                <th>学分</th>
                <th>替代组</th>
                <th>教学班偏好</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in payload.view.items" :key="item.preferenceId">
                <td>{{ item.globalRank }}</td>
                <td>{{ item.courseName }}<span class="mono small">（{{ item.courseCode }}）</span></td>
                <td>{{ formatCredits(item.credits) }}</td>
                <td>{{ item.groupCode ? `${item.groupName ?? ''}（${item.groupCode}）` : '—' }}</td>
                <td>
                  <span v-if="item.classChoices.length === 0" class="muted">未指定</span>
                  <span v-else>
                    {{ item.classChoices.map((choice) => `${choice.classCode}（余${choice.generalAvailable}）`).join(' → ') }}
                  </span>
                </td>
                <td>
                  <span
                    class="badge"
                    :class="item.state === 'allocated' ? 'badge--ok' : item.state === 'superseded' ? 'badge--muted' : 'badge--warn'"
                  >
                    {{ preferenceStateLabel(item.state) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p v-else class="muted">该批次还没有提交记录。填写下方草稿后点击“提交志愿”。</p>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">志愿草稿</h3>
        <span class="muted small">
          计划 {{ items.length }} 门 / {{ formatCredits(totalCredits) }} 学分（上限 {{ formatCredits(creditLimit) }}）
        </span>
      </div>

      <div class="grid grid--2">
        <div class="list">
          <div v-for="(item, index) in items" :key="item.courseId" class="list__item">
            <div class="inline">
              <label class="field" style="margin-bottom: 0">
                <span class="field__label">全局排名（唯一）</span>
                <input v-model.number="item.globalRank" class="input input--sm rank-input" type="number" min="1" step="1" />
              </label>
              <div style="flex: 1">
                <strong>{{ item.courseName }}</strong>
                <span class="mono small">{{ item.courseCode }}</span>
                <span class="badge">{{ formatCredits(item.credits) }} 学分</span>
              </div>
              <button class="btn btn--sm btn--ghost" type="button" @click="loadClasses(item.courseId)">加载教学班</button>
              <button class="btn btn--sm btn--danger" type="button" @click="removePreference(index)">移除</button>
            </div>

            <div class="grid grid--2" style="margin-top: 8px">
              <label class="field" style="margin-bottom: 0">
                <span class="field__label">所属替代组（组内互斥，最多落实一门）</span>
                <select v-model="item.groupCode" class="select">
                  <option :value="null">不加入替代组</option>
                  <option v-for="group in groups" :key="group.code" :value="group.code">
                    {{ group.name }}（{{ group.code }}）
                  </option>
                </select>
              </label>
              <label class="field" style="margin-bottom: 0">
                <span class="field__label">备注（可选）</span>
                <input v-model="item.note" class="input" type="text" placeholder="例如：优先本专业教学班" />
              </label>
            </div>

            <div style="margin-top: 8px">
              <span class="field__label">教学班偏好排序（从上到下为优先顺序）</span>
              <div v-if="item.classIds.length === 0" class="muted small">未指定教学班，系统在落实时按规则自行选择。</div>
              <div v-else class="inline">
                <span v-for="(classId, classIndex) in item.classIds" :key="classId" class="badge">
                  {{ classIndex + 1 }}. {{ className(item, classId) }}
                  <button class="btn btn--sm btn--ghost" type="button" @click="moveClassChoice(item, classIndex, -1)">↑</button>
                  <button class="btn btn--sm btn--ghost" type="button" @click="moveClassChoice(item, classIndex, 1)">↓</button>
                  <button class="btn btn--sm btn--ghost" type="button" @click="removeClassChoice(item, classId)">×</button>
                </span>
              </div>
              <div class="inline" style="margin-top: 6px">
                <select
                  class="select"
                  style="max-width: 320px"
                  @change="onClassSelect(item, $event)"
                >
                  <option value="">添加教学班…</option>
                  <option v-for="cls in classCache[item.courseId] ?? []" :key="cls.id" :value="cls.id">
                    {{ cls.classCode }} · {{ cls.sessions.map((s) => s.text).join('；') }} · 余 {{ cls.generalAvailable }}
                  </option>
                </select>
              </div>
            </div>

            <div v-if="availabilityFor(item.courseId)" class="small muted" style="margin-top: 6px">
              开放教学班 {{ availabilityFor(item.courseId)?.openClasses }} 个 · 总余量 {{ availabilityFor(item.courseId)?.totalAvailable }} ·
              需求等级 {{ demandFor(item.courseId)?.demandLevel ?? '—' }}
              <span v-if="demandFor(item.courseId)?.reasons.length">（{{ demandFor(item.courseId)?.reasons.join('；') }}）</span>
            </div>

            <ul v-if="issuesForCourse(item.courseId).length > 0" class="reason-list">
              <li v-for="(issue, issueIndex) in issuesForCourse(item.courseId)" :key="issueIndex">
                {{ issue.level === 'error' ? '错误' : '提示' }}：{{ issue.message }}
              </li>
            </ul>
          </div>
          <p v-if="items.length === 0" class="muted">还没有任何志愿课程。</p>
        </div>

        <div class="stack">
          <div class="card card--flat">
            <h3 class="card__title">添加课程</h3>
            <div class="inline">
              <input v-model="courseSearchKeyword" class="input" type="text" placeholder="课程名或课程号" @keyup.enter="searchCourses" />
              <button class="btn btn--primary btn--sm" type="button" :disabled="searchingCourses" @click="searchCourses">
                {{ searchingCourses ? '搜索中…' : '搜索' }}
              </button>
            </div>
            <div v-if="courseSearchResults.length > 0" class="list" style="margin-top: 8px">
              <div v-for="course in courseSearchResults" :key="course.id" class="list__item">
                <div class="inline">
                  <span class="mono small">{{ course.code }}</span>
                  <span>{{ course.name }}</span>
                  <span class="badge">{{ formatCredits(course.credits) }} 学分</span>
                  <span class="spacer"></span>
                  <button class="btn btn--sm btn--primary" type="button" @click="addCourse(course)">添加</button>
                </div>
              </div>
            </div>
          </div>

          <div class="card card--flat">
            <div class="card__header">
              <h3 class="card__title">替代组</h3>
              <button class="btn btn--ghost btn--sm" type="button" @click="addGroup">新建替代组</button>
            </div>
            <div v-if="groups.length === 0" class="muted small">没有替代组。替代组内的课程互斥，最多落实一门。</div>
            <div v-else class="list">
              <div v-for="group in groups" :key="group.code" class="list__item">
                <div class="inline">
                  <input v-model="group.code" class="input input--sm" type="text" />
                  <input v-model="group.name" class="input" type="text" />
                  <button class="btn btn--sm btn--danger" type="button" @click="removeGroup(group.code)">删除</button>
                </div>
                <div class="small muted">
                  组内课程：{{ items.filter((item) => item.groupCode === group.code).map((item) => item.courseName).join('、') || '（空）' }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section v-if="validation" class="card">
      <div class="card__header">
        <h3 class="card__title">校验结果</h3>
        <span class="badge" :class="validation.ok ? 'badge--ok' : 'badge--danger'">
          {{ validation.ok ? '可以提交' : '存在错误，不能提交' }}
        </span>
      </div>
      <div v-if="validatingErrors.length > 0" class="alert alert--error">
        <strong>错误（{{ validatingErrors.length }}）</strong>
        <ul>
          <li v-for="(issue, index) in validatingErrors" :key="index">[{{ issue.code }}] {{ issue.message }}</li>
        </ul>
      </div>
      <div v-if="validatingWarnings.length > 0" class="alert alert--warning" style="margin-top: 8px">
        <strong>提示（{{ validatingWarnings.length }}）</strong>
        <ul>
          <li v-for="(issue, index) in validatingWarnings" :key="index">[{{ issue.code }}] {{ issue.message }}</li>
        </ul>
      </div>
      <p v-if="validatingErrors.length === 0 && validatingWarnings.length === 0" class="muted">没有发现任何问题。</p>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">固定随机键</h3>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loadingKeys || batchId === null" @click="loadRandomKeys">
          {{ loadingKeys ? '读取中…' : '查看随机键' }}
        </button>
      </div>
      <p class="tips">
        随机键在提交志愿时一次性生成并固定，用于同需求等级、同排名时的最终排序。重交、重试、退出后重新加入都不会重抽。
      </p>
      <div v-if="randomKeys.length > 0" class="table-wrap">
        <table class="table table--compact">
          <thead>
            <tr>
              <th>课程</th>
              <th>学期</th>
              <th>随机键（完整值）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in randomKeys" :key="row.courseId">
              <td>{{ row.courseName }}</td>
              <td>{{ randomKeyTerm }}</td>
              <td class="mono">{{ row.randomKey ?? '未生成（尚未参与过提交/候补）' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
