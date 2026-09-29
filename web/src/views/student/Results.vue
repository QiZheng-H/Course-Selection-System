<script setup lang="ts">
/**
 * 结果与候补。
 *
 * 面向学生的信息组织原则（与“志愿填报向导”保持一致）：
 *   - 先回答“我现在是什么情况”，再回答“我能做什么”，技术细节默认折叠；
 *   - 界面上不出现内部术语：不显示暂挂/关闭错误码、不显示随机键、不显示“普通余量/预留”这类
 *     容量字段名，只保留后端已经翻译好的中文原因；
 *   - 候补 5 种状态各给一句话说明和下一步动作，学生不需要靠猜。
 * 所有业务判断（顺位、名额、是否可提升）仍由后端给出，前端只做展示。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { newIdempotencyKey } from '@/api/idempotency';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type {
  AuthorizationRow,
  BatchDto,
  ClassDto,
  CourseDto,
  EnrolledRow,
  GuaranteeAuthorizationRow,
  TimelineEvent,
  TimetablePayload,
  WaitlistEntry,
  WaitlistPayload,
  WaitlistQueuePayload,
  WaitlistRecheckResult,
} from '@/api/types';
import {
  authorizationStatusLabel,
  batchStatusLabel,
  demandLabel,
  demandTone,
  formatCredits,
  formatDateTime,
  sourceLabel,
  waitlistStatusLabel,
} from '@/utils/labels';

const toast = useToast();

const batches = ref<BatchDto[]>([]);
const batchId = ref<number | null>(null);
const payload = ref<WaitlistPayload | null>(null);
const loading = ref(false);
const errorMessage = ref('');

const courseOptions = ref<CourseDto[]>([]);
const courseKeyword = ref('');
const form = reactive<{ courseId: number | null; classIds: number[]; globalRank: number | null }>({
  courseId: null,
  classIds: [],
  globalRank: null,
});
const formClasses = ref<ClassDto[]>([]);
const editingCourseName = ref('');

/** 排名留空时后端的行为：已有志愿排名则沿用，否则自动排在最后 */
const rankPlaceholder = computed(() => (editingCourseName.value ? '不填则沿用原志愿顺序' : '不填则自动排在最后'));

const queue = ref<WaitlistQueuePayload | null>(null);

const authorizations = ref<AuthorizationRow[]>([]);
const guaranteeAuthorizations = ref<GuaranteeAuthorizationRow[]>([]);
const timeline = ref<TimelineEvent[]>([]);
const timetable = ref<TimetablePayload | null>(null);

/** 学生本人创建替换授权：原教学班取自已选课程，目标课程可指定教学班 */
const enrolled = ref<EnrolledRow[]>([]);
/** 教学班 id → 教学班编号：候补申请与已选课程只存 id，界面上要显示成学生认得的编号 */
const classCodeCache = reactive<Record<number, string>>({});

function classCodeOf(classId: number): string | null {
  return classCodeCache[classId] ?? null;
}

/** 按需补全教学班编号（失败时保留“已记录的教学班”这类兜底文案） */
function cacheClassCodes(classIds: number[]): void {
  for (const classId of classIds) {
    if (!classId || classCodeCache[classId]) continue;
    void api
      .get<{ class: ClassDto }>(`/classes/${classId}`)
      .then((detail) => {
        classCodeCache[classId] = detail.class.classCode;
      })
      .catch(() => {
        // 读不到编号不影响主流程
      });
  }
}

const authForm = reactive<{ sourceClassId: number | null; targetCourseId: number | null; targetClassId: number | null; expiresAt: string }>({
  sourceClassId: null,
  targetCourseId: null,
  targetClassId: null,
  expiresAt: '',
});
const targetClasses = ref<ClassDto[]>([]);
const creatingAuth = ref(false);

/** 毕业兜底授权：明确接受哪些教学班 */
const guaranteeForm = reactive<{ courseId: number | null; classIds: number[] }>({ courseId: null, classIds: [] });
const guaranteeClasses = ref<ClassDto[]>([]);
const creatingGuarantee = ref(false);

const submitting = ref(false);
const rechecking = ref(false);
const actionEntryId = ref<number | null>(null);
const idempotencyKeys = reactive<Record<string, string>>({});

/** 详情抽屉：一次只看一条申请，避免表格里挤 8 列 */
const detailEntry = ref<WaitlistEntry | null>(null);
const activeTab = ref<'active' | 'done'>('active');
const showTips = ref(false);

const canEdit = computed(() => payload.value?.canEdit ?? false);

/* ------------------------------ 状态语义 ------------------------------ */

type Tone = 'critical' | 'warn' | 'muted' | 'ok';

/** 状态颜色：只在需要学生动手或出问题时抢眼 */
function waitlistStatusTone(status: string): Tone {
  if (status === 'suspended') return 'critical';
  if (status === 'queued') return 'warn';
  if (status === 'promoted') return 'ok';
  return 'muted';
}

function badgeClassFor(tone: Tone): string {
  if (tone === 'critical') return 'badge badge--danger';
  if (tone === 'warn') return 'badge badge--warn';
  if (tone === 'ok') return 'badge badge--ok';
  return 'badge badge--muted';
}

/** 一句话说清“现在什么情况” */
function statusDetail(entry: WaitlistEntry): string {
  if (entry.status === 'promoted') {
    return entry.positionReason && !entry.positionReason.startsWith('候补提升成功')
      ? `已经选上这门课。${entry.positionReason}`
      : '已经选上这门课，请在“我的课表”中确认上课时间。';
  }
  if (entry.status === 'suspended') {
    if (entry.suspendCode === 'AUTHORIZATION_REQUIRED') {
      return '这门课比你已经选上的课更靠前，需要你本人同意“用目标课程替换原课程”后才会继续排队。';
    }
    if (entry.suspendHint) return entry.suspendHint;
    const reason = entry.suspendReason ?? '暂时还不满足入选条件';
    return /[。？！]$/.test(reason) ? reason : `${reason}（条件变化后会自动重新检查）。`;
  }
  if (entry.status === 'closed') {
    const reason = entry.closeReason ?? entry.positionReason ?? '申请已永久失效';
    return /[。？！]$/.test(reason) ? reason : `${reason}（申请已不再排队）。`;
  }
  if (entry.status === 'withdrawn') return '你已主动退出这条候补，不再占用顺位。';
  if (entry.position !== null) {
    const ahead = entry.queuedAhead ?? 0;
    const aheadText = ahead === 0 ? '你排在第一位' : `你前面还有 ${ahead} 人`;
    return hasGeneralSeat(entry)
      ? `${aheadText}，目前还有空位，轮到你时会自动提升，不需要一直盯着。`
      : `${aheadText}，目前名额已满，一旦有人退课就会按顺位递补。`;
  }
  return '正在排队，等待名额释放。';
}

