<script setup lang="ts">
/**
 * 志愿填报向导：① 选课 → ② 排顺序 → ③ 预演并提交。
 *
 * 设计原则（面向第一次使用的学生）：
 *   - 学生只做三件事：勾课、拖顺序、确认。名次、备选关系、需求等级翻译都由系统完成；
 *   - “全局排名”等于列表位置，界面上只读，因此不可能重复、也不会出现空洞；
 *   - “替代组”以「加备选」的方式表达，学生不需要理解组这个概念；
 *   - 提交前给出课表预演：会排成什么样、哪一门排不进、被谁挡住。
 *
 * 数据形态由后端统一归一化（见 preference/service.ts 的 normalizeDraftPayload）：
 * 一个替代组里只放备选课程，主课程不属于该组，组名也由服务端生成。
 * 前端提交时只负责给出“课程 + 顺序 + 组编码”，不拼中文、不做规则判断。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api } from '@/api/client';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type {
  BatchDto,
  ClassDto,
  CourseDto,
  DraftPreference,
  PreferencePreview,
  PreferencesPayload,
  PreviewAttempt,
  RandomKeyRow,
  ValidationIssue,
  ValidationResult,
} from '@/api/types';
import {
  batchStatusLabel,
  demandTone,
  formatCredits,
  formatDateTime,
  preferenceStateLabel,
  previewStatusClass,
  previewStatusLabel,
} from '@/utils/labels';
import TimetableGrid from '@/components/TimetableGrid.vue';

interface EditablePreference extends DraftPreference {
  courseCode: string;
  courseName: string;
  credits: number;
}

/** 被折叠到主课程下面的备选课程 */
interface AltCourse {
  courseId: number;
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
/** 主课程 courseId → 它的备选课程（服务端会把这些备选放进同一个替代组） */
const alternatives = ref<Record<number, AltCourse[]>>({});
/** 主课程 courseId → 替代组编码（仅界面内部使用） */
const groupCodeOf = ref<Record<number, string>>({});

const courseCache = reactive<Record<number, { code: string; name: string; credits: number }>>({});
const classCache = reactive<Record<number, ClassDto[]>>({});

const loading = ref(false);
const saving = ref(false);
const submitting = ref(false);
const withdrawing = ref(false);
const previewing = ref(false);

const validation = ref<ValidationResult | null>(null);
const preview = ref<PreferencePreview | null>(null);
const validationError = ref('');

const lastSavedAt = ref<string | null>(null);
const dirty = ref(false);
const hydrating = ref(false);

const randomKeys = ref<RandomKeyRow[]>([]);
const randomKeyTerm = ref('');
const loadingKeys = ref(false);

const courseSearchKeyword = ref('');
const courseSearchResults = ref<CourseDto[]>([]);
const searchingCourses = ref(false);

/** 备选选择器当前展开在哪一门主课程上 */
const altPickerFor = ref<number | null>(null);
const altKeyword = ref('');
const altResults = ref<CourseDto[]>([]);
const altLoading = ref(false);

const step = ref(1);
const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);
const showAdvanced = ref(false);

let saveTimer: number | null = null;

const canEdit = computed(() => {
  if (!batch.value) return false;
  return batch.value.status === 'preview' || batch.value.status === 'open';
});

const totalCredits = computed(() => items.value.reduce((sum, item) => sum + (item.credits || 0), 0));

const creditLimit = computed(
  () => batch.value?.creditLimit ?? validation.value?.creditPlan.creditLimit ?? preview.value?.creditLimit ?? null,
);

const overLimit = computed(() => creditLimit.value !== null && totalCredits.value > creditLimit.value);

const errors = computed<ValidationIssue[]>(() => validation.value?.issues.filter((issue) => issue.level === 'error') ?? []);
const warnings = computed<ValidationIssue[]>(() => validation.value?.issues.filter((issue) => issue.level === 'warning') ?? []);

const canSubmit = computed(() => canEdit.value && items.value.length > 0 && errors.value.length === 0 && !overLimit.value);

const stepLabels = ['选课', '排顺序', '预演并提交'];

/* ----------------------------- 草稿与提交版本的差异 ----------------------------- */

interface DraftDiffRow {
  courseId: number;
  courseName: string;
  detail: string;
}

const draftDiff = computed<{ changed: boolean; rows: DraftDiffRow[] }>(() => {
  const submission = payload.value?.view;
  if (!submission || submission.status !== 'submitted' || submission.items.length === 0) {
    return { changed: false, rows: [] };
  }
  const submittedByCourse = new Map(submission.items.map((item) => [item.courseId, item]));
  const draftByCourse = new Map(items.value.map((item) => [item.courseId, item]));
  const rows: DraftDiffRow[] = [];
  const altIds = new Set(allAlternatives().map((alt) => alt.courseId));

  for (const [courseId, item] of draftByCourse) {
    const submitted = submittedByCourse.get(courseId);
    if (!submitted) {
      rows.push({ courseId, courseName: item.courseName, detail: `草稿新增（第 ${item.globalRank} 志愿）` });
      continue;
    }
    if (submitted.globalRank !== item.globalRank) {
      rows.push({
        courseId,
        courseName: item.courseName,
        detail: `志愿顺序 第 ${submitted.globalRank} → 第 ${item.globalRank}`,
      });
    }
    const submittedClasses = submitted.classChoices.map((choice) => choice.classId);
    if (JSON.stringify(submittedClasses) !== JSON.stringify(item.classIds)) {
      rows.push({ courseId, courseName: item.courseName, detail: '教学班偏好有变化' });
    }
    const submittedGroup = submitted.groupCode ?? '';
    const draftGroup = item.groupCode ?? '';
    if (submittedGroup !== draftGroup) {
      rows.push({ courseId, courseName: item.courseName, detail: '备选关系有变化' });
    }
  }
  for (const [courseId, submitted] of submittedByCourse) {
    if (!draftByCourse.has(courseId) && !altIds.has(courseId)) {
      rows.push({
        courseId,
        courseName: submitted.courseName,
        detail: `草稿已移除（已提交版本为第 ${submitted.globalRank} 志愿）`,
      });
    }
  }
  return { changed: rows.length > 0, rows };
});

