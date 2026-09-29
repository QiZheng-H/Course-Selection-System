<script setup lang="ts">
/**
 * 毕业保护名单（按待办组织）。
 *
 * 页面先回答“现在有什么问题要处理”，再给出“保护名单”，
 * 最后把授权与预留明细折叠进“详细信息”，避免管理员先看到技术表格。
 *
 * 业务边界：兜底授权与替换授权都必须由学生本人在系统里确认，
 * 管理员只能查看授权情况并提醒学生，不能代替学生同意退换课。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import { loadActivities, useActivity } from '@/stores/activity';
import type { AuthorizationRow, CourseDto, GuaranteeAuthorizationRow, GuaranteeConfirmResult, GuaranteeReservation, UserRow } from '@/api/types';
import { batchStatusLabel, formatDateTime } from '@/utils/labels';

/** 毕业必要课程能否全部安排：后端返回的可行性检查结果 */
interface GuaranteeFeasibilityStudent {
  studentId: number;
  studentNo: string;
  feasible: boolean;
  courseNames: string[];
  conflicts: Array<{ courseId?: number; courseIds?: number[]; courseNames: string[]; messages: string[] }>;
}

interface GuaranteeCourseState {
  courseId: number;
  courseName: string;
  releasable: boolean;
  activeReservations: number;
  fulfilled: number;
}

interface GuaranteeAuthorizationGap {
  studentId: number;
  studentNo: string;
  studentName: string;
  courses: string[];
}

interface GuaranteeBatchData {
  reservations: GuaranteeReservation[];
  feasibility: { students: GuaranteeFeasibilityStudent[]; releasable: GuaranteeCourseState[] };
  /** 服务端按“学生 × 课程”统计的缺兜底授权名单（不受前端分页影响） */
  authorizationGaps?: { studentCount: number; courseCount: number; students: GuaranteeAuthorizationGap[] };
}

/** 待办问题的四种展开内容 */
type ActionKey = 'slot' | 'authorization-gap' | 'conflict' | 'reservation';
type DetailMode = 'students' | 'courses' | 'reservation';

interface DetailItem {
  key: string;
  studentId: number | null;
  studentNo: string;
  studentName: string;
  courseId: number | null;
  className: string;
  messages: string[];
}

const toast = useToast();
const activity = useActivity();

const activityTerm = computed(() => activity.selected.value?.term ?? '');
const activityName = computed(() => activity.selected.value?.name ?? '');

const loading = ref(false);
const loadError = ref('');
const data = ref<GuaranteeBatchData | null>(null);

/** 第三屏：授权情况（只读） */
const authorizationLoading = ref(false);
const authorizationError = ref('');
const authorizationRows = ref<AuthorizationRow[]>([]);
const guaranteeAuthorizationRows = ref<GuaranteeAuthorizationRow[]>([]);
const authorizationNotice = ref('');

/** 展开的待办清单 */
const actionOpen = ref<ActionKey | null>(null);
const detailMode = ref<DetailMode>('students');
const detailItems = ref<DetailItem[]>([]);
const detailTitle = ref('');
const detailHint = ref('');

/** 保护名单筛选与分页 */
const listStudentFilter = ref('');
const listCourseFilter = ref('');
const listStatusFilter = ref('');
const listPage = ref(1);
const listPageSize = 10;

/** 确认保护名单 */
const courseKeyword = ref('');
const courseResults = ref<CourseDto[]>([]);
const courseSearched = ref(false);
const courseSearching = ref(false);
const selectedCourseId = ref<number | null>(null);
const studentKeyword = ref('');
const studentResults = ref<UserRow[]>([]);
const studentSearched = ref(false);
const studentSearching = ref(false);
const selectedStudentIds = ref<number[]>([]);
const confirmForm = reactive({ reason: '' });
const confirming = ref(false);
const lastSuggestion = ref<GuaranteeConfirmResult | null>(null);

const selectedCourse = computed(() => courseResults.value.find((item) => item.id === selectedCourseId.value) ?? null);

/** 需要补充预留名额的课程：预留未落实，或还有待落实的保护名单 */
const slotCourses = computed(() => {
  const rows = data.value?.feasibility.releasable ?? [];
  return rows.filter((row) => !row.releasable || (row.activeReservations > 0 && row.fulfilled === 0));
});

/** 毕业必要课程无法同时安排的学生 */
const conflictStudents = computed(() => (data.value?.feasibility.students ?? []).filter((student) => !student.feasible));

const reservations = computed<GuaranteeReservation[]>(() => data.value?.reservations ?? []);