/** 下一步该做什么（没有可做的就不显示） */
function actionHint(entry: WaitlistEntry): string {
  if (entry.status === 'suspended') {
    return entry.suspendCode === 'AUTHORIZATION_REQUIRED'
      ? '下一步：在下面“升级（替换）授权”里创建授权，然后点“重新检查我的候补”。'
      : '下一步：处理上面提示的原因（例如退掉冲突的课程）后，点“重新检查我的候补”。';
  }
  if (entry.status === 'queued' && entry.position !== null) {
    return hasGeneralSeat(entry)
      ? '下一步：名额已经空出，点“重新检查我的候补”可以立刻尝试提升。'
      : '下一步：不需要操作，系统会在名额释放时按顺位处理。';
  }
  if (entry.status === 'closed') return '下一步：如需继续争取这门课，请重新提交候补申请。';
  return '';
}

function actionTone(entry: WaitlistEntry): Tone {
  if (entry.status === 'suspended') return 'critical';
  if (entry.status === 'queued' && hasGeneralSeat(entry)) return 'ok';
  return 'muted';
}

/** 是否仍有普通名额。学生看不到“普通/预留”的区分，只关心“还有没有位置” */
function hasGeneralSeat(entry: WaitlistEntry): boolean {
  return entry.capacity.generalAvailable > 0;
}

function seatText(entry: WaitlistEntry): string {
  if (entry.capacity.openClasses === 0) return '本学期已无开放教学班';
  if (entry.capacity.generalAvailable > 0) return `还有 ${entry.capacity.generalAvailable} 个空位`;
  return '名额已满';
}

function demandText(entry: WaitlistEntry): string {
  const label = demandLabel(entry.demandLevel);
  return label === '—' ? '暂无培养需求信息' : label;
}

/** 顺位徽标：相对队列长度说明“离入选有多远” */
function positionLabel(entry: WaitlistEntry): string {
  if (entry.status === 'promoted') return '已入选';
  if (entry.status === 'closed') return '已关闭';
  if (entry.status === 'withdrawn') return '已退出';
  if (entry.position === null) return '待排序';
  const total = entry.capacity.queued;
  return total > 0 ? `第 ${entry.position} 位 / 共 ${total} 人` : `第 ${entry.position} 位`;
}

/** 队列进度条：把“第几位”画出来，比数字直观 */
function positionPercent(entry: WaitlistEntry): number {
  if (entry.position === null || entry.capacity.queued <= 1) return 100;
  return Math.round(((entry.capacity.queued - entry.position + 1) / entry.capacity.queued) * 100);
}

/* ------------------------------ 概览 ------------------------------ */

function isActiveEntry(entry: WaitlistEntry): boolean {
  return entry.status === 'queued' || entry.status === 'suspended';
}

const activeEntries = computed(() => (payload.value?.entries ?? []).filter(isActiveEntry));
const finishedEntries = computed(() => (payload.value?.entries ?? []).filter((entry) => !isActiveEntry(entry)));
const visibleEntries = computed(() => (activeTab.value === 'active' ? activeEntries.value : finishedEntries.value));
const queuedCount = computed(() => (payload.value?.entries ?? []).filter((entry) => entry.status === 'queued').length);
const promotedCount = computed(() => (payload.value?.entries ?? []).filter((entry) => entry.status === 'promoted').length);
/** 需要学生本人处理的暂挂（例如缺授权） */
const needsActionCount = computed(() => activeEntries.value.filter((entry) => actionHint(entry) !== '').length);

const enrolledCredits = computed(() => enrolled.value.reduce((sum, row) => sum + row.credits, 0));
const creditLimit = computed(() => timetable.value?.creditLimit ?? payload.value?.batch.creditLimit ?? null);

/** 批次流程图：让学生知道现在是哪一步、下一步是什么 */
const PHASES = [
  { key: 'prepare', label: '资料与预分配', statuses: ['preparing', 'preview'] },
  { key: 'submit', label: '提交志愿', statuses: ['open'] },
  { key: 'allocate', label: '统一分配', statuses: ['frozen'] },
  { key: 'waitlist', label: '结果与候补', statuses: ['published', 'waitlist'] },
  { key: 'closed', label: '结束', statuses: ['closed'] },
];

const currentPhaseIndex = computed(() => {
  const status = payload.value?.batch.status;
  if (!status) return -1;
  const index = PHASES.findIndex((phase) => phase.statuses.includes(status));
  return index;
});

const phaseNote = computed(() => {
  const batch = payload.value?.batch;
  if (!batch) return '';
  if (batch.status === 'preparing') return '本轮还在准备资料，暂不开放提交。';
  if (batch.status === 'preview') return '可以提交和修改志愿；本轮还未开始分配。';
  if (batch.status === 'open') return batch.closeAt ? `可以在截止前随时修改志愿，截止时间：${formatDateTime(batch.closeAt)}。` : '可以在截止前随时修改志愿。';
  if (batch.status === 'frozen') return '本轮已截止并冻结，正在统一分配，暂时不能改选。';
  if (batch.status === 'published') return '结果已发布，下面是可以争取的候补课程。';
  if (batch.status === 'waitlist') return '候补按顺位自动递补；有合适空位时也可以直接选课。';
  return '本轮选课已结束，记录仅作查看。';
});

const hasActionableRecheck = computed(() => activeEntries.value.some((entry) => entry.status === 'queued' && hasGeneralSeat(entry)));

/* ------------------------------ 数据加载 ------------------------------ */

/** 同一意图重试时复用同一个幂等键 */
function keyFor(intent: string): string {
  if (!idempotencyKeys[intent]) idempotencyKeys[intent] = newIdempotencyKey();
  return idempotencyKeys[intent];
}

function clearKey(intent: string): void {
  delete idempotencyKeys[intent];
}

async function loadAuthorizations(): Promise<void> {
  try {
    const data = await api.get<{ authorizations: AuthorizationRow[] }>('/authorizations');
    authorizations.value = data.authorizations;
  } catch (error) {
    reportApiError(error, '读取升级授权失败');
  }
}

async function loadGuaranteeAuthorizations(): Promise<void> {
  if (batchId.value === null) return;
  try {
    const data = await api.get<{ authorizations: GuaranteeAuthorizationRow[] }>('/guarantee-authorizations', {
      batchId: batchId.value,
    });
    guaranteeAuthorizations.value = data.authorizations;
  } catch (error) {
    reportApiError(error, '读取毕业兜底授权失败');
  }
}

async function loadEnrolled(): Promise<void> {
  try {
    const data = await api.get<{ enrolled: EnrolledRow[] }>('/student/records');
    enrolled.value = data.enrolled;
    cacheClassCodes(data.enrolled.map((row) => row.classId));
  } catch (error) {
    reportApiError(error, '读取已选课程失败');
  }
}

async function loadTimetable(): Promise<void> {
  try {
    const data = await api.get<{ timetable: TimetablePayload }>('/timetable');
    timetable.value = data.timetable;
  } catch {
    // 课表只用于概览展示，失败不影响候补功能
  }
}

