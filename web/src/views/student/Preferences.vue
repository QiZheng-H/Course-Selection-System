<script setup lang="ts">
/**
 * 志愿填报向导：① 选课 → ② 排顺序 → ③ 预演并提交。
 *
 * 设计原则（面向第一次使用的学生）：
 *   - 学生只做三件事：勾课、拖顺序、确认。所有编号、备选组编码、需求等级翻译都由系统完成；
 *   - “全局排名”等于列表位置，界面上只读，因此不可能重复、也不会出现空洞；
 *   - “替代组”以「加备选」的方式表达，学生不需要理解组这个概念；
 *   - 提交前给出课表预演：会排成什么样、哪一门排不进、被谁挡住。
 *
 * 规则层的唯一真值仍在后端（preferences.global_rank / preference_groups 数据结构不变），
 * 这里只是换一种更好懂的表达方式。
 */
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

/** 备用组内的课程不单独参与全局排序，因此额外记录一份信息 */
interface GroupMember {
  groupCode: string;
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
const groups = ref<DraftGroup[]>([]);
const groupMembers = ref<GroupMember[]>([]);

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

/** 备选课程选择器当前展开在哪一行 */
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
  kind: 'added' | 'removed' | 'rank' | 'classes' | 'group';
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

  for (const [courseId, item] of draftByCourse) {
    const submitted = submittedByCourse.get(courseId);
    if (!submitted) {
      rows.push({ courseId, courseName: item.courseName, kind: 'added', detail: `草稿新增（第 ${item.globalRank} 志愿）` });
      continue;
    }
    if (submitted.globalRank !== item.globalRank) {
      rows.push({
        courseId,
        courseName: item.courseName,
        kind: 'rank',
        detail: `志愿顺序 第 ${submitted.globalRank} → 第 ${item.globalRank}`,
      });
    }
    const submittedClasses = submitted.classChoices.map((choice) => choice.classId);
    if (JSON.stringify(submittedClasses) !== JSON.stringify(item.classIds)) {
      rows.push({
        courseId,
        courseName: item.courseName,
        kind: 'classes',
        detail: '教学班偏好有变化',
      });
    }
    const submittedGroup = submitted.groupCode ?? '';
    const draftGroup = item.groupCode ?? '';
    if (submittedGroup !== draftGroup) {
      rows.push({ courseId, courseName: item.courseName, kind: 'group', detail: '备选关系有变化' });
    }
  }
  for (const [courseId, submitted] of submittedByCourse) {
    if (!draftByCourse.has(courseId) && !groupMembers.value.some((member) => member.courseId === courseId)) {
      rows.push({
        courseId,
        courseName: submitted.courseName,
        kind: 'removed',
        detail: `草稿已移除（已提交版本为第 ${submitted.globalRank} 志愿）`,
      });
    }
  }
  return { changed: rows.length > 0, rows };
});

/* ------------------------------ 备选（替代组） ------------------------------ */

function membersOf(groupCode: string): GroupMember[] {
  return groupMembers.value.filter((member) => member.groupCode === groupCode);
}

function mainOf(groupCode: string): EditablePreference | undefined {
  return items.value.find((item) => item.groupCode === groupCode);
}

/** 该课程是否已经在草稿里（作为志愿或备选） */
function inDraft(courseId: number): boolean {
  return items.value.some((item) => item.courseId === courseId) || groupMembers.value.some((m) => m.courseId === courseId);
}

function nextGroupCode(): string {
  let index = groups.value.length + 1;
  let code = `ALT${index}`;
  while (groups.value.some((group) => group.code === code)) {
    index += 1;
    code = `ALT${index}`;
  }
  return code;
}

/* ------------------------------ 序列化与保存 ------------------------------ */

function sortedItems(): EditablePreference[] {
  return [...items.value].sort((a, b) => a.globalRank - b.globalRank);
}