/** 学号 → 已确认的毕业必要课程 */
const protectedByStudent = computed(() => {
  const map = new Map<string, GuaranteeReservation[]>();
  for (const row of reservations.value) {
    const key = row.studentNo || row.studentName;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
});

/** 学生 → 有效的兜底授权（学生本人确认后才有） */
const activeAuthorizationByStudent = computed(() => {
  const map = new Map<number, GuaranteeAuthorizationRow[]>();
  for (const row of guaranteeAuthorizationRows.value) {
    if (row.status !== 'active') continue;
    const list = map.get(row.studentId) ?? [];
    list.push(row);
    map.set(row.studentId, list);
  }
  return map;
});

/**
 * 缺少兜底授权的学生：以后端统计为准（按“学生 × 课程”判断，不受前端分页影响）。
 * 后端不可用时退回本地估算，但会明确标注仅供估算。
 */
const studentsWithoutAuthorization = computed<GuaranteeAuthorizationGap[]>(() => {
  const fromServer = data.value?.authorizationGaps?.students;
  if (fromServer) return fromServer;
  if (authorizationError.value) return [];
  const seen = new Set<number>();
  const result: GuaranteeAuthorizationGap[] = [];
  for (const row of reservations.value) {
    const studentId = findStudentId(row.studentNo);
    if (studentId === null || seen.has(studentId)) continue;
    seen.add(studentId);
    if ((activeAuthorizationByStudent.value.get(studentId) ?? []).length === 0) {
      result.push({ studentId, studentNo: row.studentNo, studentName: row.studentName, courses: [row.courseName] });
    }
  }
  return result;
});

/** 缺授权统计是否来自后端（否则是本地估算，需要提示管理员） */
const authorizationGapIsEstimate = computed(() => !data.value?.authorizationGaps);

/** 保护名单：筛选 + 分页 */
const filteredReservations = computed(() => {
  const student = listStudentFilter.value.trim().toLowerCase();
  const course = listCourseFilter.value.trim().toLowerCase();
  const status = listStatusFilter.value;
  return reservations.value.filter((row) => {
    if (student && !(`${row.studentName} ${row.studentNo}`.toLowerCase().includes(student))) return false;
    if (course && !row.courseName.toLowerCase().includes(course)) return false;
    if (status && row.status !== status) return false;
    return true;
  });
});

const listPageCount = computed(() => Math.max(1, Math.ceil(filteredReservations.value.length / listPageSize)));
const pagedReservations = computed(() => {
  const start = (listPage.value - 1) * listPageSize;
  return filteredReservations.value.slice(start, start + listPageSize);
});

function findStudentId(studentNo: string): number | null {
  const row = studentResults.value.find((item) => (item.studentNo ?? item.username) === studentNo);
  return row ? row.id : null;
}

/** 兜底授权记录只有学生编号，这里换成可读姓名 */
function currentStudentNameByUserId(studentId: number): string {
  const row = studentResults.value.find((item) => item.id === studentId);
  return row ? `${row.displayName}（${row.studentNo ?? row.username}）` : '';
}
function toggleAction(key: ActionKey): void {
  if (actionOpen.value === key) {
    actionOpen.value = null;
    return;
  }
  actionOpen.value = key;
  detailHint.value = '';
  if (key === 'slot') {
    detailMode.value = 'courses';
    detailTitle.value = '需要补充预留名额的课程';
    detailHint.value = '这些课程还有已确认的保护学生没有落实到教学班，需要在教学班配置里补充毕业保障预留名额。';
    detailItems.value = slotCourses.value.map((row) => ({
      key: `slot-${row.courseId}`,
      studentId: null,
      studentNo: '',
      studentName: '',
      courseId: row.courseId,
      className: row.courseName,
      messages: [
        row.activeReservations > 0
          ? `还有 ${row.activeReservations} 名已确认的保护学生没有落实到教学班`
          : '预留名额目前无法释放',
        row.fulfilled > 0 ? `已落实到教学班 ${row.fulfilled} 人` : '还没有学生落实到教学班',
      ],
    }));
  } else if (key === 'authorization-gap') {
    detailMode.value = 'students';
    detailTitle.value = '缺少兜底授权的学生';
    detailHint.value = authorizationGapIsEstimate.value
      ? '这里只提供名单和通知话术：兜底授权必须由学生本人在“结果与候补”页面确认，管理员不能代建。当前数字是本地估算，请点“刷新”从服务器重新统计。'
      : '这里只提供名单和通知话术：兜底授权必须由学生本人在“结果与候补”页面确认，管理员不能代建。统计来自服务器，按“学生 × 课程”逐条核对，不受分页影响。';
    detailItems.value = studentsWithoutAuthorization.value.map((row) => ({
      key: `auth-${row.studentId}`,
      studentId: row.studentId,
      studentNo: row.studentNo,
      studentName: row.studentName,
      courseId: null,
      className: '',
      messages: [
        `已确认的毕业必要课程：${row.courses.join('、')}`,
        '还没有有效的兜底授权，需要学生本人在系统里确认',
      ],
    }));
  } else if (key === 'conflict') {
    detailMode.value = 'students';
    detailTitle.value = '毕业必要课程无法同时安排的学生';
    detailHint.value =
      '这些学生的毕业必要课程时间互相冲突。可以调整冲突课程的教学班时间；如果必须换课，请让该学生本人在系统里确认替换授权。';
    detailItems.value = conflictStudents.value.map((student) => ({
      key: `conflict-${student.studentId}`,
      studentId: student.studentId,
      studentNo: student.studentNo,
      studentName: '',
      courseId: null,
      className: student.courseNames.join('、'),
      messages:
        student.conflicts.flatMap((conflict) => conflict.messages).length > 0
          ? student.conflicts.flatMap((conflict) => conflict.messages)
          : ['这些毕业必要课程的所有教学班两两冲突，无法同时安排'],
    }));
  }
}

function showReservationDetail(row: GuaranteeReservation): void {
  actionOpen.value = 'reservation';
  detailMode.value = 'reservation';
  detailTitle.value = '这条保护名单的预留情况';
  detailItems.value = [
    {
      key: `reservation-${row.id}`,
      studentId: findStudentId(row.studentNo),
      studentNo: row.studentNo,
      studentName: row.studentName,
      courseId: row.courseId,
      className: row.courseName,
      messages: [
        row.status === 'active' ? '这条保护名单已确认，但还没有落实到教学班' : `当前状态：${reservationStatusLabel(row.status)}`,
        row.reason ? `确认原因：${row.reason}` : '没有填写确认原因',
        row.confirmedAt ? `确认时间：${formatDateTime(row.confirmedAt)}` : '没有确认时间',
      ],
    },
  ];
}

function notifyStudent(item: DetailItem): void {
  toast.info('请通知学生本人确认', [
    `${item.studentName || '该学生'}（${item.studentNo}）需要自己登录系统，在“结果与候补”页面确认兜底授权或替换授权。`,
    '管理员不能代替学生同意退换课。',
  ]);
}

function adviseConflict(): void {
  toast.info('请调整教学班或联系学生', [
    '可以调整冲突课程的教学班时间；如果必须换课，请让该学生本人在系统里确认替换授权。',
  ]);
}

function toggleReservationDetail(): void {
  if (actionOpen.value === 'reservation') actionOpen.value = null;
  else toggleAction('slot');
}

async function loadGuarantee(): Promise<void> {
  const batchId = activity.selectedId.value;
  loading.value = true;
  loadError.value = '';
  data.value = null;
  try {
    data.value = await api.get<GuaranteeBatchData>('/admin/guarantee', { batchId: batchId ?? undefined });
    listPage.value = 1;
  } catch (error) {
    data.value = null;
    loadError.value = apiErrorInfo(error, '读取失败').message;
  } finally {
    loading.value = false;
  }
}

async function loadAuthorizations(): Promise<void> {
  const batchId = activity.selectedId.value;
  authorizationLoading.value = true;
  authorizationError.value = '';
  try {
    const result = await api.get<{
      authorizations: AuthorizationRow[];
      guaranteeAuthorizations: GuaranteeAuthorizationRow[];
      notice: string;
    }>('/admin/guarantee/authorizations', { batchId: batchId ?? undefined });
    authorizationRows.value = result.authorizations;
    guaranteeAuthorizationRows.value = result.guaranteeAuthorizations;
    authorizationNotice.value = result.notice;
  } catch (error) {
    authorizationRows.value = [];
    guaranteeAuthorizationRows.value = [];
    authorizationNotice.value = '';
    authorizationError.value = apiErrorInfo(error, '读取失败').message;
  } finally {
    authorizationLoading.value = false;
  }
}

async function searchCourses(): Promise<void> {
  courseSearched.value = true;
  courseSearching.value = true;
  try {
    const result = await api.get<{ items: CourseDto[] }>('/admin/courses', {
      keyword: courseKeyword.value.trim() || undefined,
      pageSize: 50,
    });
    courseResults.value = result.items;
  } catch (error) {
    courseResults.value = [];
    reportApiError(error, '搜索课程失败');
  } finally {
    courseSearching.value = false;
  }
}

function pickCourse(course: CourseDto): void {
  selectedCourseId.value = course.id;
}

async function searchStudents(): Promise<void> {
  studentSearched.value = true;
  studentSearching.value = true;
  try {
    const result = await api.get<{ items: UserRow[] }>('/admin/users', {
      role: 'student',
      keyword: studentKeyword.value.trim() || undefined,
      pageSize: 50,
    });
    studentResults.value = result.items;
  } catch (error) {
    studentResults.value = [];
    reportApiError(error, '搜索学生失败');
  } finally {
    studentSearching.value = false;
  }
}

function toggleStudent(studentId: number): void {
  if (selectedStudentIds.value.includes(studentId)) {
    selectedStudentIds.value = selectedStudentIds.value.filter((id) => id !== studentId);
  } else {
    selectedStudentIds.value = [...selectedStudentIds.value, studentId];
  }
}

function isAlreadyProtected(student: UserRow): boolean {
  const key = student.studentNo ?? student.username;
  const list = protectedByStudent.value.get(key) ?? [];
  return list.some((row) => row.courseId === selectedCourseId.value);
}

async function confirmGuaranteeList(): Promise<void> {
  const batchId = activity.selectedId.value;
  if (!batchId) {
    toast.warning('还没有选择选课活动', ['请先在页面顶部选择本轮选课活动。']);
    return;
  }
  if (selectedCourseId.value === null) {
    toast.warning('请先选择毕业必要课程', ['可以在“毕业必要课程”里搜索课程名称并选中。']);
    return;
  }
  if (selectedStudentIds.value.length === 0) {
    toast.warning('请先勾选学生', ['可以先按姓名或学号搜索，再勾选学生。']);
    return;
  }
  const course = selectedCourse.value;
  const names = selectedStudentIds.value.map((id) => {
    const row = studentResults.value.find((item) => item.id === id);
    return row ? `${row.displayName}（${row.studentNo ?? row.username}）` : '学生';
  });
  const ok = await askConfirm({
    title: '确认毕业保护名单',
    message: '确认后这些学生会被登记为“毕业必要课程”的保护对象，系统会为他们预留保障名额，并检查他们的毕业必要课程能不能全部安排。',
    details: [
      `毕业必要课程：${course ? `${course.code} ${course.name}` : '已选课程'}`,
      `涉及学生 ${names.length} 人：${names.slice(0, 8).join('、')}${names.length > 8 ? ' 等' : ''}`,
      '确认后学生已选上的课程不会被自动退掉，也不会自动替换课程。',
      '如果学生的毕业必要课程无法全部安排，或需要退掉/替换某门课，必须由学生本人在系统里确认兜底授权或替换授权，管理员不能代替学生同意。',
      '名单可以重新提交，但撤回与调整需要联系技术支持，请在提交前确认学生与课程无误。',
    ],
    confirmText: '确认名单',
    danger: false,
  });
  if (!ok) return;
  confirming.value = true;
  try {
    const result = await api.post<GuaranteeConfirmResult>('/admin/guarantee', {
      batchId,
      courseId: selectedCourseId.value,
      studentIds: selectedStudentIds.value,
      reason: confirmForm.reason.trim() || undefined,
    });
    lastSuggestion.value = result;
    toast.success('已确认毕业保护名单', [`更新 ${result.added} 条，当前保护 ${result.studentCount} 人`]);
    const infeasible = result.feasibility.filter((student) => !student.feasible);
    if (infeasible.length > 0) {
      toast.warning(
        '有学生的毕业必要课程无法全部安排',
        infeasible.map((student) => `${student.studentNo}：${student.courseNames.join('、')}`),
      );
    }
    selectedStudentIds.value = [];
    confirmForm.reason = '';
    await Promise.all([loadGuarantee(), loadAuthorizations()]);
  } catch (error) {
    reportApiError(error, '确认毕业保护名单失败');
  } finally {
    confirming.value = false;
  }
}

function reservationStatusLabel(status: string): string {
  if (status === 'active') return '已确认（待落实）';
  if (status === 'fulfilled') return '已落实';
  if (status === 'abnormal') return '异常，需要处理';
  if (status === 'released') return '已释放';
  return status;
}

function reservationStatusClass(status: string): string {
  if (status === 'fulfilled') return 'badge--ok';
  if (status === 'abnormal') return 'badge--danger';
  if (status === 'active') return 'badge--warn';
  return 'badge--muted';
}

function authorizationStatusLabel(status: string): string {
  if (status === 'active') return '有效';
  if (status === 'used') return '已使用';
  if (status === 'expired') return '已过期';
  if (status === 'revoked') return '已撤销';
  return status;
}

async function loadAll(): Promise<void> {
  listPage.value = 1;
  actionOpen.value = null;
  detailItems.value = [];
  await Promise.all([loadGuarantee(), loadAuthorizations()]);
  await searchStudents();
}

onMounted(async () => {
  await loadActivities();
  await loadAll();
});

watch(
  () => activity.selectedId.value,
  async (next, previous) => {
    if (next === previous) return;
    selectedCourseId.value = null;
    selectedStudentIds.value = [];
    lastSuggestion.value = null;
    await loadAll();
  },
);

watch(filteredReservations, () => {
  if (listPage.value > listPageCount.value) listPage.value = listPageCount.value;
});

watch(studentKeyword, () => {
  selectedStudentIds.value = [];
});
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">毕业保护名单</h1>
        <p class="page__desc">
          先处理需要跟进的毕业必要课程与学生，再维护毕业保护名单。保护名单会为学生预留毕业保障预留名额。
        </p>
      </div>
      <div class="inline">
        <span v-if="activityTerm" class="badge badge--muted">{{ activityTerm }}</span>
        <span v-if="activityName" class="muted small">{{ activityName }}</span>
        <span v-if="activity.selected.value" class="badge">{{ batchStatusLabel(activity.selected.value.status) }}</span>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="loadAll">刷新</button>
      </div>
    </div>

    <p v-if="!activity.selected.value" class="alert alert--warning">
      还没有选择选课活动，请先在页面顶部选择本轮选课活动。
    </p>

    <p v-if="loadError" class="alert alert--error">
      <strong>读取失败</strong>：{{ loadError }}
      <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="loadGuarantee">重试</button>
    </p>

    <template v-if="!loadError">
      <h2 class="card__title">需要处理的问题</h2>

      <div class="grid grid--3">
        <div class="stat">
          <div class="stat__label">需要补充预留名额的课程</div>
          <div class="stat__value">{{ loading ? '…' : slotCourses.length }}</div>
          <div class="stat__extra">
            已确认保护名单，但预留名额还没有落实到教学班
            <div>
              <button
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="loading || slotCourses.length === 0"
                @click="toggleAction('slot')"
              >
                {{ actionOpen === 'slot' ? '收起名单' : '查看名单' }}
              </button>
            </div>
          </div>
        </div>

        <div class="stat">
          <div class="stat__label">缺少兜底授权的学生</div>
          <div class="stat__value">{{ authorizationError ? '—' : studentsWithoutAuthorization.length }}</div>
          <div v-if="authorizationGapIsEstimate && !authorizationError" class="stat__extra">本地估算，刷新后以服务器统计为准</div>
          <div class="stat__extra">
            兜底授权必须由学生本人在“结果与候补”页面确认，管理员不能代建
            <div>
              <button
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="authorizationLoading || studentsWithoutAuthorization.length === 0"
                @click="toggleAction('authorization-gap')"
              >
                {{ actionOpen === 'authorization-gap' ? '收起名单' : '查看名单' }}
              </button>
            </div>
          </div>        </div>

        <div class="stat">
          <div class="stat__label">毕业必要课程无法同时安排的学生</div>
          <div class="stat__value">{{ loading ? '…' : conflictStudents.length }}</div>
          <div class="stat__extra">
            这些学生的毕业必要课程时间互相冲突，需要调整教学班或由学生本人确认替换
            <div>
              <button
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="loading || conflictStudents.length === 0"
                @click="toggleAction('conflict')"
              >
                {{ actionOpen === 'conflict' ? '收起名单' : '查看名单' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <p v-if="authorizationError" class="alert alert--error">
        <strong>读取失败</strong>：{{ authorizationError }}
        <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="loadAuthorizations">重试</button>
      </p>

      <section v-if="actionOpen" class="card">
        <div class="card__header">
          <h3 class="card__title">{{ detailTitle }}</h3>
          <button class="btn btn--ghost btn--sm" type="button" @click="actionOpen = null">收起</button>
        </div>

        <div v-if="detailItems.length === 0" class="empty">这条待办目前没有需要处理的对象。</div>
        <template v-else>
          <p v-if="detailHint" class="small muted">{{ detailHint }}</p>
          <div class="todo">
            <div class="todo__items">
              <div
                v-for="item in detailItems"
                :key="item.key"
                class="todo__item"
                :class="{ 'todo--critical': actionOpen === 'conflict' }"
              >
                <div class="todo__title">
                  <template v-if="detailMode === 'courses'">{{ item.className }}</template>
                  <template v-else>
                    {{ item.studentName || '学生' }}{{ item.studentNo ? `（${item.studentNo}）` : '' }}
                  </template>
                </div>
                <div class="todo__detail">
                  <template v-if="detailMode === 'reservation'">
                    <div>课程：{{ item.className }}</div>
                    <div v-for="(line, index) in item.messages" :key="index">{{ line }}</div>
                  </template>
                  <template v-else>
                    <div v-for="(line, index) in item.messages" :key="index">{{ line }}</div>
                  </template>
                </div>
                <div class="inline">
                  <button
                    v-if="actionOpen === 'authorization-gap'"
                    class="btn btn--sm btn--primary"
                    type="button"
                    @click="notifyStudent(item)"
                  >
                    去通知学生
                  </button>
                  <button
                    v-else-if="actionOpen === 'conflict'"
                    class="btn btn--sm btn--ghost"
                    type="button"
                    @click="adviseConflict"
                  >
                    处理建议
                  </button>
                  <span v-else-if="actionOpen === 'slot'" class="muted small">
                    请在“教学班配置”里为这门课程补充毕业保障预留名额。
                  </span>
                  <span v-else class="muted small">预留名额的最终调整在教学班配置里完成，系统不会自动修改容量。</span>
                </div>
              </div>
            </div>
          </div>
        </template>
      </section>

      <section class="card">
        <div class="card__header">
          <h3 class="card__title">毕业保护名单</h3>
          <span class="badge">{{ filteredReservations.length }} 条</span>
        </div>

        <div class="grid grid--3">
          <label class="field">
            <span class="field__label">按学生筛选</span>
            <input v-model="listStudentFilter" class="input" type="text" placeholder="姓名或学号" />
          </label>
          <label class="field">
            <span class="field__label">按课程筛选</span>
            <input v-model="listCourseFilter" class="input" type="text" placeholder="课程名称" />
          </label>
          <label class="field">
            <span class="field__label">按状态筛选</span>
            <select v-model="listStatusFilter" class="select">
              <option value="">全部状态</option>
              <option value="active">已确认（待落实）</option>
              <option value="fulfilled">已落实</option>
              <option value="abnormal">异常，需要处理</option>
              <option value="released">已释放</option>
            </select>
          </label>
        </div>

        <div v-if="loading" class="muted">正在读取…</div>
        <div v-else-if="reservations.length === 0" class="empty">还没有确认任何毕业保护名单。</div>
        <div v-else-if="filteredReservations.length === 0" class="empty">没有符合筛选条件的名单。</div>
        <template v-else>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>学生</th>
                  <th>毕业必要课程</th>
                  <th>状态</th>
                  <th>确认时间</th>
                  <th>原因</th>
                  <th>预留情况</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in pagedReservations" :key="row.id">
                  <td>
                    {{ row.studentName }}
                    <div class="mono small muted">{{ row.studentNo }}</div>
                  </td>
                  <td>{{ row.courseName }}</td>
                  <td>
                    <span class="badge" :class="reservationStatusClass(row.status)">{{ reservationStatusLabel(row.status) }}</span>
                  </td>
                  <td class="small muted">{{ formatDateTime(row.confirmedAt) }}</td>
                  <td class="small muted">{{ row.reason ?? '—' }}</td>
                  <td>
                    <button class="btn btn--sm btn--ghost" type="button" @click="showReservationDetail(row)">查看预留</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="inline">
            <span class="muted small">
              共 {{ filteredReservations.length }} 条 · 第 {{ listPage }} / {{ listPageCount }} 页
            </span>
            <span class="spacer"></span>
            <button class="btn btn--ghost btn--sm" type="button" :disabled="listPage <= 1" @click="listPage -= 1">上一页</button>
            <button
              class="btn btn--ghost btn--sm"
              type="button"
              :disabled="listPage >= listPageCount"
              @click="listPage += 1"
            >
              下一页
            </button>
          </div>
        </template>
      </section>

      <section class="card">
        <div class="card__header">
          <h3 class="card__title">确认毕业保护名单</h3>
          <span class="muted small">按课程添加需要保护的学生</span>
        </div>

        <div class="grid grid--3">
          <div class="field">
            <span class="field__label">第一步：选择毕业必要课程</span>
            <div class="inline">
              <input
                v-model="courseKeyword"
                class="input"
                type="text"
                placeholder="课程名称或课程代码"
                @keyup.enter="searchCourses"
              />
              <button class="btn btn--ghost btn--sm" type="button" :disabled="courseSearching" @click="searchCourses">
                {{ courseSearching ? '搜索中…' : '搜索' }}
              </button>
            </div>
            <div v-if="selectedCourseId !== null" class="small">
              已选课程：<strong>{{ selectedCourse ? `${selectedCourse.code} ${selectedCourse.name}` : '已选课程' }}</strong>
            </div>
            <div class="small muted">
              <template v-if="courseResults.length > 0">
                找到 {{ courseResults.length }} 门课程，点击课程名称即可选中：
                <div class="inline">
                  <button
                    v-for="course in courseResults"
                    :key="course.id"
                    class="btn btn--sm"
                    :class="course.id === selectedCourseId ? 'btn--primary' : 'btn--ghost'"
                    type="button"
                    @click="pickCourse(course)"
                  >
                    {{ course.code }} {{ course.name }}
                  </button>
                </div>
              </template>
              <template v-else-if="courseSearched">没有找到课程，请换一个关键词。</template>
              <template v-else>请输入课程名称或课程代码后点“搜索”。</template>
            </div>
          </div>

          <div class="field">
            <span class="field__label">第二步：搜索并勾选学生</span>
            <div class="inline">
              <input
                v-model="studentKeyword"
                class="input"
                type="text"
                placeholder="姓名或学号"
                @keyup.enter="searchStudents"
              />
              <button class="btn btn--ghost btn--sm" type="button" :disabled="studentSearching" @click="searchStudents">
                {{ studentSearching ? '搜索中…' : '搜索' }}
              </button>
            </div>
            <span class="small muted">已勾选 {{ selectedStudentIds.length }} 人，切换搜索会清空已勾选的学生。</span>
          </div>

          <label class="field">
            <span class="field__label">第三步：确认原因（可选）</span>
            <input v-model="confirmForm.reason" class="input" type="text" placeholder="例如：毕业年级必须完成" />
          </label>
        </div>

        <div v-if="studentSearched" class="table-wrap">
          <div v-if="studentResults.length === 0" class="empty">没有找到学生，请换一个姓名或学号。</div>
          <table v-else class="table table--compact">
            <thead>
              <tr>
                <th>勾选</th>
                <th>学号</th>
                <th>姓名</th>
                <th>年级 / 专业</th>
                <th>是否已在名单</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="student in studentResults" :key="student.id">
                <td>
                  <input
                    class="checkbox"
                    type="checkbox"
                    :checked="selectedStudentIds.includes(student.id)"
                    @change="toggleStudent(student.id)"
                  />
                </td>
                <td class="mono">{{ student.studentNo ?? student.username }}</td>
                <td>{{ student.displayName }}</td>
                <td class="small muted">{{ student.grade ?? '—' }} / {{ student.major ?? '—' }}</td>
                <td>
                  <span v-if="isAlreadyProtected(student)" class="badge badge--muted">已在该课程名单里</span>
                  <span v-else class="muted small">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else class="muted small">先按姓名或学号搜索学生，再从结果里勾选要保护的学生。</div>

        <div class="inline">
          <button
            class="btn btn--primary"
            type="button"
            :disabled="confirming || !activity.selected.value || selectedCourseId === null || selectedStudentIds.length === 0"
            @click="confirmGuaranteeList"
          >
            {{ confirming ? '提交中…' : '确认毕业保护名单' }}
          </button>
          <button class="btn btn--ghost btn--sm" type="button" :disabled="selectedStudentIds.length === 0" @click="selectedStudentIds = []">
            清空勾选
          </button>
        </div>

        <p class="tips">
          提交前会让你再确认一次，并列出会影响的学生。系统只登记保护名单和预留名额，不会自动退课或换课；
          如果学生需要退掉或替换课程，必须由学生本人在系统里确认授权。
        </p>
      </section>

      <section v-if="lastSuggestion" class="card">
        <div class="card__header">
          <h3 class="card__title">刚才提交后的预留建议</h3>
          <span class="badge">该课程当前保护 {{ lastSuggestion.studentCount }} 人</span>
        </div>
        <div v-if="lastSuggestion.reservationSuggestion.length === 0" class="muted">该课程还没有开放的教学班。</div>
        <div v-else class="table-wrap">
          <table class="table table--compact">
            <thead>
              <tr>
                <th>教学班</th>
                <th>建议预留名额</th>
                <th>教学班容量</th>
                <th>当前已预留</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in lastSuggestion.reservationSuggestion" :key="row.classId">
                <td class="mono">{{ row.classCode }}</td>
                <td>{{ row.suggested }}</td>
                <td>{{ row.capacity }}</td>
                <td>{{ row.currentReserved }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="tips">建议值仅供参考，最终名额调整请在教学班配置里完成，系统不会自动修改容量。</p>
      </section>

      <section class="card card--flat">
        <div class="card__header">
          <h3 class="card__title">详细信息：授权情况与预留明细</h3>
          <div class="inline">
            <button class="btn btn--ghost btn--sm" type="button" @click="toggleReservationDetail">
              {{ actionOpen === 'slot' ? '收起待办课程明细' : '查看待办课程明细' }}
            </button>
            <button class="btn btn--ghost btn--sm" type="button" :disabled="authorizationLoading" @click="loadAuthorizations">
              {{ authorizationLoading ? '读取中…' : '刷新授权' }}
            </button>
          </div>
        </div>

        <p class="tips">
          兜底授权与替换授权都必须由学生本人在“结果与候补”页面确认，管理员确认毕业资格不能代替学生同意退换课。
        </p>

        <p v-if="authorizationError" class="alert alert--error">
          <strong>读取失败</strong>：{{ authorizationError }}
          <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="loadAuthorizations">重试</button>
        </p>

        <p v-if="authorizationNotice" class="small muted">{{ authorizationNotice }}</p>

        <h4 class="card__title">兜底授权（学生本人确认，只读）</h4>
        <div v-if="authorizationLoading" class="muted">正在读取…</div>
        <div v-else-if="authorizationError" class="muted">授权情况未取得，请重试。</div>
        <div v-else-if="guaranteeAuthorizationRows.length === 0" class="muted">当前活动还没有学生确认兜底授权。</div>
        <div v-else class="table-wrap">
          <table class="table table--compact">
            <thead>
              <tr>
                <th>学生</th>
                <th>毕业必要课程</th>
                <th>接受的教学班</th>
                <th>状态</th>
                <th>过期时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in guaranteeAuthorizationRows" :key="row.id">
                <td>{{ currentStudentNameByUserId(row.studentId) || '学生' }}</td>
                <td>{{ row.courseName }}</td>
                <td>{{ row.classIds ? '已指定接受的教学班' : '未指定' }}</td>
                <td>
                  <span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--muted'">
                    {{ authorizationStatusLabel(row.status) }}
                  </span>
                </td>
                <td class="small muted">{{ formatDateTime(row.expiresAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h4 class="card__title">替换授权（用某门课替换另一门课，学生本人确认，只读）</h4>
        <div v-if="authorizationLoading" class="muted">正在读取…</div>
        <div v-else-if="authorizationError" class="muted">授权情况未取得，请重试。</div>
        <div v-else-if="authorizationRows.length === 0" class="muted">当前活动还没有学生确认替换授权。</div>
        <div v-else class="table-wrap">
          <table class="table table--compact">
            <thead>
              <tr>
                <th>学生</th>
                <th>原课程</th>
                <th>用来替换的课程</th>
                <th>状态</th>
                <th>过期时间</th>
                <th>使用时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in authorizationRows" :key="row.id">
                <td>
                  {{ row.studentName ?? '学生' }}
                  <div v-if="row.studentNo" class="mono small muted">{{ row.studentNo }}</div>
                </td>
                <td>{{ row.sourceCourseName }}</td>
                <td>{{ row.targetCourseName }}</td>
                <td>
                  <span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--muted'">
                    {{ authorizationStatusLabel(row.status) }}
                  </span>
                </td>
                <td class="small muted">{{ formatDateTime(row.expiresAt) }}</td>
                <td class="small muted">{{ formatDateTime(row.usedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h4 class="card__title">预留明细（按课程）</h4>
        <div v-if="loading" class="muted">正在读取…</div>
        <div v-else-if="(data?.feasibility.releasable.length ?? 0) === 0" class="muted">当前活动还没有毕业保障预留记录。</div>
        <div v-else class="table-wrap">
          <table class="table table--compact">
            <thead>
              <tr>
                <th>毕业必要课程</th>
                <th>预留名额状态</th>
                <th>已确认保护人数</th>
                <th>已落实到教学班</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in data?.feasibility.releasable ?? []" :key="row.courseId">
                <td>{{ row.courseName }}</td>
                <td>
                  <span class="badge" :class="row.releasable ? 'badge--ok' : 'badge--warn'">
                    {{ row.releasable ? '当前可以释放' : '仍有学生待落实' }}
                  </span>
                </td>
                <td>{{ row.activeReservations }}</td>
                <td>{{ row.fulfilled }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