async function onAuthSourceChange(): Promise<void> {
  authForm.targetClassId = null;
  targetClasses.value = [];
  if (authForm.targetCourseId === null) return;
  try {
    const data = await api.get<{ items: ClassDto[] }>('/classes', { courseId: authForm.targetCourseId, pageSize: 100 });
    targetClasses.value = data.items;
  } catch (error) {
    reportApiError(error, '读取目标教学班失败');
  }
}

async function createAuthorization(): Promise<void> {
  if (authForm.sourceClassId === null || authForm.targetCourseId === null) {
    toast.warning('请选择原教学班和目标课程');
    return;
  }
  const source = enrolled.value.find((e) => e.classId === authForm.sourceClassId);
  const target = courseOptions.value.find((c) => c.id === authForm.targetCourseId);
  const ok = await askConfirm({
    title: '确认自动替换授权',
    message: `同意系统在你满足资格与时间限制时，用「${target?.name ?? '目标课程'}」替换你当前在修的「${source?.courseName ?? '原课程'}」。授权必须由你本人确认，管理员不能代替。`,
    details: [
      '执行替换时会先检查替换后的完整课表，成立才会在同一事务内落实目标课并释放原课；失败会保留原课。',
      '关键资料变化后授权会自动失效，需要重新确认。',
    ],
    confirmText: '确认授权',
    danger: false,
  });
  if (!ok) return;
  creatingAuth.value = true;
  try {
    await api.post('/authorizations', {
      batchId: batchId.value,
      sourceClassId: authForm.sourceClassId,
      targetCourseId: authForm.targetCourseId,
      targetClassId: authForm.targetClassId,
      expiresAt: authForm.expiresAt ? new Date(authForm.expiresAt).toISOString() : null,
    });
    toast.success('已创建替换授权', ['这条授权可以用于候补中的更高偏好课程，也可以直接点“使用授权自动替换”。']);
    authForm.sourceClassId = null;
    authForm.targetCourseId = null;
    authForm.targetClassId = null;
    authForm.expiresAt = '';
    targetClasses.value = [];
    await Promise.all([loadAuthorizations(), batchId.value !== null ? loadWaitlist(batchId.value) : Promise.resolve()]);
  } catch (error) {
    reportApiError(error, '创建授权失败');
  } finally {
    creatingAuth.value = false;
  }
}

async function revokeAuthorization(row: AuthorizationRow): Promise<void> {
  const ok = await askConfirm({
    title: '撤销替换授权',
    message: `撤销后，系统不会再自动用「${row.targetCourseName}」替换「${row.sourceCourseName}」。`,
    confirmText: '确认撤销',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/authorizations/${row.id}`);
    toast.success('已撤销授权');
    await Promise.all([loadAuthorizations(), batchId.value !== null ? loadWaitlist(batchId.value) : Promise.resolve()]);
  } catch (error) {
    reportApiError(error, '撤销失败');
  }
}

async function onGuaranteeCourseChange(): Promise<void> {
  guaranteeForm.classIds = [];
  guaranteeClasses.value = [];
  if (guaranteeForm.courseId === null) return;
  try {
    const data = await api.get<{ items: ClassDto[] }>('/classes', { courseId: guaranteeForm.courseId, pageSize: 100 });
    guaranteeClasses.value = data.items;
  } catch (error) {
    reportApiError(error, '读取教学班失败');
  }
}

function toggleGuaranteeClass(classId: number): void {
  if (guaranteeForm.classIds.includes(classId)) {
    guaranteeForm.classIds = guaranteeForm.classIds.filter((id) => id !== classId);
  } else {
    guaranteeForm.classIds.push(classId);
  }
}

async function createGuaranteeAuthorization(): Promise<void> {
  if (batchId.value === null || guaranteeForm.courseId === null) {
    toast.warning('请选择课程');
    return;
  }
  if (guaranteeForm.classIds.length === 0) {
    toast.warning('请至少选择一个你接受的教学班', ['没有接受任何教学班时，系统不会自动兜底。']);
    return;
  }
  const course = courseOptions.value.find((c) => c.id === guaranteeForm.courseId);
  const ok = await askConfirm({
    title: '确认毕业兜底授权',
    message: `同意系统只在「${course?.name ?? '该课程'}」你勾选的教学班范围内，为毕业必要课程做出自动安排（先用普通名额，再用毕业预留）。`,
    details: ['未勾选的教学班不会被自动选择；缺少授权时系统不会自动扩大选择范围，而是形成待处理异常。'],
    confirmText: '确认授权',
    danger: false,
  });
  if (!ok) return;
  creatingGuarantee.value = true;
  try {
    await api.post('/guarantee-authorizations', {
      batchId: batchId.value,
      courseId: guaranteeForm.courseId,
      classIds: guaranteeForm.classIds,
    });
    toast.success('已保存毕业兜底授权');
    guaranteeForm.courseId = null;
    guaranteeForm.classIds = [];
    guaranteeClasses.value = [];
    await Promise.all([loadGuaranteeAuthorizations(), batchId.value !== null ? loadWaitlist(batchId.value) : Promise.resolve()]);
  } catch (error) {
    reportApiError(error, '保存兜底授权失败');
  } finally {
    creatingGuarantee.value = false;
  }
}

async function revokeGuaranteeAuthorization(row: GuaranteeAuthorizationRow): Promise<void> {
  const ok = await askConfirm({
    title: '撤销毕业兜底授权',
    message: `撤销后，系统不会在「${row.courseName}」上自动为你兜底，可能形成保障异常。`,
    confirmText: '确认撤销',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/guarantee-authorizations/${row.id}`);
    toast.success('已撤销兜底授权');
    await loadGuaranteeAuthorizations();
  } catch (error) {
    reportApiError(error, '撤销失败');
  }
}

async function loadBatches(): Promise<void> {
  try {
    const data = await api.get<{ batches: BatchDto[]; current: BatchDto | null }>('/student/batches');
    batches.value = data.batches;
    const target = data.current ?? data.batches[0] ?? null;
    if (target) {
      batchId.value = target.id;
      await loadWaitlist(target.id);
    }
  } catch (error) {
    reportApiError(error, '读取批次失败');
  }
}

async function loadWaitlist(targetBatchId: number): Promise<void> {
  loading.value = true;
  errorMessage.value = '';
  try {
    payload.value = await api.get<WaitlistPayload>('/waitlist', { batchId: targetBatchId });
    // 详情抽屉里的数据来自列表，刷新后保持一致
    if (detailEntry.value) {
      detailEntry.value = payload.value.entries.find((entry) => entry.id === detailEntry.value?.id) ?? null;
    }
  } catch (error) {
    errorMessage.value = apiErrorInfo(error).message;
  } finally {
    loading.value = false;
  }
}