/* ------------------------------ 备选（替代组） ------------------------------ */

function altsOf(courseId: number): AltCourse[] {
  return alternatives.value[courseId] ?? [];
}

function allAlternatives(): AltCourse[] {
  return Object.values(alternatives.value).flat();
}

/** 该课程是否已经在清单里（作为志愿或备选） */
function inDraft(courseId: number): boolean {
  return items.value.some((item) => item.courseId === courseId) || allAlternatives().some((alt) => alt.courseId === courseId);
}

function nextGroupCode(): string {
  let index = Object.keys(groupCodeOf.value).length + 1;
  let code = `ALT${index}`;
  const used = new Set(Object.values(groupCodeOf.value));
  while (used.has(code)) {
    index += 1;
    code = `ALT${index}`;
  }
  return code;
}

/* ------------------------------ 序列化与保存 ------------------------------ */

function sortedItems(): EditablePreference[] {
  return [...items.value].sort((a, b) => a.globalRank - b.globalRank);
}

/**
 * 展开成后端接受的扁平志愿列表：每门主课程后面紧跟它的备选课程。
 * 备选排在主课程之后，正好对应“主课程优先尝试、备选作为退路”的语义。
 */
function serialize() {
  const sequence: Array<{ courseId: number; classIds: number[]; note: string | null; groupCode: string | null }> = [];
  for (const item of sortedItems()) {
    const code = groupCodeOf.value[item.courseId];
    sequence.push({
      courseId: item.courseId,
      classIds: item.classIds,
      note: item.note ?? null,
      groupCode: null, // 主课程不进入替代组，否则会被自己挡住
    });
    if (!code) continue;
    for (const alt of altsOf(item.courseId)) {
      sequence.push({ courseId: alt.courseId, classIds: [], note: null, groupCode: code });
    }
  }
  return {
    preferences: sequence.map((entry, index) => ({ ...entry, globalRank: index + 1 })),
    // 组由服务端按 groupCode 归并并生成组名，这里只需声明编码
    groups: Object.entries(groupCodeOf.value).map(([, code]) => ({ code, name: '', note: null })),
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

watch([items, alternatives, groupCodeOf], markDirty, { deep: true });

/* ------------------------------ 数据加载 ------------------------------ */

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

    const draftItems: EditablePreference[] = (data.draft.preferences ?? []).map((pref) => ({
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
    alternatives.value = {};
    groupCodeOf.value = {};
    lastSavedAt.value = data.draft.updatedAt ?? null;
    validation.value = null;
    preview.value = null;
    validationError.value = '';
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
    await collapseAlternatives();
  } catch (error) {
    reportApiError(error, '读取志愿失败');
  } finally {
    hydrating.value = false;
    dirty.value = false;
    loading.value = false;
  }
}

/**
 * 草稿存储的是“扁平 + 组编码”，界面需要的是“主课程 + 折叠的备选”。
 * 同一组里排在最前面的课程作为主课程，其余折叠为备选。
 */
async function collapseAlternatives(): Promise<void> {
  const seen = new Map<string, number>();
  const keep: EditablePreference[] = [];
  const alts: Record<number, AltCourse[]> = {};
  const codes: Record<number, string> = {};

  for (const item of sortedItems()) {
    const code = item.groupCode;
    if (!code) {
      keep.push(item);
      continue;
    }
    const anchor = seen.get(code);
    if (anchor === undefined) {
      seen.set(code, item.courseId);
      keep.push(item);
      continue;
    }
    const list = alts[anchor] ?? [];
    list.push({
      courseId: item.courseId,
      courseCode: item.courseCode,
      courseName: item.courseName,
      credits: item.credits,
    });
    alts[anchor] = list;
    codes[anchor] = code;
  }

  items.value = keep;
  alternatives.value = alts;
  groupCodeOf.value = codes;
  normalizeRanks();

  // 备选课程的详情单独补一次（它们不再出现在 items 里）
  await Promise.all(allAlternatives().map((alt) => ensureCourseInfo(alt.courseId)));
  for (const list of Object.values(alternatives.value)) {
    for (const alt of list) {
      const info = courseCache[alt.courseId];
      if (info) {
        alt.courseCode = info.code;
        alt.courseName = info.name;
        alt.credits = info.credits;
      }
    }
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

/* ------------------------------ 第 1 步：选课 ------------------------------ */

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
  if (inDraft(course.id)) {
    toast.warning('这门课已经在清单里了', ['同一门课程只能出现一次；想换老师请调整它的教学班偏好。']);
    return;
  }
  const nextRank = items.value.length === 0 ? 1 : Math.max(...items.value.map((item) => item.globalRank)) + 1;
  courseCache[course.id] = { code: course.code, name: course.name, credits: course.credits };
  items.value.push({
    courseId: course.id,
    globalRank: nextRank,
    classIds: [],
    note: null,
    groupCode: null,
    courseCode: course.code,
    courseName: course.name,
    credits: course.credits,
  });
  toast.success(`已加入：${course.name}`);
  await ensureCourseInfo(course.id);
}

function removePreference(index: number): void {
  const list = sortedItems();
  const removed = list[index];
  if (!removed) return;
  list.splice(index, 1);

  // 主课程被移除时，它的第一个备选升为新的主课程，其余保留为备选
  const alts = altsOf(removed.courseId);
  const code = groupCodeOf.value[removed.courseId];
  if (alts.length > 0 && code) {
    const [promoted, ...rest] = alts;
    list.splice(index, 0, {
      courseId: promoted.courseId,
      globalRank: 0,
      classIds: [],
      note: null,
      groupCode: code,
      courseCode: promoted.courseCode,
      courseName: promoted.courseName,
      credits: promoted.credits,
    });
    if (rest.length > 0) {
      alternatives.value[promoted.courseId] = rest;
      groupCodeOf.value[promoted.courseId] = code;
    }
  }
  const restAlts = { ...alternatives.value };
  delete restAlts[removed.courseId];
  alternatives.value = restAlts;
  const restCodes = { ...groupCodeOf.value };
  delete restCodes[removed.courseId];
  groupCodeOf.value = restCodes;

  items.value = list;
  normalizeRanks();
  preview.value = null;
}

function normalizeRanks(): void {
  sortedItems().forEach((item, index) => {
    item.globalRank = index + 1;
  });
}

/* ------------------------------ 第 2 步：排顺序 ------------------------------ */

function applyOrder(list: EditablePreference[]): void {
  list.forEach((item, position) => {
    item.globalRank = position + 1;
  });
  items.value = list;
  preview.value = null;
}

function move(index: number, delta: number): void {
  const target = index + delta;
  const list = sortedItems();
  if (target < 0 || target >= list.length) return;
  const [moved] = list.splice(index, 1);
  list.splice(target, 0, moved);
  applyOrder(list);
}

function onDragStart(index: number, event: DragEvent): void {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // Firefox 需要写入数据才会真正开始拖拽
    event.dataTransfer.setData('text/plain', String(index));
  }
}

function onDragOver(index: number, event: DragEvent): void {
  event.preventDefault();
  if (dragIndex.value === null || dragIndex.value === index) return;
  dragOverIndex.value = index;
}

function onDrop(index: number): void {
  const from = dragIndex.value;
  dragIndex.value = null;
  dragOverIndex.value = null;
  if (from === null || from === index) return;
  const list = sortedItems();
  const [moved] = list.splice(from, 1);
  list.splice(index, 0, moved);
  applyOrder(list);
}

function onDragEnd(): void {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

/* --------------------------- 备选（替代组）管理 --------------------------- */

function openAltPicker(courseId: number): void {
  altPickerFor.value = altPickerFor.value === courseId ? null : courseId;
  altKeyword.value = '';
  altResults.value = [];
}

async function searchAlternatives(): Promise<void> {
  altLoading.value = true;
  try {
    const data = await api.get<{ items: CourseDto[] }>('/courses', {
      keyword: altKeyword.value.trim() || undefined,
      pageSize: 20,
    });
    altResults.value = data.items.filter((course) => !inDraft(course.id));
  } catch (error) {
    reportApiError(error, '搜索课程失败');
  } finally {
    altLoading.value = false;
  }
}

async function addAlternative(main: EditablePreference, course: CourseDto): Promise<void> {
  if (inDraft(course.id)) {
    toast.warning('这门课已经在清单里了');
    return;
  }
  courseCache[course.id] = { code: course.code, name: course.name, credits: course.credits };
  const list = [...altsOf(main.courseId), {
    courseId: course.id,
    courseCode: course.code,
    courseName: course.name,
    credits: course.credits,
  }];
  alternatives.value = { ...alternatives.value, [main.courseId]: list };
  if (!groupCodeOf.value[main.courseId]) {
    groupCodeOf.value = { ...groupCodeOf.value, [main.courseId]: nextGroupCode() };
  }
  altPickerFor.value = null;
  preview.value = null;
  toast.success(`已加入备选：${course.name}`, [`如果「${main.courseName}」选不上，系统会尝试这一门。`]);
  await ensureCourseInfo(course.id);
}

function removeAlternative(mainCourseId: number, alt: AltCourse): void {
  const list = altsOf(mainCourseId).filter((item) => item.courseId !== alt.courseId);
  const next = { ...alternatives.value };
  if (list.length === 0) {
    delete next[mainCourseId];
    const codes = { ...groupCodeOf.value };
    delete codes[mainCourseId];
    groupCodeOf.value = codes;
  } else {
    next[mainCourseId] = list;
  }
  alternatives.value = next;
  preview.value = null;
}

/** 解散备选关系：备选课程变成独立的志愿，排在主课程之后 */
function dissolveGroup(mainCourseId: number): void {
  const alts = altsOf(mainCourseId);
  const list = sortedItems();
  const mainIndex = list.findIndex((item) => item.courseId === mainCourseId);
  const promoted: EditablePreference[] = alts.map((alt) => ({
    courseId: alt.courseId,
    globalRank: 0,
    classIds: [],
    note: null,
    groupCode: null,
    courseCode: alt.courseCode,
    courseName: alt.courseName,
    credits: alt.credits,
  }));
  list.splice(mainIndex + 1, 0, ...promoted);

  const next = { ...alternatives.value };
  delete next[mainCourseId];
  alternatives.value = next;
  const codes = { ...groupCodeOf.value };
  delete codes[mainCourseId];
  groupCodeOf.value = codes;

  items.value = list;
  normalizeRanks();
  preview.value = null;
}

/* ------------------------------ 教学班偏好 ------------------------------ */

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

function onClassSelect(item: EditablePreference, event: Event): void {
  const select = event.target as HTMLSelectElement | null;
  if (!select) return;
  const value = Number(select.value);
  select.value = '';
  addClassChoice(item, value);
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
  const found = (classCache[item.courseId] ?? []).find((cls) => cls.id === classId);
  return found ? found.classCode : `教学班 ${classId}`;
}

/* ------------------------------ 校验与预演 ------------------------------ */

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
  try {
    const result = await api.post<ValidationResult>('/preferences/validate', {
      batchId: batchId.value,
      ...serialize(),
    });
    validation.value = result;
    if (showToast) {
      if (result.ok) {
        toast.success('检查通过', [`计划 ${result.creditPlan.plannedCredits} 学分 / 上限 ${result.creditPlan.creditLimit}`]);
      } else {
        toast.error('还有问题需要处理', result.issues.filter((i) => i.level === 'error').map((i) => i.message));
      }
    }
  } catch (error) {
    reportApiError(error, '校验失败');
  }
}

async function runPreview(): Promise<void> {
  if (batchId.value === null || items.value.length === 0) return;
  previewing.value = true;
  validationError.value = '';
  try {
    await validateDraft(false);
    const result = await api.post<PreferencePreview>('/preferences/preview', {
      batchId: batchId.value,
      ...serialize(),
    });
    preview.value = result;
  } catch (error) {
    validationError.value = error instanceof Error ? error.message : '预演失败';
    reportApiError(error, '预演失败');
  } finally {
    previewing.value = false;
  }
}

async function gotoStep(target: number): Promise<void> {
  if (target === 3 && !canSubmit.value) {
    if (items.value.length === 0) {
      toast.warning('清单是空的', ['请先在第 1 步加入至少一门课程。']);
      return;
    }
    if (errors.value.length > 0) {
      toast.warning('还不能提交', errors.value.map((issue) => issue.message));
      return;
    }
    if (overLimit.value) {
      toast.warning('学分超出上限', [`当前 ${formatCredits(totalCredits.value)} 学分，上限 ${formatCredits(creditLimit.value)}。`]);
      return;
    }
  }
  step.value = target;
  if (target === 2 && items.value.length > 0) {
    await Promise.all(items.value.map((item) => loadClasses(item.courseId)));
  }
  if (target === 3) await runPreview();
}

/* ------------------------------ 提交与撤回 ------------------------------ */

async function submitPreferences(): Promise<void> {
  if (batchId.value === null) return;
  const ok = await askConfirm({
    title: '提交志愿',
    message: '提交后生成一个不可变的新版本，截止时以最后一次成功提交的完整版本为准；提交失败会保留旧版本。',
    details: [
      `共 ${items.value.length} 门课程，计划 ${formatCredits(totalCredits.value)} 学分`,
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

function onBatchChange(): void {
  if (batchId.value !== null) void loadBatch(batchId.value);
}

/* --------------------- 面向界面的需求说明（不显示 D 级字母） --------------------- */

function attemptFor(courseId: number): PreviewAttempt | null {
  return preview.value?.attempts.find((attempt) => attempt.courseId === courseId) ?? null;
}

/** 优先使用预演的结论，其次使用校验阶段返回的需求提示 */
function demandInfo(courseId: number): { tone: 'critical' | 'warn' | 'muted'; label: string; detail: string } {
  const attempt = attemptFor(courseId);
  if (attempt) {
    const [label, ...rest] = attempt.demandText.split(' · ');
    return { tone: demandTone(attempt.demandLevel), label, detail: rest.join(' · ') };
  }
  const hint = validation.value?.demandHints.find((row) => row.courseId === courseId);
  if (hint) {
    const reason = hint.reasons.find((r) => r.trim().length > 0) ?? '';
    return { tone: demandTone(hint.demandLevel), label: demandLabelOf(hint.demandLevel), detail: reason };
  }
  return { tone: 'muted', label: '待检查', detail: '进入第 3 步后给出培养需求说明' };
}

function demandLabelOf(level: string): string {
  if (level === 'D2') return '本期必须完成';
  if (level === 'D1') return '建议补足';
  return '兴趣课程';
}

function demandBadgeClass(tone: 'critical' | 'warn' | 'muted'): string {
  if (tone === 'critical') return 'badge badge--danger';
  if (tone === 'warn') return 'badge badge--warn';
  return 'badge badge--muted';
}

function memberDemand(courseId: number): { tone: 'critical' | 'warn' | 'muted'; label: string } {
  const attempt = attemptFor(courseId);
  if (attempt) {
    const [label] = attempt.demandText.split(' · ');
    return { tone: demandTone(attempt.demandLevel), label };
  }
  return { tone: 'muted', label: '备选' };
}

function issuesForCourse(courseId: number): ValidationIssue[] {
  return validation.value?.issues.filter((issue) => issue.courseId === courseId) ?? [];
}

onMounted(loadBatches);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">志愿填报</h1>
        <p class="page__desc">
          只需要三步：勾选想上的课 → 拖动排出顺序 → 看一眼预演再提交。名次、备选关系与培养需求由系统自动处理。
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

    <!-- 批次状态 -->
    <section v-if="batch" class="card">
      <div class="inline">
        <span class="badge badge--muted">{{ batch.name }}</span>
        <span class="badge">{{ batchStatusLabel(batch.status) }}</span>
        <span class="badge">学分上限 {{ formatCredits(batch.creditLimit) }}</span>
        <span class="badge">开放 {{ formatDateTime(batch.openAt) }}</span>
        <span class="badge">截止 {{ formatDateTime(batch.closeAt) }}</span>
        <span class="spacer"></span>
        <span v-if="payload?.view.status === 'submitted'" class="badge badge--ok">已提交 v{{ payload.view.versionNo }}</span>
        <span v-else-if="payload?.view.status === 'withdrawn'" class="badge badge--muted">已撤回</span>
        <span v-else class="badge badge--warn">尚未提交</span>
      </div>
      <p v-if="!canEdit" class="alert alert--warning" style="margin-top: 10px">
        当前批次状态为「{{ batchStatusLabel(batch.status) }}」，只有「预览开放」与「正式受理」阶段可以修改并提交志愿。
      </p>
      <p v-if="!batch.configReady" class="alert alert--warning" style="margin-top: 8px">
        批次必需配置缺失：{{ batch.configIssues.join('；') }}
      </p>
      <div class="inline" style="margin-top: 8px">
        <span class="muted small">
          草稿：{{ dirty ? '有未保存修改（自动保存中）' : saving ? '保存中…' : '已同步' }} · 最近保存
          {{ formatDateTime(lastSavedAt) }}
        </span>
      </div>
      <div v-if="draftDiff.changed" class="alert alert--warning" style="margin-top: 10px">
        <strong>草稿与已提交版本（v{{ payload?.view.versionNo }}）不一致——未提交的修改不会参与本轮分配</strong>
        <ul>
          <li v-for="row in draftDiff.rows" :key="row.courseId">{{ row.courseName }}：{{ row.detail }}</li>
        </ul>
      </div>
    </section>

    <!-- 步骤条 -->
    <nav class="wizard-steps">
      <button
        v-for="(label, index) in stepLabels"
        :key="label"
        class="wizard-steps__item"
        :class="{ 'wizard-steps__item--active': step === index + 1, 'wizard-steps__item--done': step > index + 1 }"
        type="button"
        @click="gotoStep(index + 1)"
      >
        <span class="wizard-steps__index">{{ index + 1 }}</span>
        <span>{{ label }}</span>
      </button>
      <span class="spacer"></span>
      <span class="muted small">
        已选 {{ items.length }} 门 / {{ formatCredits(totalCredits) }} 学分
        <template v-if="creditLimit !== null">（上限 {{ formatCredits(creditLimit) }}）</template>
      </span>
    </nav>

    <!-- ===================== 第 1 步：选课 ===================== -->
    <section v-show="step === 1" class="card">
      <div class="card__header">
        <h3 class="card__title">第 1 步 · 勾选想上的课程</h3>
        <span class="muted small">这一步不用排顺序，先把想上的都加进来</span>
      </div>

      <div class="grid grid--2">
        <div class="card card--flat">
          <h4 class="card__title">课程检索</h4>
          <div class="inline">
            <input
              v-model="courseSearchKeyword"
              class="input"
              type="text"
              placeholder="课程名或课程号"
              @keyup.enter="searchCourses"
            />
            <button class="btn btn--primary btn--sm" type="button" :disabled="searchingCourses" @click="searchCourses">
              {{ searchingCourses ? '搜索中…' : '搜索' }}
            </button>
          </div>
          <p v-if="courseSearchResults.length === 0" class="muted small" style="margin-top: 8px">
            输入关键词后回车即可搜索。
          </p>
          <div v-else class="list" style="margin-top: 8px">
            <div v-for="course in courseSearchResults" :key="course.id" class="list__item">
              <div class="inline">
                <span class="mono small">{{ course.code }}</span>
                <span>{{ course.name }}</span>
                <span class="badge">{{ formatCredits(course.credits) }} 学分</span>
                <span class="spacer"></span>
                <button class="btn btn--sm btn--primary" type="button" :disabled="inDraft(course.id)" @click="addCourse(course)">
                  {{ inDraft(course.id) ? '已在清单' : '加入' }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="card card--flat">
          <div class="card__header">
            <h4 class="card__title">待排清单（{{ items.length }} 门）</h4>
            <button class="btn btn--primary btn--sm" type="button" :disabled="items.length === 0" @click="gotoStep(2)">
              下一步：排顺序
            </button>
          </div>
          <p v-if="items.length === 0" class="muted">还没有加入任何课程。左侧搜索后点“加入”。</p>
          <div v-else class="list">
            <div v-for="(item, index) in sortedItems()" :key="item.courseId" class="list__item">
              <div class="inline">
                <div style="flex: 1">
                  <strong>{{ item.courseName }}</strong>
                  <span class="mono small">{{ item.courseCode }}</span>
                  <span class="badge">{{ formatCredits(item.credits) }} 学分</span>
                </div>
                <button class="btn btn--sm btn--danger" type="button" @click="removePreference(index)">移除</button>
              </div>
              <div class="small muted" style="margin-top: 4px">
                <span :class="demandBadgeClass(demandInfo(item.courseId).tone)">
                  {{ demandInfo(item.courseId).label }}
                </span>
                {{ demandInfo(item.courseId).detail }}
              </div>
            </div>
          </div>
          <p v-if="overLimit" class="alert alert--error" style="margin-top: 10px">
            当前合计 {{ formatCredits(totalCredits) }} 学分，已超过上限 {{ formatCredits(creditLimit) }}，请先移除部分课程。
          </p>
        </div>
      </div>
    </section>

    <!-- ===================== 第 2 步：排顺序 ===================== -->
    <section v-show="step === 2" class="card">
      <div class="card__header">
        <h3 class="card__title">第 2 步 · 排出你的优先顺序</h3>
        <div class="inline">
          <button class="btn btn--ghost btn--sm" type="button" @click="gotoStep(1)">上一步</button>
          <button class="btn btn--primary btn--sm" type="button" :disabled="items.length === 0" @click="gotoStep(3)">
            下一步：看预演
          </button>
        </div>
      </div>
      <p class="tips">
        从上到下的顺序就是“第几志愿”，序号由系统自动生成，不需要手填、也不会重复。
        拖动左侧手柄即可调整；「加备选」表示“这一门选不上时，试试那一门”（同一组只会落实一门）。
      </p>

      <div v-if="items.length === 0" class="empty">清单是空的，请先回到第 1 步加入课程。</div>

      <ol v-else class="rank-list">
        <li
          v-for="(item, index) in sortedItems()"
          :key="item.courseId"
          class="rank-item"
          :class="{ 'rank-item--dragging': dragIndex === index, 'rank-item--over': dragOverIndex === index }"
          draggable="true"
          @dragstart="onDragStart(index, $event)"
          @dragover="onDragOver(index, $event)"
          @drop="onDrop(index)"
          @dragend="onDragEnd"
        >
          <span class="rank-item__handle" title="拖动调整顺序">≡</span>
          <span class="rank-item__badge">{{ index + 1 }}</span>

          <div class="rank-item__body">
            <div class="inline">
              <strong>{{ item.courseName }}</strong>
              <span class="mono small">{{ item.courseCode }}</span>
              <span class="badge">{{ formatCredits(item.credits) }} 学分</span>
              <span :class="demandBadgeClass(demandInfo(item.courseId).tone)">{{ demandInfo(item.courseId).label }}</span>
              <span class="spacer"></span>
              <button class="btn btn--sm btn--ghost" type="button" :disabled="index === 0" @click="move(index, -1)">↑</button>
              <button
                class="btn btn--sm btn--ghost"
                type="button"
                :disabled="index === sortedItems().length - 1"
                @click="move(index, 1)"
              >
                ↓
              </button>
            </div>
            <div class="small muted" style="margin-top: 4px">{{ demandInfo(item.courseId).detail }}</div>

            <!-- 备选 -->
            <div v-if="altsOf(item.courseId).length > 0" class="alt-list">
              <div class="small muted">这一门选不上时，依次尝试：</div>
              <div v-for="alt in altsOf(item.courseId)" :key="alt.courseId" class="inline" style="margin-top: 4px">
                <span class="alt-list__mark">↳</span>
                <span>{{ alt.courseName }}</span>
                <span class="mono small">{{ alt.courseCode }}</span>
                <span class="badge">{{ formatCredits(alt.credits) }} 学分</span>
                <span :class="demandBadgeClass(memberDemand(alt.courseId).tone)">{{ memberDemand(alt.courseId).label }}</span>
                <span class="spacer"></span>
                <button class="btn btn--sm btn--ghost" type="button" @click="removeAlternative(item.courseId, alt)">移除备选</button>
              </div>
              <button class="btn btn--sm btn--ghost" type="button" style="margin-top: 4px" @click="dissolveGroup(item.courseId)">
                解散备选关系
              </button>
            </div>

            <div class="inline" style="margin-top: 6px">
              <button class="btn btn--sm btn--ghost" type="button" @click="openAltPicker(item.courseId)">
                {{ altPickerFor === item.courseId ? '收起' : '加备选' }}
              </button>
              <button class="btn btn--sm btn--ghost" type="button" @click="loadClasses(item.courseId)">教学班偏好</button>
              <button class="btn btn--sm btn--danger" type="button" @click="removePreference(index)">移除</button>
            </div>

            <!-- 备选选择器 -->
            <div v-if="altPickerFor === item.courseId" class="card card--flat" style="margin-top: 8px">
              <div class="small muted">选一门“这门选不上时想顶上”的课程：</div>
              <div class="inline" style="margin-top: 6px">
                <input v-model="altKeyword" class="input" type="text" placeholder="课程名或课程号" @keyup.enter="searchAlternatives" />
                <button class="btn btn--primary btn--sm" type="button" :disabled="altLoading" @click="searchAlternatives">
                  {{ altLoading ? '搜索中…' : '搜索' }}
                </button>
              </div>
              <div v-if="altResults.length > 0" class="list" style="margin-top: 6px">
                <div v-for="course in altResults" :key="course.id" class="list__item">
                  <div class="inline">
                    <span class="mono small">{{ course.code }}</span>
                    <span>{{ course.name }}</span>
                    <span class="badge">{{ formatCredits(course.credits) }} 学分</span>
                    <span class="spacer"></span>
                    <button class="btn btn--sm btn--primary" type="button" @click="addAlternative(item, course)">设为备选</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 教学班偏好 -->
            <div v-if="classCache[item.courseId]" style="margin-top: 8px">
              <span class="field__label">教学班偏好（从上到下为优先顺序，可不填）</span>
              <div v-if="item.classIds.length === 0" class="muted small">未指定：系统会在有空位且不冲突的班里自行选择。</div>
              <div v-else class="inline">
                <span v-for="(classId, classIndex) in item.classIds" :key="classId" class="badge">
                  {{ classIndex + 1 }}. {{ className(item, classId) }}
                  <button class="btn btn--sm btn--ghost" type="button" @click="moveClassChoice(item, classIndex, -1)">↑</button>
                  <button class="btn btn--sm btn--ghost" type="button" @click="moveClassChoice(item, classIndex, 1)">↓</button>
                  <button class="btn btn--sm btn--ghost" type="button" @click="removeClassChoice(item, classId)">×</button>
                </span>
              </div>
              <div class="inline" style="margin-top: 6px">
                <select class="select" style="max-width: 460px" @change="onClassSelect(item, $event)">
                  <option value="">添加教学班…</option>
                  <option v-for="cls in classCache[item.courseId] ?? []" :key="cls.id" :value="cls.id">
                    {{ cls.classCode }} · {{ cls.sessions.map((s) => s.text).join('；') }} · 余 {{ cls.generalAvailable }}
                  </option>
                </select>
              </div>
            </div>

            <ul v-if="issuesForCourse(item.courseId).length > 0" class="reason-list">
              <li v-for="(issue, issueIndex) in issuesForCourse(item.courseId)" :key="issueIndex">
                {{ issue.level === 'error' ? '需要处理' : '提示' }}：{{ issue.message }}
              </li>
            </ul>
          </div>
        </li>
      </ol>
    </section>

    <!-- ===================== 第 3 步：预演并提交 ===================== -->
    <section v-show="step === 3" class="card">
      <div class="card__header">
        <h3 class="card__title">第 3 步 · 看一眼预演再提交</h3>
        <div class="inline">
          <button class="btn btn--ghost btn--sm" type="button" :disabled="previewing" @click="runPreview">
            {{ previewing ? '预演中…' : '重新预演' }}
          </button>
          <button class="btn btn--ghost btn--sm" type="button" @click="gotoStep(2)">调整顺序</button>
        </div>
      </div>

      <p v-if="validationError" class="alert alert--error">{{ validationError }}</p>
      <p v-if="previewing && !preview" class="muted">正在按你的顺序试排课表…</p>

      <template v-if="preview">
        <div class="inline" style="margin-bottom: 10px">
          <span class="badge badge--ok">可排入 {{ preview.summary.feasible }} 门</span>
          <span v-if="preview.summary.conflict > 0" class="badge badge--danger">冲突 {{ preview.summary.conflict }} 门</span>
          <span v-if="preview.summary.noSeat > 0" class="badge badge--warn">名额已满 {{ preview.summary.noSeat }} 门</span>
          <span v-if="preview.summary.overLimit > 0" class="badge badge--danger">超学分 {{ preview.summary.overLimit }} 门</span>
          <span v-if="preview.summary.noClass > 0" class="badge badge--warn">未开课 {{ preview.summary.noClass }} 门</span>
          <span class="spacer"></span>
          <span class="badge" :class="preview.overLimit ? 'badge--danger' : ''">
            合计 {{ formatCredits(preview.credits) }} / 上限 {{ formatCredits(preview.creditLimit) }} 学分
          </span>
        </div>

        <div class="grid grid--2">
          <div class="stack">
            <h4 class="card__title">按这个顺序，课表会是这样</h4>
            <TimetableGrid :entries="preview.entries" />
          </div>

          <div class="stack">
            <h4 class="card__title">系统会怎么尝试你的每一门志愿</h4>
            <ol class="attempt-list">
              <li v-for="attempt in preview.attempts" :key="attempt.courseId" class="attempt-item">
                <div class="inline">
                  <span class="rank-item__badge">{{ attempt.rank }}</span>
                  <strong>{{ attempt.courseName }}</strong>
                  <span :class="previewStatusClass(attempt.status)">{{ previewStatusLabel(attempt.status) }}</span>
                  <span v-if="attempt.classCode" class="mono small">{{ attempt.classCode }}</span>
                </div>
                <div class="small" style="margin-top: 4px">{{ attempt.reason }}</div>
                <div v-if="attempt.conflictText" class="small muted" style="margin-top: 2px">{{ attempt.conflictText }}</div>
                <div v-if="attempt.status !== 'feasible' && attempt.optionTexts.length > 0" class="small muted" style="margin-top: 2px">
                  可选教学班：{{ attempt.optionTexts.slice(0, 3).join('；') }}
                </div>
              </li>
            </ol>

            <div class="alert alert--info">
              <ul>
                <li v-for="(note, noteIndex) in preview.notes" :key="noteIndex">{{ note }}</li>
              </ul>
            </div>
          </div>
        </div>
      </template>

      <div class="submit-bar">
        <div class="stack" style="gap: 2px">
          <strong>
            共 {{ items.length }} 门课程，计划 {{ formatCredits(totalCredits) }} 学分
            <template v-if="creditLimit !== null">（上限 {{ formatCredits(creditLimit) }}）</template>
          </strong>
          <span v-if="dirty" class="small submit-bar__warn">草稿还有未保存的修改，建议先保存再提交</span>
          <span v-else class="small muted">草稿已同步</span>
        </div>
        <span class="spacer"></span>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="saving || batchId === null" @click="saveDraft(false)">
          {{ saving ? '保存中…' : '保存草稿' }}
        </button>
        <button class="btn btn--primary" type="button" :disabled="submitting || !canSubmit" @click="submitPreferences">
          {{ submitting ? '提交中…' : '确认提交志愿' }}
        </button>
      </div>

      <div v-if="errors.length > 0" class="alert alert--error" style="margin-top: 10px">
        <strong>提交前需要先处理：</strong>
        <ul>
          <li v-for="(issue, index) in errors" :key="index">{{ issue.message }}</li>
        </ul>
      </div>
    </section>

    <!-- ===================== 高级与详情 ===================== -->
    <section class="card">
      <div class="card__header">
        <h3 class="card__title">高级与详情</h3>
        <button class="btn btn--ghost btn--sm" type="button" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '收起' : '展开' }}
        </button>
      </div>

      <template v-if="showAdvanced">
        <h4 class="card__title">当前提交版本</h4>
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
                  <th>志愿</th>
                  <th>课程</th>
                  <th>学分</th>
                  <th>备选关系</th>
                  <th>教学班偏好</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in payload.view.items" :key="item.preferenceId">
                  <td>{{ item.globalRank }}</td>
                  <td>{{ item.courseName }}<span class="mono small">（{{ item.courseCode }}）</span></td>
                  <td>{{ formatCredits(item.credits) }}</td>
                  <td>{{ item.groupName || '—' }}</td>
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
        <p v-else class="muted">该批次还没有提交记录。</p>

        <h4 class="card__title" style="margin-top: 14px">校验结果</h4>
        <div v-if="validation">
          <span class="badge" :class="validation.ok ? 'badge--ok' : 'badge--danger'">
            {{ validation.ok ? '可以提交' : '存在错误，不能提交' }}
          </span>
          <div v-if="errors.length > 0" class="alert alert--error" style="margin-top: 8px">
            <ul>
              <li v-for="(issue, index) in errors" :key="index">[{{ issue.code }}] {{ issue.message }}</li>
            </ul>
          </div>
          <div v-if="warnings.length > 0" class="alert alert--warning" style="margin-top: 8px">
            <ul>
              <li v-for="(issue, index) in warnings" :key="index">[{{ issue.code }}] {{ issue.message }}</li>
            </ul>
          </div>
          <p v-if="errors.length === 0 && warnings.length === 0" class="muted small">没有发现问题。</p>
        </div>
        <p v-else class="muted small">还没有检查过。进入第 3 步会自动检查。</p>

        <h4 class="card__title" style="margin-top: 14px">固定随机键</h4>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loadingKeys || batchId === null" @click="loadRandomKeys">
          {{ loadingKeys ? '读取中…' : '查看随机键' }}
        </button>
        <p class="tips">
          随机键在首次提交时固定，用于“同需求等级、同志愿排名”时的最终排序。重交、重试、退出后重新加入都不会重抽。
        </p>
        <div v-if="randomKeys.length > 0" class="table-wrap">
          <table class="table table--compact">
            <thead>
              <tr>
                <th>课程</th>
                <th>学期</th>
                <th>随机键</th>
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

        <h4 class="card__title" style="margin-top: 14px">撤回志愿</h4>
        <p class="muted small">撤回只让当前有效提交失效（草稿保留），随机键不会被重新抽取。</p>
        <button class="btn btn--danger btn--sm" type="button" :disabled="withdrawing || !canEdit" @click="withdraw">
          {{ withdrawing ? '撤回中…' : '撤回志愿' }}
        </button>
      </template>
    </section>
  </div>
</template>

<style scoped>
.wizard-steps {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0;
  flex-wrap: wrap;
}

.wizard-steps__item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid #d8dce5;
  border-radius: 999px;
  background: #fff;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
}

.wizard-steps__item--active {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

.wizard-steps__item--done {
  border-color: #16a34a;
}

.wizard-steps__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.08);
  font-size: 12px;
  font-weight: 600;
}

.wizard-steps__item--active .wizard-steps__index {
  background: rgba(255, 255, 255, 0.28);
}

.rank-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rank-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid #d8dce5;
  border-radius: 10px;
  background: #fff;
}

.rank-item--dragging {
  opacity: 0.45;
}

.rank-item--over {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.18);
}

.rank-item__handle {
  cursor: grab;
  font-size: 18px;
  line-height: 1.2;
  color: #94a3b8;
  user-select: none;
}

.rank-item__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
  font-size: 12px;
  font-weight: 600;
}

.rank-item__body {
  flex: 1;
  min-width: 0;
}

.alt-list {
  margin-top: 6px;
  padding: 8px 10px;
  border-left: 3px solid #c7d2fe;
  background: #f8faff;
  border-radius: 0 8px 8px 0;
}

.alt-list__mark {
  color: #6366f1;
}

.attempt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attempt-item {
  padding: 8px 10px;
  border: 1px solid #d8dce5;
  border-radius: 8px;
  background: #fff;
}

.submit-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid #d8dce5;
  border-radius: 10px;
  background: #f8fafc;
  flex-wrap: wrap;
}

.submit-bar__warn {
  color: #b45309;
}
</style>

