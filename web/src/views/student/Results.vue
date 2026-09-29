<script setup lang="ts">
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
  WaitlistEntry,
  WaitlistPayload,
  WaitlistQueuePayload,
  WaitlistRecheckResult,
} from '@/api/types';
import {
  authorizationStatusLabel,
  batchStatusLabel,
  demandLabel,
  formatCredits,
  formatDateTime,
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

const queue = ref<WaitlistQueuePayload | null>(null);
const queueCourseName = ref('');

const authorizations = ref<AuthorizationRow[]>([]);
const guaranteeAuthorizations = ref<GuaranteeAuthorizationRow[]>([]);
const timeline = ref<TimelineEvent[]>([]);

/** 学生本人创建替换授权：原教学班取自已选课程，目标课程可指定教学班 */
const enrolled = ref<EnrolledRow[]>([]);
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

const canEdit = computed(() => payload.value?.canEdit ?? false);

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
  } catch (error) {
    reportApiError(error, '读取已选课程失败');
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
    toast.success('已创建替换授权', ['到候补阶段可以点“使用授权自动替换”，或用它参与更高偏好的自动升级。']);
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
  if (form.courseId === null) return;
  try {
    const data = await api.get<{ items: ClassDto[] }>('/classes', { courseId: form.courseId, pageSize: 100 });
    formClasses.value = data.items;
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
  void onCourseChange();
  toast.info('已载入候补申请', ['修改后会按当前需求、排名与固定随机键重新排序。']);
}

async function submitWaitlist(): Promise<void> {
  if (batchId.value === null) return;
  if (form.courseId === null) {
    toast.warning('请先选择要候补的课程');
    return;
  }
  const existing = payload.value?.entries.find((entry) => entry.courseId === form.courseId);
  const ok = await askConfirm({
    title: existing ? '修改候补申请' : '新增候补申请',
    message: existing
      ? '修改后系统会按“当前需求 + 当前排名 + 固定随机键”重新排序，顺位可能前后移动。'
      : '新增候补后，只有当仍有普通名额且轮到你时才会被提升；暂挂或关闭时会给出原因。',
    details: form.classIds.length > 0 ? [`教学班偏好：${form.classIds.join(' → ')}`] : ['未指定教学班偏好'],
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
    form.courseId = null;
    form.classIds = [];
    form.globalRank = null;
    formClasses.value = [];
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
    message: '系统会重新评估时间冲突、学分与授权条件，满足条件的申请会尝试提升。',
    confirmText: '开始检查',
    danger: false,
  });
  if (!ok) return;
  rechecking.value = true;
  try {
    const result = await api.post<WaitlistRecheckResult>('/waitlist/recheck', { batchId: batchId.value });
    toast.success('检查完成', [
      `检查 ${result.checked} 条：提升 ${result.promoted}，暂挂 ${result.suspended}，关闭 ${result.closed}`,
    ]);
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

async function showQueue(entry: WaitlistEntry): Promise<void> {
  if (batchId.value === null) return;
  try {
    queue.value = await api.get<WaitlistQueuePayload>('/waitlist/queue', {
      batchId: batchId.value,
      courseId: entry.courseId,
    });
    queueCourseName.value = entry.courseName;
  } catch (error) {
    reportApiError(error, '读取队列失败');
  }
}

function rankText(entry: WaitlistEntry): string {
  if (entry.position === null) return '—';
  return `第 ${entry.position} 位（前面 ${entry.queuedAhead ?? 0} 人）`;
}

onMounted(async () => {
  await loadBatches();
  await loadCourses();
  await Promise.all([loadAuthorizations(), loadEnrolled()]);
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
          候补展示的是“当前顺位”，不承诺永不后移；队列只显示顺位，不显示其他人身份。
        </p>
      </div>
      <div class="inline">
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">批次</span>
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
          {{ rechecking ? '检查中…' : '重新检查' }}
        </button>
      </div>
    </div>

    <p v-if="errorMessage" class="alert alert--error">{{ errorMessage }}</p>
    <p v-if="!loading && batches.length === 0" class="alert alert--warning">
      当前没有任何选课批次，候补功能不可用。请等待管理员创建并开放批次后再回来查看。
    </p>
    <p v-if="payload && !canEdit" class="alert alert--warning">
      当前批次状态为「{{ batchStatusLabel(payload.batch.status) }}」，此阶段不允许新增或修改候补申请（仍可退出与重新检查）。
    </p>
    <p class="alert alert--info">
      名额会优先给合格候补；只有当没有合格候补且名额不受毕业保障保护时，才允许公开补选。
    </p>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">新增 / 修改候补申请</h3>
      </div>
      <div class="grid grid--3">
        <label class="field">
          <span class="field__label">课程</span>
          <select v-model.number="form.courseId" class="select" @change="onCourseChange">
            <option :value="null">请选择课程</option>
            <option v-for="course in courseOptions" :key="course.id" :value="course.id">
              {{ course.code }} {{ course.name }}（{{ formatCredits(course.credits) }} 学分）
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">候补排名（可选，越小越优先）</span>
          <input v-model.number="form.globalRank" class="input" type="number" min="1" step="1" placeholder="留空沿用原排名" />
        </label>
        <div class="field">
          <span class="field__label">搜索课程</span>
          <div class="inline">
            <input v-model="courseKeyword" class="input" type="text" placeholder="课程名或课程号" @keyup.enter="loadCourses" />
            <button class="btn btn--ghost btn--sm" type="button" @click="loadCourses">搜索</button>
          </div>
        </div>
      </div>

      <div v-if="formClasses.length > 0">
        <span class="field__label">教学班偏好（可选，可多选；排在最前的优先）</span>
        <div class="list">
          <label v-for="cls in formClasses" :key="cls.id" class="list__item">
            <span class="inline">
              <input type="checkbox" :checked="isSelectedClass(cls.id)" @change="toggleClass(cls.id)" />
              <strong>{{ cls.classCode }}</strong>
              <span class="badge" :class="cls.status === 'open' ? 'badge--ok' : 'badge--danger'">{{ cls.status }}</span>
              <span class="small muted">{{ cls.teacher?.name ?? '未指定教师' }}</span>
              <span class="small muted">{{ cls.sessions.map((s) => s.text).join('；') }}</span>
              <span class="spacer"></span>
              <span class="small muted">普通余量 {{ cls.generalAvailable }} / 预留 {{ cls.reservedSeats }}</span>
            </span>
          </label>
        </div>
      </div>

      <div class="inline" style="margin-top: 10px">
        <button class="btn btn--primary" type="button" :disabled="submitting || !canEdit" @click="submitWaitlist">
          {{ submitting ? '提交中…' : '提交候补申请' }}
        </button>
        <span v-if="!canEdit" class="muted small">当前批次状态不允许修改候补。</span>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">我的候补申请</h3>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading || batchId === null" @click="onBatchChange">
          刷新
        </button>
      </div>
      <div v-if="!payload || payload.entries.length === 0" class="empty">当前批次还没有候补申请。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>课程</th>
              <th>状态</th>
              <th>当前顺位</th>
              <th>需求等级</th>
              <th>随机键</th>
              <th>暂挂/关闭原因</th>
              <th>容量情况</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in payload.entries" :key="entry.id">
              <td>
                {{ entry.courseName }}
                <div class="mono small">{{ entry.courseCode }} · {{ formatCredits(entry.credits) }} 学分</div>
                <div v-if="entry.classChoices.length > 0" class="small muted">教学班偏好：{{ entry.classChoices.join(' → ') }}</div>
              </td>
              <td>
                <span
                  class="badge"
                  :class="
                    entry.status === 'queued'
                      ? 'badge--ok'
                      : entry.status === 'suspended'
                        ? 'badge--warn'
                        : entry.status === 'promoted'
                          ? 'badge--ok'
                          : 'badge--muted'
                  "
                >
                  {{ waitlistStatusLabel(entry.status) }}
                </span>
                <div class="small muted">更新：{{ formatDateTime(entry.updatedAt) }}</div>
              </td>
              <td>
                {{ rankText(entry) }}
                <div v-if="entry.positionReason" class="small muted">顺位变化：{{ entry.positionReason }}</div>
              </td>
              <td>{{ demandLabel(entry.demandLevel) }}</td>
              <td class="mono small">{{ entry.randomKey ? `${entry.randomKey.slice(0, 12)}…` : '—' }}</td>
              <td class="small">
                <div v-if="entry.suspendCode">
                  暂挂 [{{ entry.suspendCode }}]：{{ entry.suspendHint ?? entry.suspendReason ?? '条件暂不满足' }}
                </div>
                <div v-else-if="entry.closeCode">
                  关闭 [{{ entry.closeCode }}]：{{ entry.closeReason ?? '申请已永久失效' }}
                </div>
                <span v-else class="muted">—</span>
              </td>
              <td class="small">
                开放教学班 {{ entry.capacity.openClasses }} 个<br />
                普通余量 {{ entry.capacity.generalAvailable }}<br />
                排队 {{ entry.capacity.queued }} 人
              </td>
              <td>
                <div class="inline">
                  <button class="btn btn--sm btn--ghost" type="button" @click="showQueue(entry)">查看队列</button>
                  <button class="btn btn--sm btn--ghost" type="button" :disabled="!canEdit" @click="startEdit(entry)">修改</button>
                  <button
                    class="btn btn--sm btn--danger"
                    type="button"
                    :disabled="actionEntryId === entry.id || entry.status === 'withdrawn'"
                    @click="withdrawEntry(entry)"
                  >
                    退出
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="queue" class="card">
      <div class="card__header">
        <h3 class="card__title">队列情况：{{ queueCourseName }}</h3>
        <button class="btn btn--ghost btn--sm" type="button" @click="queue = null">关闭</button>
      </div>
      <div class="inline">
        <span class="badge">队列长度 {{ queue.length }}</span>
        <span class="badge" :class="queue.myPosition ? 'badge--ok' : 'badge--muted'">
          {{ queue.myPosition ? `我的顺位：第 ${queue.myPosition} 位` : '我不在该队列中' }}
        </span>
      </div>
      <p class="tips" style="margin-top: 8px">下面是排在你前面（不含你本人）的顺位信息，仅展示顺位与需求等级，不展示任何身份信息。</p>
      <div v-if="queue.ahead.length === 0" class="muted small">你前面没有其他候补。</div>
      <div v-else class="table-wrap">
        <table class="table table--compact">
          <thead>
            <tr>
              <th>顺位</th>
              <th>需求等级</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in queue.ahead" :key="row.position">
              <td>第 {{ row.position }} 位</td>
              <td>{{ demandLabel(row.demandLevel) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">升级（替换）授权</h3>
      </div>
      <p class="tips">
        替换授权必须由你本人确认：同意系统用一门目标课程替换你当前已选的原教学班。管理员确认毕业资格不能代替你同意退换课程。
        执行“使用授权自动替换”时会先检查替换后的完整课表，成立才在同一事务内落实目标课并释放原课；失败会保留原课。
      </p>

      <div class="grid grid--3" style="margin-top: 8px">
        <label class="field">
          <span class="field__label">原教学班（当前在修）</span>
          <select v-model.number="authForm.sourceClassId" class="select">
            <option :value="null">请选择</option>
            <option v-for="row in enrolled" :key="row.classId" :value="row.classId">
              {{ row.courseName }}（{{ row.classId }}）
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">目标课程</span>
          <select v-model.number="authForm.targetCourseId" class="select" @change="onAuthSourceChange">
            <option :value="null">请选择</option>
            <option v-for="course in courseOptions" :key="course.id" :value="course.id">
              {{ course.code }} {{ course.name }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">目标教学班（可选，留空表示符合资格与时间限制的班）</span>
          <select v-model.number="authForm.targetClassId" class="select">
            <option :value="null">不指定</option>
            <option v-for="cls in targetClasses" :key="cls.id" :value="cls.id">
              {{ cls.classCode }}（普通余量 {{ cls.generalAvailable }}）
            </option>
          </select>
        </label>
      </div>
      <label class="field">
        <span class="field__label">授权过期时间（可选）</span>
        <input v-model="authForm.expiresAt" class="input" type="datetime-local" />
      </label>
      <div class="inline" style="margin-top: 8px">
        <button class="btn btn--primary" type="button" :disabled="creatingAuth" @click="createAuthorization">
          {{ creatingAuth ? '提交中…' : '我确认创建替换授权' }}
        </button>
        <span v-if="enrolled.length === 0" class="muted small">当前没有在修课程，无法建立替换授权。</span>
      </div>

      <div v-if="authorizations.length === 0" class="muted" style="margin-top: 10px">当前没有授权记录。</div>
      <div v-else class="table-wrap" style="margin-top: 10px">
        <table class="table">
          <thead>
            <tr>
              <th>原课程 / 教学班</th>
              <th>目标课程 / 教学班</th>
              <th>状态</th>
              <th>授予时间</th>
              <th>过期时间</th>
              <th>使用时间</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in authorizations" :key="row.id">
              <td>{{ row.sourceCourseName }}<span class="mono small">（{{ row.sourceClassCode ?? '—' }}）</span></td>
              <td>{{ row.targetCourseName }}<span class="mono small">（{{ row.targetClassCode ?? '不限' }}）</span></td>
              <td>
                <span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--muted'">
                  {{ authorizationStatusLabel(row.status) }}
                </span>
              </td>
              <td class="small muted">{{ formatDateTime(row.grantedAt) }}</td>
              <td class="small muted">{{ formatDateTime(row.expiresAt) }}</td>
              <td class="small muted">{{ formatDateTime(row.usedAt) }}</td>
              <td class="small muted">{{ row.note ?? '—' }}</td>
              <td>
                <div class="inline">
                  <button
                    class="btn btn--sm btn--primary"
                    type="button"
                    :disabled="row.status !== 'active' || actionEntryId === -row.id"
                    @click="useAuthorization(row)"
                  >
                    {{ actionEntryId === -row.id ? '替换中…' : '使用授权自动替换' }}
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
        只有你本人明确接受的教学班，系统才会在毕业保障中自动安排（先用可用普通名额，再用毕业预留）。
        没有授权或未接受任何教学班时，系统不会自动扩大选择，而是形成待处理异常等待管理员处理。
      </p>
      <div class="grid grid--2">
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
        <span class="field__label">我接受的教学班（可多选）</span>
        <div class="list">
          <label v-for="cls in guaranteeClasses" :key="cls.id" class="list__item">
            <span class="inline">
              <input type="checkbox" :checked="guaranteeForm.classIds.includes(cls.id)" @change="toggleGuaranteeClass(cls.id)" />
              <strong>{{ cls.classCode }}</strong>
              <span class="small muted">{{ cls.teacher?.name ?? '未指定教师' }}</span>
              <span class="small muted">{{ cls.sessions.map((s) => s.text).join('；') }}</span>
              <span class="spacer"></span>
              <span class="small muted">普通余量 {{ cls.generalAvailable }} / 预留 {{ cls.reservedSeats }}</span>
            </span>
          </label>
        </div>
      </div>
      <div class="inline" style="margin-top: 8px">
        <button class="btn btn--primary" type="button" :disabled="creatingGuarantee" @click="createGuaranteeAuthorization">
          {{ creatingGuarantee ? '提交中…' : '我确认毕业兜底授权' }}
        </button>
      </div>

      <div v-if="guaranteeAuthorizations.length === 0" class="muted" style="margin-top: 10px">当前没有兜底授权记录。</div>
      <div v-else class="table-wrap" style="margin-top: 10px">
        <table class="table table--compact">
          <thead>
            <tr>
              <th>课程</th>
              <th>接受的教学班</th>
              <th>状态</th>
              <th>授权时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in guaranteeAuthorizations" :key="row.id">
              <td>{{ row.courseName }}</td>
              <td class="mono small">{{ row.classIds }}</td>
              <td>
                <span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--muted'">{{ row.status }}</span>
              </td>
              <td class="small muted">{{ formatDateTime(row.grantedAt) }}</td>
              <td>
                <button
                  class="btn btn--sm btn--danger"
                  type="button"
                  :disabled="row.status !== 'active'"
                  @click="revokeGuaranteeAuthorization(row)"
                >
                  撤销
                </button>
              </td>
            </tr>
          </tbody>
        </table>
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
            志愿状态：{{ event.preferenceStatus === 'submitted' ? `已提交 v${event.preferenceVersion}` : event.preferenceStatus === 'withdrawn' ? '已撤回' : '未提交' }}
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