async function loadCourses(): Promise<void> {
  try {
    const data = await api.get<{ items: CourseDto[] }>('/courses', {
      keyword: courseKeyword.value.trim() || undefined,
      pageSize: 50,
    });
    courseOptions.value = data.items;
  } catch (error) {
    reportApiError(error, '读取课程列表失败');
  }
}

/** 切换批次（v-model 已经写入 batchId） */
function onBatchChange(): void {
  if (batchId.value !== null) {
    void loadWaitlist(batchId.value);
    void loadGuaranteeAuthorizations();
  }
}

async function onCourseChange(): Promise<void> {
  form.classIds = [];
  formClasses.value = [];
  if (form.courseId === null) {
    form.globalRank = null;
    return;
  }
  // 沿用该课程已有的志愿排名，学生不必自己记名次；留空则由后端沿用原排名
  const existing = payload.value?.entries.find((entry) => entry.courseId === form.courseId);
  form.globalRank = existing?.globalRank ?? null;
  try {
    const data = await api.get<{ items: ClassDto[] }>('/classes', { courseId: form.courseId, pageSize: 100 });
    formClasses.value = data.items;
    for (const cls of data.items) classCodeCache[cls.id] = cls.classCode;
  } catch (error) {
    reportApiError(error, '读取教学班失败');
  }
}

function isSelectedClass(classId: number): boolean {
  return form.classIds.includes(classId);
}

function toggleClass(classId: number): void {
  if (isSelectedClass(classId)) form.classIds = form.classIds.filter((id) => id !== classId);
  else form.classIds.push(classId);
}

function startEdit(entry: WaitlistEntry): void {
  form.courseId = entry.courseId;
  form.classIds = [...entry.classChoices];
  form.globalRank = entry.globalRank;
  editingCourseName.value = entry.courseName;
  detailEntry.value = null;
  void onCourseChange();
  toast.info('已载入候补申请', ['修改后会按当前需求、排名与固定随机键重新排序，顺位可能前后移动。']);
}

function resetForm(): void {
  form.courseId = null;
  form.classIds = [];
  form.globalRank = null;
  formClasses.value = [];
  editingCourseName.value = '';
}

async function submitWaitlist(): Promise<void> {
  if (batchId.value === null) return;
  if (form.courseId === null) {
    toast.warning('请先选择要候补的课程');
    return;
  }
  const existing = payload.value?.entries.find((entry) => entry.courseId === form.courseId);
  const classTexts = form.classIds
    .map((id) => formClasses.value.find((cls) => cls.id === id)?.classCode ?? `教学班 ${id}`)
    .join(' → ');
  const ok = await askConfirm({
    title: existing ? '修改候补申请' : '新增候补申请',
    message: existing
      ? '修改后系统会按“当前需求 + 当前排名 + 固定随机键”重新排序，顺位可能前后移动。'
      : '新增候补后，只有当仍有空位且轮到你时才会被提升；暂挂或关闭时会给出原因。',
    details: form.classIds.length > 0 ? [`期望的教学班顺序：${classTexts}`] : ['你还没有指定教学班偏好，系统会在所有开放教学班里择优安排。'],
    confirmText: existing ? '确认修改' : '确认新增',
    danger: false,
  });
  if (!ok) return;
  submitting.value = true;
  try {
    await api.post<WaitlistEntry>('/waitlist', {
      batchId: batchId.value,
      courseId: form.courseId,
      classIds: form.classIds,
      globalRank: form.globalRank ?? undefined,
    });
    toast.success(existing ? '候补申请已更新' : '候补申请已提交');
    resetForm();
    await loadWaitlist(batchId.value);
  } catch (error) {
    reportApiError(error, '候补申请失败');
  } finally {
    submitting.value = false;
  }
}

async function withdrawEntry(entry: WaitlistEntry): Promise<void> {
  const ok = await askConfirm({
    title: `退出候补：${entry.courseName}`,
    message: '退出后该申请不再参与排队，之后可以重新提交（随机键不会重抽）。',
    confirmText: '确认退出',
  });
  if (!ok) return;
  actionEntryId.value = entry.id;
  try {
    await api.del(`/waitlist/${entry.id}`);
    toast.success('已退出候补');
    if (detailEntry.value?.id === entry.id) detailEntry.value = null;
    if (batchId.value !== null) await loadWaitlist(batchId.value);
  } catch (error) {
    reportApiError(error, '退出失败');
  } finally {
    actionEntryId.value = null;
  }
}

async function recheck(): Promise<void> {
  if (batchId.value === null) return;
  const ok = await askConfirm({
    title: '重新检查我的候补',
    message: '系统会重新评估时间冲突、学分与授权条件，满足条件的申请会立即尝试提升。',
    confirmText: '开始检查',
    danger: false,
  });
  if (!ok) return;
  rechecking.value = true;
  try {
    const result = await api.post<WaitlistRecheckResult>('/waitlist/recheck', { batchId: batchId.value });
    const lines = [`检查 ${result.checked} 条：提升 ${result.promoted}，暂挂 ${result.suspended}，关闭 ${result.closed}`];
    if (result.promoted > 0) lines.push('已提升的课程会出现在“我的课表”里。');
    toast.success('检查完成', lines);
    await loadWaitlist(batchId.value);
  } catch (error) {
    reportApiError(error, '重新检查失败');
  } finally {
    rechecking.value = false;
  }
}

/** 使用管理员授予的替换授权（POST /api/upgrade），同一意图重试复用同一个幂等键 */
async function useAuthorization(row: AuthorizationRow): Promise<void> {
  const ok = await askConfirm({
    title: '使用授权自动替换',
    message: `将用「${row.targetCourseName}${row.targetClassCode ? ` ${row.targetClassCode}` : ''}」替换你当前在修的「${row.sourceCourseName}${row.sourceClassCode ? ` ${row.sourceClassCode}` : ''}」。系统会先检查替换后的完整课表，成立才会在同一事务内执行。`,
    details: [
      '授权带版本：关键资料变化后授权会自动失效，本操作会被拒绝。',
      row.expiresAt ? `授权过期时间：${formatDateTime(row.expiresAt)}` : '该授权没有设置过期时间。',
    ],
    confirmText: '确认替换',
    danger: false,
  });
  if (!ok) return;
  const intent = `upgrade:${row.id}`;
  actionEntryId.value = -row.id;
  try {
    const result = await api.post<{ ok: boolean; idempotentReplay: boolean; messages?: string[] }>('/upgrade', {
      authorizationId: row.id,
      idempotencyKey: keyFor(intent),
    });
    clearKey(intent);
    toast.success('已按授权完成替换', result.messages ?? []);
    await Promise.all([loadAuthorizations(), batchId.value !== null ? loadWaitlist(batchId.value) : Promise.resolve()]);
  } catch (error) {
    reportApiError(error, '自动替换失败');
  } finally {
    actionEntryId.value = null;
  }
}