function serialize() {
  // 备用组课程不单独出现在 preferences 里：它们通过 groupCode 挂到主课程所在的组，
  // 但规则要求“志愿里的每门课程都要有排名”，因此备选也按排在主课程之后的位置登记。
  const sequence: Array<{ courseId: number; classIds: number[]; note: string | null; groupCode: string | null }> = [];
  for (const item of sortedItems()) {
    sequence.push({
      courseId: item.courseId,
      classIds: item.classIds,
      note: item.note ?? null,
      groupCode: item.groupCode ?? null,
    });
    if (item.groupCode) {
      for (const member of membersOf(item.groupCode)) {
        sequence.push({ courseId: member.courseId, classIds: [], note: null, groupCode: item.groupCode });
      }
    }
  }
  return {
    preferences: sequence.map((entry, index) => ({ ...entry, globalRank: index + 1 })),
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

watch([items, groups, groupMembers], markDirty, { deep: true });

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
    groupMembers.value = [];
    lastSavedAt.value = draft.updatedAt ?? null;
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
    // 备用组课程在草稿里也是普通志愿，按同组把它们折叠回主课程下面
    collapseGroupMembers();
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
 * 每组排在最前面的课程作为主课程，其余折叠为备选。
 */
function collapseGroupMembers(): void {
  const members: GroupMember[] = [];
  const keep: EditablePreference[] = [];
  const seenGroup = new Set<string>();
  for (const item of sortedItems()) {
    const code = item.groupCode;
    if (!code) {
      keep.push(item);
      continue;
    }
    if (!seenGroup.has(code)) {
      seenGroup.add(code);
      keep.push(item);
      continue;
    }
    members.push({
      groupCode: code,
      courseId: item.courseId,
      courseCode: item.courseCode,
      courseName: item.courseName,
      credits: item.credits,
    });
  }
  items.value = keep;
  groupMembers.value = members;
  normalizeRanks();
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
  const [removed] = items.value.splice(index, 1);
  if (removed?.groupCode) {
    const remaining = membersOf(removed.groupCode);
    if (remaining.length === 0) {
      groups.value = groups.value.filter((group) => group.code !== removed.groupCode);
    } else {
      // 主课程没了：把第一个备选提升为新的主课程
      const promoted = remaining[0];
      groupMembers.value = groupMembers.value.filter((member) => member !== promoted);
      items.value.push({
        courseId: promoted.courseId,
        globalRank: removed.globalRank,
        classIds: [],
        note: null,
        groupCode: removed.groupCode,
        courseCode: promoted.courseCode,
        courseName: promoted.courseName,
        credits: promoted.credits,
      });
    }
  }
  normalizeRanks();
  preview.value = null;
}

function normalizeRanks(): void {
  sortedItems().forEach((item, index) => {
    item.globalRank = index + 1;
  });
}

/* ------------------------------ 第 2 步：排顺序 ------------------------------ */

function move(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= items.value.length) return;
  const list = sortedItems();
  const [moved] = list.splice(index, 1);
  list.splice(target, 0, moved);
  list.forEach((item, position) => {
    item.globalRank = position + 1;
  });
  items.value = list;
  preview.value = null;
}

function onDragStart(index: number, event: DragEvent): void {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // Firefox 需要设置数据才会触发拖拽
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
  list.forEach((item, position) => {
    item.globalRank = position + 1;
  });
  items.value = list;
  preview.value = null;
}

function onDragEnd(): void {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

/* --------------------------- 备选（替代组）管理 --------------------------- */

function openAltPicker(index: number): void {
  altPickerFor.value = altPickerFor.value === index ? null : index;
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

function addAlternative(main: EditablePreference, course: CourseDto): void {
  if (inDraft(course.id)) {
    toast.warning('这门课已经在清单里了');
    return;
  }
  let code = main.groupCode;
  if (!code) {
    code = nextGroupCode();
    main.groupCode = code;
    groups.value.push({ code, name: `${main.courseName} 或 …`, note: null });
  }
  courseCache[course.id] = { code: course.code, name: course.name, credits: course.credits };
  groupMembers.value.push({
    groupCode: code,
    courseId: course.id,
    courseCode: course.code,
    courseName: course.name,
    credits: course.credits,
  });
  syncGroupNames();
  altPickerFor.value = null;
  preview.value = null;
  toast.success(`已加入备选：${course.name}`, [`如果「${main.courseName}」选不上，系统会尝试这一门。`]);
}

function removeAlternative(member: GroupMember): void {
  groupMembers.value = groupMembers.value.filter((item) => item !== member);
  const main = mainOf(member.groupCode);
  if (main && membersOf(member.groupCode).length === 0) {
    main.groupCode = null;
    groups.value = groups.value.filter((group) => group.code !== member.groupCode);
  }
  syncGroupNames();
  preview.value = null;
}

function dissolveGroup(code: string): void {
  const main = mainOf(code);
  if (main) main.groupCode = null;
  for (const member of membersOf(code)) {
    items.value.push({
      courseId: member.courseId,
      globalRank: items.value.length + 1,
      classIds: [],
      note: null,
      groupCode: null,
      courseCode: member.courseCode,
      courseName: member.courseName,
      credits: member.credits,
    });
    void ensureCourseInfo(member.courseId);
  }
  groupMembers.value = groupMembers.value.filter((member) => member.groupCode !== code);
  groups.value = groups.value.filter((group) => group.code !== code);
  normalizeRanks();
  preview.value = null;
}

/** 组名自动跟随成员变化，学生不需要自己命名 */
function syncGroupNames(): void {
  for (const group of groups.value) {
    const main = mainOf(group.code);
    const names = [main?.courseName, ...membersOf(group.code).map((m) => m.courseName)].filter(Boolean) as string[];
    group.name = names.join(' 或 ');
  }
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
    if (errors.value.length > 0) {
      toast.warning('还不能提交', errors.value.map((issue) => issue.message));
      return;
    }
    if (items.value.length === 0) {
      toast.warning('清单是空的', ['请先在第 1 步加入至少一门课程。']);
      return;
    }
    if (overLimit.value) {
      toast.warning('学分超出上限', [`当前 ${formatCredits(totalCredits.value)} 学分，上限 ${formatCredits(creditLimit.value)}。`]);
      return;
    }
  }
  step.value = target;
  if (target === 3) await runPreview();
  if (target === 2 && items.value.length > 0) {
    await Promise.all(items.value.map((item) => loadClasses(item.courseId)));
  }
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
    const labels: Record<string, string> = { D2: '本期必须完成', D1: '建议补足', D0: '兴趣课程' };
    return { tone: demandTone(hint.demandLevel), label: labels[hint.demandLevel] ?? '—', detail: reason };
  }
  return { tone: 'muted', label: '待检查', detail: '进入预演后给出培养需求说明' };
}

/** 成员课程的需求说明（备用组内） */
function memberDemandInfo(courseId: number): { tone: 'critical' | 'warn' | 'muted'; label: string } {
  const attempt = attemptFor(courseId);
  if (attempt) {
    const [label] = attempt.demandText.split(' · ');
    return { tone: demandTone(attempt.demandLevel), label };
  }
  return { tone: 'muted', label: '备选' };
}

function availabilityFor(courseId: number): string {
  const attempt = attemptFor(courseId);
  if (attempt) {
    return `开放教学班余量 ${attempt.courseAvailable}`;
  }
  const row = validation.value?.availability.find((item) => item.courseId === courseId);
  return row ? `开放教学班 ${row.openClasses} 个 · 余量 ${row.totalAvailable}` : '';
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

    <!-- 批次状态条 -->
    <section v-if="batch" class="card">
      <div class="inline">
        <span class="badge badge--muted">{{ batch.name }}</span>
        <span class="badge">{{ batchStatusLabel(batch.status) }}</span>
        <span class="badge">学分上限 {{ formatCredits(batch.creditLimit) }}</span>
        <span class="badge">开放 {{ formatDateTime(batch.openAt) }}</span>
        <span class="badge">截止 {{ formatDateTime(batch.closeAt) }}</span>
      </div>
      <p v-if="!canEdit" class="alert alert--warning" style="margin-top: 10px">
        当前批次状态为「{{ batchStatusLabel(batch.status) }}」，只有「预览开放」与「正式受理」阶段可以修改并提交志愿。
      </p>
      <p v-if="!batch.configReady" class="alert alert--warning" style="margin-top: 8px">
        批次必需配置缺失：{{ batch.configIssues.join('；') }}
      </p>
      <div class="inline" style="margin-top: 10px">
        <span class="muted small">
          草稿：{{ dirty ? '有未保存修改（自动保存中）' : saving ? '保存中…' : '已同步' }} · 最近保存
          {{ formatDateTime(lastSavedAt) }}
        </span>
        <span v-if="payload?.view.status === 'submitted'" class="badge badge--ok">
          已提交 v{{ payload.view.versionNo }}
        </span>
        <span v-else-if="payload?.view.status === 'withdrawn'" class="badge badge--muted">已撤回</span>
        <span v-else class="badge badge--warn">尚未提交</span>
      </div>
      <div v-if="draftDiff.changed" class="alert alert--warning" style="margin-top: 10px">
        <strong>草稿与已提交版本（v{{ payload?.view.versionNo }}）不一致——未提交的修改不会参与本轮分配</strong>
        <ul>
          <li v-for="row in draftDiff.rows" :key="`${row.courseId}-${row.kind}`">{{ row.courseName }}：{{ row.detail }}</li>
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
        <div class="stack">
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
                  <button
                    class="btn btn--sm btn--primary"
                    type="button"
                    :disabled="inDraft(course.id)"
                    @click="addCourse(course)"
                  >
                    {{ inDraft(course.id) ? '已在清单' : '加入' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card card--flat">
            <div class="card__header">
              <h4 class="card__title">待排清单（{{ items.length }} 门）</h4>
              <button class="btn btn--primary btn--sm" type="button" :disabled="items.length === 0" @click="gotoStep(2)">
                下一步：排顺序
              </button>
            </div>
            <p v-if="items.length === 0" class="muted">还没有加入任何课程。左侧搜索后点“加入”。</p>
            <div v-else class="list">
              <div v-for="item in sortedItems()" :key="item.courseId" class="list__item">
                <div class="inline">
                  <div style="flex: 1">
                    <strong>{{ item.courseName }}</strong>
                    <span class="mono small">{{ item.courseCode }}</span>
                    <span class="badge">{{ formatCredits(item.credits) }} 学分</span>
                  </div>
                  <button class="btn btn--sm btn--danger" type="button" @click="removePreference(items.indexOf(item))">
                    移除
                  </button>
                </div>
                <div class="small muted" style="margin-top: 4px">
                  <span class="badge" :class="`badge--${demandInfo(item.courseId).tone === 'critical' ? 'danger' : demandInfo(item.courseId).tone === 'warn' ? 'warn' : 'muted'}`">
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
        拖动左侧的手柄即可调整；`加备选` 表示“这一门选不上时，试试那一门”（组内只会落实一门）。
      </p>

      <div v-if="items.length === 0" class="empty">清单是空的，请先回到第 1 步加入课程。</div>

      <ol v-else class="rank-list">
        <li
          v-for="(item, index) in sortedItems()"
          :key="item.courseId"
          class="rank-item"
          :class="{
            'rank-item--dragging': dragIndex === index,
            'rank-item--over': dragOverIndex === index,
          }"
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
              <span
                class="badge"
                :class="`badge--${demandInfo(item.courseId).tone === 'critical' ? 'danger' : demandInfo(item.courseId).tone === 'warn' ? 'warn' : 'muted'}`"
              >
                {{ demandInfo(item.courseId).label }}
              </span>
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
            <div v-if="membersOf(item.groupCode ?? '').length > 0" class="alt-list">
              <div class="small muted">这一门选不上时，依次尝试：</div>
              <div v-for="member in membersOf(item.groupCode ?? '')" :key="member.courseId" class="inline" style="margin-top: 4px">
                <span class="alt-list__mark">↳</span>
                <span>{{ member.courseName }}</span>
                <span class="mono small">{{ member.courseCode }}</span>
                <span class="badge">{{ formatCredits(member.credits) }} 学分</span>
                <span class="badge" :class="`badge--${memberDemandInfo(member.courseId).tone === 'critical' ? 'danger' : memberDemandInfo(member.courseId).tone === 'warn' ? 'warn' : 'muted'}`">
                  {{ memberDemandInfo(member.courseId).label }}
                </span>
                <span class="spacer"></span>
                <button class="btn btn--sm btn--ghost" type="button" @click="removeAlternative(member)">移除备选</button>
              </div>
              <button class="btn btn--sm btn--ghost" type="button" style="margin-top: 4px" @click="dissolveGroup(item.groupCode!)">
                解散备选关系
              </button>
            </div>

            <div class="inline" style="margin-top: 6px">
              <button class="btn btn--sm btn--ghost" type="button" @click="openAltPicker(index)">
                {{ altPickerFor === index ? '收起' : '加备选' }}
              </button>
              <button class="btn btn--sm btn--ghost" type="button" @click="loadClasses(item.courseId)">教学班偏好</button>
              <button class="btn btn--sm btn--danger" type="button" @click="removePreference(index)">移除</button>
            </div>

            <!-- 备选选择器 -->
            <div v-if="altPickerFor === index" class="card card--flat" style="margin-top: 8px">
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
                <select class="select" style="max-width: 420px" @change="onClassSelect(item, $event)">
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
                  <span class="badge" :class="previewStatusClass(attempt.status)">
                    {{ previewStatusLabel(attempt.status) }}
                  </span>
                  <span v-if="attempt.classCode" class="mono small">{{ attempt.classCode }}</span>
                </div>
                <div class="small" style="margin-top: 4px">{{ attempt.reason }}</div>
                <div v-if="attempt.conflictText" class="small muted" style="margin-top: 2px">{{ attempt.conflictText }}</div>
                <div v-if="attempt.status !== 'feasible'" class="small muted" style="margin-top: 2px">
                  可选教学班：{{ attempt.optionTexts.slice(0, 3).join('；') || '无' }}
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
            <span v-if="creditLimit !== null">（上限 {{ formatCredits(creditLimit) }}）</span>
          </strong>
          <span v-if="dirty" class="small" style="color: var(--color-warn, #b45309)">
            草稿还有未保存的修改，建议先保存再提交
          </span>
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
  border: 1px solid var(--color-border, #d8dce5);
  border-radius: 999px;
  background: #fff;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
}

.wizard-steps__item--active {
  border-color: var(--color-primary, #2563eb);
  background: var(--color-primary, #2563eb);
  color: #fff;
}

.wizard-steps__item--done {
  border-color: var(--color-ok, #16a34a);
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
  border: 1px solid var(--color-border, #d8dce5);
  border-radius: 10px;
  background: #fff;
}

.rank-item--dragging {
  opacity: 0.45;
}

.rank-item--over {
  border-color: var(--color-primary, #2563eb);
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
  border: 1px solid var(--color-border, #d8dce5);
  border-radius: 8px;
  background: #fff;
}

.submit-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--color-border, #d8dce5);
  border-radius: 10px;
  background: #f8fafc;
  flex-wrap: wrap;
}
</style>