/** 打开详情抽屉，并顺带读取队列，让学生马上看到“前面还有谁” */
async function openDetail(entry: WaitlistEntry): Promise<void> {
  detailEntry.value = entry;
  queue.value = null;
  cacheClassCodes(entry.classChoices);
  if (batchId.value === null) return;
  try {
    queue.value = await api.get<WaitlistQueuePayload>('/waitlist/queue', {
      batchId: batchId.value,
      courseId: entry.courseId,
    });
  } catch (error) {
    reportApiError(error, '读取队列失败');
  }
}

onMounted(async () => {
  await loadBatches();
  await loadCourses();
  await Promise.all([loadAuthorizations(), loadEnrolled(), loadTimetable()]);
  await loadGuaranteeAuthorizations();
  try {
    const data = await api.get<{ timeline: TimelineEvent[] }>('/student/timeline');
    timeline.value = data.timeline;
  } catch {
    // 时间轴失败不影响主功能
  }
});
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">结果与候补</h1>
        <p class="page__desc">
          这里回答三件事：哪些课已经选上、哪些课还在排队、有没有需要你本人处理的事情。
        </p>
      </div>
      <div class="inline">
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">选课批次</span>
          <select
            v-model.number="batchId"
            class="select"
            @change="onBatchChange"
          >
            <option v-for="item in batches" :key="item.id" :value="item.id">
              {{ item.name }}（{{ item.term }} · {{ batchStatusLabel(item.status) }}）
            </option>
          </select>
        </label>
        <button class="btn btn--primary btn--sm" type="button" :disabled="rechecking || batchId === null" @click="recheck">
          {{ rechecking ? '检查中…' : '重新检查我的候补' }}
        </button>
      </div>
    </div>

    <p v-if="errorMessage" class="alert alert--error">{{ errorMessage }}</p>
    <p v-if="!loading && batches.length === 0" class="alert alert--warning">
      当前没有任何选课批次，候补功能不可用。请等待管理员创建并开放批次后再回来查看。
    </p>

    <!-- 概览：一屏说清“我现在什么情况、要不要动手” -->
    <section v-if="payload" class="card card--flat">
      <div class="phase-strip">
        <template v-for="(phase, index) in PHASES" :key="phase.key">
          <span
            class="phase-chip"
            :class="{ 'phase-chip--done': currentPhaseIndex > index, 'phase-chip--current': currentPhaseIndex === index }"
          >
            {{ phase.label }}
          </span>
          <span v-if="index < PHASES.length - 1" class="phase-arrow">→</span>
        </template>
      </div>
      <p class="tips" style="margin: 6px 0 0">{{ phaseNote }}</p>

      <div class="grid grid--4" style="margin-top: 12px">
        <div class="stat">
          <div class="stat__label">已选上的课程</div>
          <div class="stat__value">{{ enrolled.length }}</div>
          <div class="stat__extra">
            共 {{ formatCredits(enrolledCredits) }} 学分<template v-if="creditLimit !== null"> / 上限 {{ formatCredits(creditLimit) }}</template>
          </div>
        </div>
        <div class="stat">
          <div class="stat__label">正在排队</div>
          <div class="stat__value">{{ queuedCount }}</div>
          <div class="stat__extra">按顺位自动递补，不需要反复提交</div>
        </div>
        <div class="stat">
          <div class="stat__label">已提升</div>
          <div class="stat__value">{{ promotedCount }}</div>
          <div class="stat__extra">候补成功，已经进入课表</div>
        </div>
        <div class="stat">
          <div class="stat__label">需要你处理</div>
          <div class="stat__value">{{ needsActionCount }}</div>
          <div class="stat__extra">暂挂或已有空位的申请</div>
        </div>
      </div>

      <p v-if="needsActionCount > 0" class="alert alert--warning" style="margin-top: 12px">
        有 {{ needsActionCount }} 条候补需要你关注，下面列表里标了“下一步”的就是。
      </p>
      <p v-else-if="hasActionableRecheck" class="alert alert--success" style="margin-top: 12px">
        有申请已经出现空位，点右上角“重新检查我的候补”可以立刻尝试提升。
      </p>
      <p v-else-if="activeEntries.length > 0" class="alert alert--info" style="margin-top: 12px">
        当前没有需要你处理的事情。名额释放后系统会按顺位自动递补，你可以在“我的课表”查看最终结果。
      </p>
      <p v-if="payload && !canEdit" class="alert alert--warning" style="margin-top: 12px">
        当前批次状态为「{{ batchStatusLabel(payload.batch.status) }}」，此阶段不能新增或修改候补申请，但仍可以退出候补和重新检查。
      </p>
    </section>

    <!-- 我的候补：卡片式列表，一条申请一块 -->
    <section class="card">
      <div class="card__header">
        <h3 class="card__title">我的候补申请</h3>
        <div class="inline">
          <button class="btn btn--ghost btn--sm" type="button" :disabled="loading || batchId === null" @click="onBatchChange">
            刷新
          </button>
        </div>
      </div>

      <div class="tabs">
        <button class="tab" :class="{ 'tab--active': activeTab === 'active' }" type="button" @click="activeTab = 'active'">
          进行中（{{ activeEntries.length }}）
        </button>
        <button class="tab" :class="{ 'tab--active': activeTab === 'done' }" type="button" @click="activeTab = 'done'">
          已结束（{{ finishedEntries.length }}）
        </button>
      </div>

      <div v-if="!payload" class="empty">正在读取候补申请…</div>
      <div v-else-if="visibleEntries.length === 0" class="empty">
        {{ activeTab === 'active' ? '当前没有正在排队的候补申请。' : '还没有已结束的候补记录。' }}
      </div>
      <div v-else class="list">
        <article v-for="entry in visibleEntries" :key="entry.id" class="wl-entry" :class="`wl-entry--${waitlistStatusTone(entry.status)}`">
          <div class="wl-entry__head">
            <div class="wl-entry__name">
              <strong>{{ entry.courseName }}</strong>
              <span class="mono small">{{ entry.courseCode }} · {{ formatCredits(entry.credits) }} 学分</span>
            </div>
            <div class="inline">
              <span :class="badgeClassFor(waitlistStatusTone(entry.status))">{{ waitlistStatusLabel(entry.status) }}</span>
              <span class="badge badge--muted">{{ positionLabel(entry) }}</span>
              <span class="badge" :class="badgeClassFor(demandTone(entry.demandLevel))">{{ demandText(entry) }}</span>
            </div>
          </div>

          <p class="wl-entry__line">{{ statusDetail(entry) }}</p>

          <div class="wl-entry__meta">
            <span>空位情况：<strong>{{ seatText(entry) }}</strong></span>
            <span>排在前面：{{ entry.queuedAhead ?? '—' }} 人</span>
            <span>开放教学班：{{ entry.capacity.openClasses }} 个</span>
            <span v-if="entry.globalRank !== null">志愿顺序：第 {{ entry.globalRank }} 志愿</span>
          </div>

          <div v-if="entry.status === 'queued' || entry.status === 'suspended'" class="wl-meter" aria-hidden="true">
            <div class="wl-meter__fill" :style="{ width: `${positionPercent(entry)}%` }"></div>
          </div>

          <p v-if="actionHint(entry)" class="wl-entry__action" :class="`wl-entry__action--${actionTone(entry)}`">
            {{ actionHint(entry) }}
          </p>

          <div class="inline" style="margin-top: 10px">
            <button class="btn btn--sm btn--ghost" type="button" @click="openDetail(entry)">查看详情与队列</button>
            <button
              class="btn btn--sm btn--ghost"
              type="button"
              :disabled="!canEdit || entry.status === 'withdrawn' || entry.status === 'promoted'"
              @click="startEdit(entry)"
            >
              修改申请
            </button>
            <button
              class="btn btn--sm btn--danger"
              type="button"
              :disabled="actionEntryId === entry.id || entry.status === 'withdrawn' || entry.status === 'closed'"
              @click="withdrawEntry(entry)"
            >
              退出候补
            </button>
          </div>
        </article>
      </div>

      <p class="tips" style="margin: 10px 0 0">
        顺位是按“培养需求 → 志愿顺序 → 固定随机键”算出来的，展示的是当前顺位，不承诺永不后移。
        队列只显示顺位和需求等级，不会显示其他同学是谁。
      </p>
    </section>

    <!-- 详情抽屉：一条申请的完整信息 + 队列 -->
    <div v-if="detailEntry" class="drawer-backdrop" @click.self="detailEntry = null">
      <aside class="drawer">
        <header class="drawer__header">
          <div class="drawer__heading">
            <h3 class="drawer__title">{{ detailEntry.courseName }}</h3>
            <div class="drawer__subtitle">
              {{ detailEntry.courseCode }} · {{ formatCredits(detailEntry.credits) }} 学分 ·
              {{ waitlistStatusLabel(detailEntry.status) }}
            </div>
          </div>
          <button class="btn btn--ghost btn--sm" type="button" @click="detailEntry = null">关闭</button>
        </header>
        <div class="drawer__body">
          <p class="wl-entry__line">{{ statusDetail(detailEntry) }}</p>
          <p v-if="actionHint(detailEntry)" class="wl-entry__action" :class="`wl-entry__action--${actionTone(detailEntry)}`">
            {{ actionHint(detailEntry) }}
          </p>

          <div class="stat" style="margin-top: 12px">
            <div class="stat__label">我的顺位</div>
            <div class="stat__value">{{ detailEntry.position ?? '—' }}</div>
            <div class="stat__extra">
              共 {{ detailEntry.capacity.queued }} 人在此队列 · 我前面 {{ detailEntry.queuedAhead ?? '—' }} 人
            </div>
            <div class="wl-meter" style="margin-top: 8px">
              <div class="wl-meter__fill" :style="{ width: `${positionPercent(detailEntry)}%` }"></div>
            </div>
          </div>

          <div class="kv" style="margin-top: 12px">
            <span class="kv__key">空位情况</span>
            <span>{{ seatText(detailEntry) }}</span>
            <span class="kv__key">培养需求</span>
            <span>{{ demandText(detailEntry) }}</span>
            <span class="kv__key">我的志愿顺序</span>
            <span>{{ detailEntry.globalRank !== null ? `第 ${detailEntry.globalRank} 志愿` : '未设置' }}</span>
            <span class="kv__key">我接受的教学班</span>
            <span>
              <template v-if="detailEntry.classChoices.length > 0">
                <span v-for="classId in detailEntry.classChoices" :key="classId" class="badge badge--muted" style="margin: 0 4px 4px 0">
                  {{ classCodeOf(classId) ?? '已记录的教学班' }}
                </span>
                <span class="small muted">按这个顺序优先</span>
              </template>
              <template v-else>未指定，系统会在所有开放教学班中择优安排</template>
            </span>
          </div>

          <div class="divider"></div>
          <h4 style="margin-bottom: 6px">排在我前面的同学</h4>
          <p class="tips" style="margin-bottom: 8px">
            这里只显示顺位和培养需求，不显示任何身份信息。越靠前越先被提升，轮到有空的候补时系统会自动处理。
          </p>
          <div v-if="!queue" class="muted small">正在读取队列…</div>
          <template v-else>
            <div v-if="queue.ahead.length === 0" class="alert alert--success">你前面没有其他候补，名额一空出就会轮到你。</div>
            <template v-else>
              <div class="wl-queue">
                <span v-for="row in queue.ahead" :key="row.position" class="wl-chip" :class="`wl-chip--${demandTone(row.demandLevel)}`">
                  第{{ row.position }}位 · {{ demandLabel(row.demandLevel) }}
                </span>
                <span class="wl-chip wl-chip--me">
                  我（第{{ queue.myPosition ?? detailEntry.position ?? '—' }}位）
                </span>
              </div>
              <p class="tips" style="margin-top: 8px">
                你前面还有 {{ queue.ahead.length }} 人。他们被提升或退出后，你的顺位会自动前移（按当前需求与志愿顺序重算）。
              </p>
            </template>
          </template>

          <div class="divider"></div>
          <div class="inline">
            <button
              class="btn btn--sm btn--primary"
              type="button"
              :disabled="rechecking || batchId === null"
              @click="recheck"
            >
              {{ rechecking ? '检查中…' : '重新检查我的候补' }}
            </button>
            <button
              class="btn btn--sm btn--ghost"
              type="button"
              :disabled="!canEdit || detailEntry.status === 'withdrawn' || detailEntry.status === 'promoted'"
              @click="startEdit(detailEntry)"
            >
              修改这条申请
            </button>
          </div>

          <details style="margin-top: 12px">
            <summary class="muted small" style="cursor: pointer">技术细节（一般不需要看）</summary>
            <div class="kv" style="margin-top: 8px">
              <span class="kv__key">申请记录号</span>
              <span class="mono">{{ detailEntry.id }}</span>
              <span class="kv__key">排序随机键</span>
              <span class="mono">{{ detailEntry.randomKey ?? '—' }}</span>
              <span class="kv__key">来源</span>
              <span>{{ detailEntry.source ? sourceLabel(detailEntry.source) : '本人提交' }}</span>
              <span class="kv__key">创建时间</span>
              <span>{{ formatDateTime(detailEntry.createdAt) }}</span>
              <span class="kv__key">最近更新</span>
              <span>{{ formatDateTime(detailEntry.updatedAt) }}</span>
              <template v-if="detailEntry.positionReason">
                <span class="kv__key">顺位变化说明</span>
                <span>{{ detailEntry.positionReason }}</span>
              </template>
              <template v-if="detailEntry.suspendCode">
                <span class="kv__key">暂挂原因码</span>
                <span class="mono">{{ detailEntry.suspendCode }}</span>
              </template>
              <template v-if="detailEntry.closeCode">
                <span class="kv__key">关闭原因码</span>
                <span class="mono">{{ detailEntry.closeCode }}</span>
              </template>
            </div>
          </details>
        </div>
      </aside>
    </div>

    <!-- 新增 / 修改候补申请 -->
    <section class="card">
      <div class="card__header">
        <h3 class="card__title">{{ editingCourseName ? `修改候补：${editingCourseName}` : '新增候补申请' }}</h3>
        <button v-if="editingCourseName" class="btn btn--ghost btn--sm" type="button" @click="resetForm">取消修改</button>
      </div>
      <p class="tips">
        已选上的课不用在这里提交——这里只申请“还没选上、想继续排队”的课程。
        课程与顺序建议先在“志愿与规划”里排好，这里主要用于候补阶段临时增加或调整。
      </p>

      <div class="grid grid--3" style="margin-top: 10px">
        <label class="field">
          <span class="field__label">想候补的课程</span>
          <select v-model.number="form.courseId" class="select" @change="onCourseChange">
            <option :value="null">请选择课程</option>
            <option v-for="course in courseOptions" :key="course.id" :value="course.id">
              {{ course.code }} {{ course.name }}（{{ formatCredits(course.credits) }} 学分）
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">这门课在我志愿里的顺序（可不填）</span>
          <input
            v-model.number="form.globalRank"
            class="input"
            type="number"
            min="1"
            step="1"
            :placeholder="rankPlaceholder"
          />
          <span class="field__hint">数字越小越优先，不能与其他课程的志愿顺序重复；留空由系统安排。</span>
        </label>
        <div class="field">
          <span class="field__label">找不到课程？搜索一下</span>
          <div class="inline">
            <input v-model="courseKeyword" class="input" type="text" placeholder="课程名或课程号" @keyup.enter="loadCourses" />
            <button class="btn btn--ghost btn--sm" type="button" @click="loadCourses">搜索</button>
          </div>
        </div>
      </div>

      <div v-if="formClasses.length > 0">
        <span class="field__label">期望的教学班（可不选；勾选后按勾选顺序优先）</span>
        <div class="list">
          <label v-for="cls in formClasses" :key="cls.id" class="list__item">
            <span class="inline">
              <input type="checkbox" :checked="isSelectedClass(cls.id)" @change="toggleClass(cls.id)" />
              <strong>{{ cls.classCode }}</strong>
              <span class="badge" :class="cls.status === 'open' ? 'badge--ok' : 'badge--danger'">
                {{ cls.status === 'open' ? '开放选课' : '停止选课' }}
              </span>
              <span class="small muted">{{ cls.teacher?.name ?? '未指定教师' }}</span>
              <span class="small muted">{{ cls.sessions.map((s) => s.text).join('；') }}</span>
              <span class="spacer"></span>
              <span class="small" :class="cls.generalAvailable > 0 ? 'muted' : ''">
                {{ cls.generalAvailable > 0 ? `还有 ${cls.generalAvailable} 个空位` : '名额已满' }}
              </span>
            </span>
          </label>
        </div>
      </div>

      <div class="inline" style="margin-top: 10px">
        <button class="btn btn--primary" type="button" :disabled="submitting || !canEdit" @click="submitWaitlist">
          {{ submitting ? '提交中…' : editingCourseName ? '保存修改' : '提交候补申请' }}
        </button>
        <span v-if="!canEdit" class="muted small">当前批次状态不允许新增或修改候补申请。</span>
      </div>
    </section>

    <!-- 规则说明：默认收起，不占用主视线 -->
    <section class="card card--flat">
      <div class="card__header" style="margin-bottom: 0">
        <h3 class="card__title">候补规则说明</h3>
        <button class="btn btn--ghost btn--sm" type="button" @click="showTips = !showTips">
          {{ showTips ? '收起' : '展开看看' }}
        </button>
      </div>
      <div v-if="showTips" class="grid grid--2" style="margin-top: 10px">
        <div>
          <h4>五种状态分别是什么意思</h4>
          <ul class="tips">
            <li><strong>排队中</strong>：申请有效，按顺位等待空位，不需要反复提交。</li>
            <li><strong>暂挂</strong>：暂时不满足条件（时间冲突、学分上限、缺替换授权等），条件变化后会自动重新检查。</li>
            <li><strong>已提升</strong>：已经选上，会出现在“我的课表”里。</li>
            <li><strong>已关闭</strong>：申请已永久失效（例如更高偏好已落实、课程不再开设），不再排队。</li>
            <li><strong>已退出</strong>：你本人主动退出的申请。</li>
          </ul>
        </div>
        <div>
          <h4>顺位是怎么排的</h4>
          <ul class="tips">
            <li>先看培养需求：本学期必须完成的课程优先于兴趣课程。</li>
            <li>需求相同看志愿顺序：志愿越靠前越优先。</li>
            <li>仍然相同才看随机键，随机键在同学期内固定，多次提交或退出重进都不会重抽，也没有“越早排队越优先”。</li>
            <li>名额定给合格候补；只有当没有合格候补、且名额不受毕业保障保护时，才允许公开补选。</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 授权：进阶功能，默认折叠 -->
    <section class="card">
      <div class="card__header">
        <h3 class="card__title">升级（替换）授权</h3>
      </div>
      <p class="tips">
        用途：你已选上一门课，但更想上另一门课时，用它授权系统做一对一替换。
        授权必须由你本人确认；管理员确认毕业资格不能代替你同意退换课程。
        执行时会先检查替换后的完整课表，成立才在同一事务内落实目标课并释放原课，失败会保留原课。
        若你的候补显示“需要替换授权”，创建后回到上面点“重新检查我的候补”即可继续排队。
      </p>

      <details style="margin-top: 10px">
        <summary class="small" style="cursor: pointer">我要创建一条新的替换授权</summary>
        <div class="grid grid--3" style="margin-top: 10px">
          <label class="field">
            <span class="field__label">原教学班（当前在修，会被释放）</span>
            <select v-model.number="authForm.sourceClassId" class="select">
              <option :value="null">请选择</option>
              <option v-for="row in enrolled" :key="row.classId" :value="row.classId">
                {{ row.courseName }}<template v-if="classCodeOf(row.classId)">（{{ classCodeOf(row.classId) }}）</template>
              </option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">目标课程（想换成的课）</span>
            <select v-model.number="authForm.targetCourseId" class="select" @change="onAuthSourceChange">
              <option :value="null">请选择</option>
              <option v-for="course in courseOptions" :key="course.id" :value="course.id">
                {{ course.code }} {{ course.name }}
              </option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">目标教学班（可不指定）</span>
            <select v-model.number="authForm.targetClassId" class="select">
              <option :value="null">不指定（由系统在符合资格与时间的班里选择）</option>
              <option v-for="cls in targetClasses" :key="cls.id" :value="cls.id">
                {{ cls.classCode }}（{{ cls.generalAvailable > 0 ? `还有 ${cls.generalAvailable} 个空位` : '名额已满' }}）
              </option>
            </select>
          </label>
        </div>
        <label class="field">
          <span class="field__label">授权过期时间（可选）</span>
          <input v-model="authForm.expiresAt" class="input" type="datetime-local" />
          <span class="field__hint">留空表示长期有效；关键资料变化后授权会自动失效，需要重新确认。</span>
        </label>
        <div class="inline">
          <button class="btn btn--primary" type="button" :disabled="creatingAuth" @click="createAuthorization">
            {{ creatingAuth ? '提交中…' : '我确认创建替换授权' }}
          </button>
          <span v-if="enrolled.length === 0" class="muted small">当前没有在修课程，无法建立替换授权。</span>
        </div>
      </details>

      <div v-if="authorizations.length === 0" class="muted" style="margin-top: 10px">当前没有授权记录。</div>
      <div v-else class="table-wrap" style="margin-top: 10px">
        <table class="table">
          <thead>
            <tr>
              <th>用这门课替换</th>
              <th>想换成的课</th>
              <th>状态</th>
              <th>授予时间</th>
              <th>过期时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in authorizations" :key="row.id">
              <td>{{ row.sourceCourseName }}<span class="mono small">（{{ row.sourceClassCode ?? '—' }}）</span></td>
              <td>
                {{ row.targetCourseName }}
                <span class="mono small">（{{ row.targetClassCode ?? '不限教学班' }}）</span>
                <div v-if="row.note" class="small muted">{{ row.note }}</div>
              </td>
              <td>
                <span
                  class="badge"
                  :class="row.status === 'active' ? 'badge--ok' : row.status === 'invalidated' ? 'badge--danger' : 'badge--muted'"
                >
                  {{ authorizationStatusLabel(row.status) }}
                </span>
                <div v-if="row.usedAt" class="small muted">已于 {{ formatDateTime(row.usedAt) }} 使用</div>
              </td>
              <td class="small muted">{{ formatDateTime(row.grantedAt) }}</td>
              <td class="small muted">{{ formatDateTime(row.expiresAt) }}</td>
              <td>
                <div class="inline">
                  <button
                    class="btn btn--sm btn--primary"
                    type="button"
                    :disabled="row.status !== 'active' || actionEntryId === -row.id"
                    @click="useAuthorization(row)"
                  >
                    {{ actionEntryId === -row.id ? '替换中…' : '立即执行替换' }}
                  </button>
                  <button
                    class="btn btn--sm btn--danger"
                    type="button"
                    :disabled="row.status === 'used' || row.status === 'revoked'"
                    @click="revokeAuthorization(row)"
                  >
                    撤销
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">毕业兜底授权</h3>
      </div>
      <p class="tips">
        用途：毕业必须完成的课程如果排不进去，可以在你本人接受的教学班范围内由系统兜底安排（先用普通空位，再用毕业预留名额）。
        没有授权、或没有勾选任何教学班时，系统不会自动扩大范围，而是形成待处理异常交给管理员。
      </p>

      <details style="margin-top: 10px">
        <summary class="small" style="cursor: pointer">我要新增一条兜底授权</summary>
        <div class="grid grid--2" style="margin-top: 10px">
          <label class="field">
            <span class="field__label">课程</span>
            <select v-model.number="guaranteeForm.courseId" class="select" @change="onGuaranteeCourseChange">
              <option :value="null">请选择课程</option>
              <option v-for="course in courseOptions" :key="course.id" :value="course.id">
                {{ course.code }} {{ course.name }}
              </option>
            </select>
          </label>
        </div>
        <div v-if="guaranteeClasses.length > 0">
          <span class="field__label">我接受的教学班（可多选；没勾的不会被自动选择）</span>
          <div class="list">
            <label v-for="cls in guaranteeClasses" :key="cls.id" class="list__item">
              <span class="inline">
                <input type="checkbox" :checked="guaranteeForm.classIds.includes(cls.id)" @change="toggleGuaranteeClass(cls.id)" />
                <strong>{{ cls.classCode }}</strong>
                <span class="small muted">{{ cls.teacher?.name ?? '未指定教师' }}</span>
                <span class="small muted">{{ cls.sessions.map((s) => s.text).join('；') }}</span>
                <span class="spacer"></span>
                <span class="small muted">{{ cls.generalAvailable > 0 ? `还有 ${cls.generalAvailable} 个空位` : '名额已满' }}</span>
              </span>
            </label>
          </div>
        </div>
        <div class="inline" style="margin-top: 8px">
          <button class="btn btn--primary" type="button" :disabled="creatingGuarantee" @click="createGuaranteeAuthorization">
            {{ creatingGuarantee ? '提交中…' : '我确认毕业兜底授权' }}
          </button>
        </div>
      </details>

      <div v-if="guaranteeAuthorizations.length === 0" class="muted" style="margin-top: 10px">当前没有兜底授权记录。</div>
      <div v-else class="list" style="margin-top: 10px">
        <div v-for="row in guaranteeAuthorizations" :key="row.id" class="list__item">
          <div class="inline">
            <strong>{{ row.courseName }}</strong>
            <span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--muted'">
              {{ row.status === 'active' ? '有效' : authorizationStatusLabel(row.status) }}
            </span>
            <span class="spacer"></span>
            <button
              class="btn btn--sm btn--danger"
              type="button"
              :disabled="row.status !== 'active'"
              @click="revokeGuaranteeAuthorization(row)"
            >
              撤销
            </button>
          </div>
          <div class="small muted" style="margin-top: 4px">
            接受的教学班：<span class="mono">{{ row.classIds }}</span>
            · 授权时间 {{ formatDateTime(row.grantedAt) }}
            <template v-if="row.expiresAt"> · 过期时间 {{ formatDateTime(row.expiresAt) }}</template>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">我的选课时间轴</h3>
      </div>
      <div v-if="timeline.length === 0" class="muted">暂无批次记录。</div>
      <div v-else class="list">
        <div v-for="event in timeline" :key="event.batchId" class="list__item">
          <div class="inline">
            <strong>{{ event.batchName }}</strong>
            <span class="badge">{{ batchStatusLabel(event.status) }}</span>
            <span class="badge badge--muted">{{ event.term }}</span>
          </div>
          <div class="small muted">
            志愿：{{ event.preferenceStatus === 'submitted' ? `已提交（第 ${event.preferenceVersion} 版）` : event.preferenceStatus === 'withdrawn' ? '已撤回' : '未提交' }}
            · 提交时间 {{ formatDateTime(event.submittedAt) }}
            · 结果发布 {{ formatDateTime(event.publishedAt) }}
          </div>
          <div v-if="event.waitlist.length > 0" class="small muted">
            候补：{{ event.waitlist.map((item) => `${item.courseName}（${waitlistStatusLabel(item.status)}${item.position ? ` 第${item.position}位` : ''}）`).join('；') }}
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
