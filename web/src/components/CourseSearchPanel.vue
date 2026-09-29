<script setup lang="ts">
/**
 * 课程检索面板（从原「课程检索」独立页面抽出的可复用组件）。
 * 功能与独立页面完全一致：筛选、分页、教学班详情、资格与补选提示、选课 / 退课 / 换班、“我的已选课程”。
 * 额外通过 `add` 事件把课程交给宿主（志愿页第 1 步用它加入「待排清单」）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { newIdempotencyKey } from '@/api/idempotency';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type {
  ClassDto,
  CourseDetail,
  CourseDto,
  Eligibility,
  EnrolledRow,
  EnrollmentOperationResult,
} from '@/api/types';
import { courseTypeLabel, formatCredits, sourceLabel } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

const props = defineProps<{ inDraft: (courseId: number) => boolean }>();
const emit = defineEmits<{ (e: 'add', course: CourseDto): void }>();

const toast = useToast();

const filters = reactive({
  keyword: '',
  department: '',
  courseType: '',
  term: '',
  onlyAvailable: false,
});

const departments = ref<string[]>([]);
const terms = ref<string[]>([]);
const courses = ref<CourseDto[]>([]);
const courseTotal = ref(0);
const coursePage = ref(1);
const coursePageSize = 20;

const detail = ref<CourseDetail | null>(null);
const eligibility = reactive<Record<number, Eligibility>>({});
const eligibilityErrors = reactive<Record<number, string>>({});
const detailLoading = ref(false);

const enrolled = ref<EnrolledRow[]>([]);
const swapSourceClassId = ref<number | null>(null);

const listLoading = ref(false);
const listError = ref('');
const actionLoading = ref<number | null>(null);
const idempotencyKeys = reactive<Record<string, string>>({});

const courseTypeOptions = [
  { value: '', label: '全部类型' },
  { value: 'required', label: '必修' },
  { value: 'limited_elective', label: '限选' },
  { value: 'elective', label: '任选' },
  { value: 'general', label: '通识' },
];

/** 同一意图重试时复用同一个幂等键 */
function keyFor(intent: string): string {
  if (!idempotencyKeys[intent]) idempotencyKeys[intent] = newIdempotencyKey();
  return idempotencyKeys[intent];
}

function clearKey(intent: string): void {
  delete idempotencyKeys[intent];
}

async function loadCourses(page = 1): Promise<void> {
  listLoading.value = true;
  listError.value = '';
  try {
    const data = await api.get<{ items: CourseDto[]; total: number }>('/courses', {
      keyword: filters.keyword.trim() || undefined,
      department: filters.department || undefined,
      courseType: filters.courseType || undefined,
      term: filters.term || undefined,
      page,
      pageSize: coursePageSize,
    });
    courses.value = data.items;
    courseTotal.value = data.total;
    coursePage.value = page;
    // 换页/改筛选后展开的那门课可能已不在列表里，收起避免留下隐藏的展开态
    detail.value = null;
  } catch (error) {
    listError.value = apiErrorInfo(error).message;
  } finally {
    listLoading.value = false;
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

async function loadEligibility(classes: ClassDto[]): Promise<void> {
  await Promise.all(
    classes.map(async (cls) => {
      try {
        eligibility[cls.id] = await api.get<Eligibility>(`/eligibility/${cls.id}`);
        delete eligibilityErrors[cls.id];
      } catch (error) {
        // 资格查询失败时如实展示原因，并允许学生尝试选课（最终以后端返回为准）
        eligibilityErrors[cls.id] = apiErrorInfo(error, '资格查询失败').message;
      }
    }),
  );
}

async function openCourse(courseId: number): Promise<void> {
  detailLoading.value = true;
  try {
    const data = await api.get<{ course: CourseDetail }>(`/courses/${courseId}`);
    detail.value = data.course;
    for (const key of Object.keys(eligibility)) delete eligibility[Number(key)];
    for (const key of Object.keys(eligibilityErrors)) delete eligibilityErrors[Number(key)];
    await loadEligibility(data.course.classes);
  } catch (error) {
    reportApiError(error, '读取课程详情失败');
  } finally {
    detailLoading.value = false;
  }
}

function isDetailOpen(courseId: number): boolean {
  return detail.value?.id === courseId;
}

/** 点击“查看教学班”：已展开则收起，否则展开到该课程行下面 */
async function toggleCourse(courseId: number): Promise<void> {
  if (isDetailOpen(courseId)) {
    detail.value = null;
    return;
  }
  await openCourse(courseId);
}

async function refreshDetail(): Promise<void> {
  if (!detail.value) return;
  await openCourse(detail.value.id);
  await loadEnrolled();
}

const myEnrollmentByClass = computed(() => {
  const map = new Map<number, EnrolledRow>();
  for (const row of enrolled.value) map.set(row.classId, row);
  return map;
});

function isEnrolledClass(classId: number): boolean {
  return myEnrollmentByClass.value.has(classId);
}

async function enroll(cls: ClassDto): Promise<void> {
  const ok = await askConfirm({
    title: `选课：${cls.courseName} ${cls.classCode}`,
    message: '选课会立即占用名额并写入正式课表，是否需要继续？',
    confirmText: '确认选课',
    danger: false,
  });
  if (!ok) return;
  const intent = `enroll:${cls.id}`;
  actionLoading.value = cls.id;
  try {
    const result = await api.post<EnrollmentOperationResult>('/enroll', {
      classId: cls.id,
      idempotencyKey: keyFor(intent),
    });
    clearKey(intent);
    toast.success(`已选上：${cls.courseName} ${cls.classCode}`, result.messages ?? []);
    await refreshDetail();
  } catch (error) {
    reportApiError(error, '选课失败');
  } finally {
    actionLoading.value = null;
  }
}

async function drop(cls: ClassDto): Promise<void> {
  const ok = await askConfirm({
    title: `退课：${cls.courseName} ${cls.classCode}`,
    message: '退课后名额会被释放，候补队列中的学生可能因此被提升，是否需要继续？',
    confirmText: '确认退课',
  });
  if (!ok) return;
  const intent = `drop:${cls.id}`;
  actionLoading.value = cls.id;
  try {
    const result = await api.post<EnrollmentOperationResult>('/drop', {
      classId: cls.id,
      idempotencyKey: keyFor(intent),
      reason: '学生在课程检索页主动退课',
    });
    clearKey(intent);
    toast.success(`已退课：${cls.courseName} ${cls.classCode}`, result.messages ?? []);
    await refreshDetail();
  } catch (error) {
    reportApiError(error, '退课失败');
  } finally {
    actionLoading.value = null;
  }
}

async function swap(toClass: ClassDto): Promise<void> {
  const fromClassId = swapSourceClassId.value;
  if (!fromClassId) {
    toast.warning('请先选择要替换掉的原教学班');
    return;
  }
  const from = enrolled.value.find((row) => row.classId === fromClassId);
  const sameCourse = from?.courseId === toClass.courseId;
  const ok = await askConfirm({
    title: sameCourse ? '同课换班' : '一对一替换',
    message: `将「${from?.courseName ?? ''}（教学班 ${from?.classId ?? ''}）」替换为「${toClass.courseName} ${toClass.classCode}」。系统会先检查替换后的完整课表是否成立，成立才会在同一事务内执行。`,
    confirmText: '确认替换',
    danger: false,
  });
  if (!ok) return;
  const intent = `swap:${fromClassId}->${toClass.id}`;
  actionLoading.value = toClass.id;
  try {
    const result = await api.post<EnrollmentOperationResult>('/swap', {
      fromClassId,
      toClassId: toClass.id,
      idempotencyKey: keyFor(intent),
      reason: sameCourse ? '学生同课换班' : '学生一对一替换',
    });
    clearKey(intent);
    toast.success(`替换成功：${toClass.courseName} ${toClass.classCode}`, result.messages ?? []);
    swapSourceClassId.value = null;
    await refreshDetail();
  } catch (error) {
    reportApiError(error, '替换失败');
  } finally {
    actionLoading.value = null;
  }
}

function capacityText(cls: ClassDto): string {
  return `${cls.enrolled}/${cls.capacity}（预留 ${cls.reservedSeats}，已用 ${cls.usedReserved}）`;
}

function availabilityText(cls: ClassDto): string {
  return `普通余量 ${cls.generalAvailable} · 含预留余量 ${cls.totalAvailable}`;
}

function eligibilityMessages(classId: number): string[] {
  const item = eligibility[classId];
  return item ? item.evaluation.messages : [];
}

onMounted(async () => {
  try {
    const meta = await api.get<{ terms: string[]; departments: string[] }>('/terms');
    terms.value = meta.terms;
    departments.value = meta.departments;
    if (meta.terms.length > 0) filters.term = meta.terms[0];
  } catch {
    // 忽略：筛选元数据失败不影响主列表
  }
  await Promise.all([loadCourses(1), loadEnrolled()]);
});
</script>

<template>
  <div class="course-search-panel">
    <section class="card">
      <div class="toolbar">
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">关键词（课程名/课程号）</span>
          <input v-model="filters.keyword" class="input" type="text" placeholder="例如 数据结构" @keyup.enter="loadCourses(1)" />
        </label>
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">院系</span>
          <select v-model="filters.department" class="select">
            <option value="">全部院系</option>
            <option v-for="item in departments" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">课程类型</span>
          <select v-model="filters.courseType" class="select">
            <option v-for="item in courseTypeOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">学期</span>
          <select v-model="filters.term" class="select">
            <option value="">全部学期</option>
            <option v-for="item in terms" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <button class="btn btn--primary" type="button" :disabled="listLoading" @click="loadCourses(1)">
          {{ listLoading ? '查询中…' : '查询' }}
        </button>
        <button
          class="btn btn--ghost"
          type="button"
          @click="
            filters.keyword = '';
            filters.department = '';
            filters.courseType = '';
            loadCourses(1);
          "
        >
          重置
        </button>
      </div>
      <p v-if="listError" class="alert alert--error" style="margin-top: 10px">{{ listError }}</p>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">课程列表（点击课程查看教学班）</h3>
        <span class="muted small">共 {{ courseTotal }} 门</span>
      </div>
      <div v-if="courses.length === 0" class="empty">没有符合条件的课程。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>课程号</th>
              <th>课程名</th>
              <th>学分</th>
              <th>类型</th>
              <th>院系</th>
              <th>教学班数</th>
              <th>总余量</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="course in courses" :key="course.id">
              <tr :class="{ 'course-row--open': isDetailOpen(course.id) }">
                <td class="mono">{{ course.code }}</td>
                <td>{{ course.name }}</td>
                <td>{{ formatCredits(course.credits) }}</td>
                <td><span :class="`badge badge--${course.courseType}`">{{ courseTypeLabel(course.courseType) }}</span></td>
                <td>{{ course.department ?? '—' }}</td>
                <td>{{ course.classCount }}</td>
                <td>{{ course.totalAvailable }} / {{ course.totalCapacity }}</td>
                <td>
                  <div class="inline">
                    <button class="btn btn--sm btn--primary" type="button" @click="toggleCourse(course.id)">
                      {{ isDetailOpen(course.id) ? '收起教学班' : '查看教学班' }}
                    </button>
                    <button
                      class="btn btn--sm btn--ghost"
                      type="button"
                      :disabled="props.inDraft(course.id)"
                      @click="emit('add', course)"
                    >
                      {{ props.inDraft(course.id) ? '已在清单' : '加入清单' }}
                    </button>
                  </div>
                </td>
              </tr>

              <!-- 教学班详情：直接在该课程行下面下拉展开 -->
              <tr v-if="isDetailOpen(course.id)" class="course-detail-row">
                <td colspan="8">
                  <template v-if="detail">
                    <div class="card__header">
                      <h3 class="card__title">
                        {{ detail.name }}（{{ detail.code }}，{{ formatCredits(detail.credits) }} 学分）
                        <span :class="`badge badge--${detail.courseType}`">{{ courseTypeLabel(detail.courseType) }}</span>
                      </h3>
                      <div class="inline">
                        <button class="btn btn--ghost btn--sm" type="button" :disabled="detailLoading" @click="refreshDetail">刷新</button>
                        <button class="btn btn--ghost btn--sm" type="button" @click="detail = null">关闭</button>
                      </div>
                    </div>
                    <p class="muted small">{{ detail.description ?? '暂无课程说明' }}</p>

                    <div class="alert alert--info">
                      替换/换班操作：先在下方“我的已选课程”里选择要替换掉的原教学班，再点击目标教学班的“换到此班”。
                      系统只检查替换后的完整课表，不会出现“先退原课却没选上目标课”的中间状态。
                    </div>

                    <div v-if="enrolled.length > 0" class="toolbar" style="margin: 10px 0">
                      <label class="field" style="margin-bottom: 0">
                        <span class="field__label">要替换掉的原教学班</span>
                        <select v-model.number="swapSourceClassId" class="select">
                          <option :value="null">未选择（仅用于换班/替换）</option>
                          <option v-for="row in enrolled" :key="row.classId" :value="row.classId">
                            {{ row.courseCode }} {{ row.courseName }} · {{ row.classId }}（来源：{{ sourceLabel(row.source) }}）
                          </option>
                        </select>
                      </label>
                    </div>

                    <div class="table-wrap">
                      <table class="table">
                        <thead>
                          <tr>
                            <th>教学班号</th>
                            <th>教师</th>
                            <th>时段</th>
                            <th>容量 / 已选</th>
                            <th>余量</th>
                            <th>状态</th>
                            <th>资格与依据</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="cls in detail.classes" :key="cls.id">
                            <td class="mono">{{ cls.classCode }}<div v-if="cls.campus" class="small muted">{{ cls.campus }}</div></td>
                            <td>
                              {{ cls.teacher ? `${cls.teacher.name}${cls.teacher.title ? `（${cls.teacher.title}）` : ''}` : '未指定' }}
                              <span v-if="cls.isDemo || cls.teacher?.isDemo" class="badge badge--muted">演示教师</span>
                            </td>
                            <td>
                              <div v-for="session in cls.sessions" :key="session.id" class="small">{{ session.text }}</div>
                              <div v-if="cls.note" class="small muted">{{ cls.note }}</div>
                            </td>
                            <td>{{ capacityText(cls) }}</td>
                            <td>{{ availabilityText(cls) }}</td>
                            <td>
                              <span class="badge" :class="cls.status === 'open' ? 'badge--ok' : 'badge--danger'">
                                {{ cls.status === 'open' ? '开放' : cls.status === 'closed' ? '关闭' : '已取消' }}
                              </span>
                            </td>
                            <td>
                              <template v-if="eligibility[cls.id]">
                                <span class="badge" :class="eligibility[cls.id].canEnroll ? 'badge--ok' : 'badge--warn'">
                                  {{ eligibility[cls.id].canEnroll ? '可选中' : '不可选中' }}
                                </span>
                                <div class="small muted">
                                  需求等级 {{ eligibility[cls.id].demand?.demandLevel ?? '—' }}
                                  <span v-if="eligibility[cls.id].demand?.demandLevel">（{{ eligibility[cls.id].demand?.reasons.join('；') }}）</span>
                                </div>
                                <div v-if="eligibility[cls.id].supplement" class="small muted">
                                  公开补选：{{ eligibility[cls.id].supplement.allowed ? '允许' : '不允许' }}（{{ eligibility[cls.id].supplement.reason }}）
                                </div>
                                <ul v-if="eligibilityMessages(cls.id).length > 0" class="reason-list">
                                  <li v-for="(message, index) in eligibilityMessages(cls.id)" :key="index">{{ message }}</li>
                                </ul>
                              </template>
                              <template v-else-if="eligibilityErrors[cls.id]">
                                <span class="badge badge--warn">资格查询失败</span>
                                <div class="small muted">{{ eligibilityErrors[cls.id] }}</div>
                                <div class="small muted">仍可点击“选课”，最终由后端返回资格判定结果。</div>
                              </template>
                              <span v-else class="muted small">查询中…</span>
                            </td>
                            <td>
                              <div class="inline">
                                <button
                                  v-if="!isEnrolledClass(cls.id)"
                                  class="btn btn--sm btn--primary"
                                  type="button"
                                  :disabled="actionLoading !== null || (Boolean(eligibility[cls.id]) && !eligibility[cls.id]?.canEnroll)"
                                  @click="enroll(cls)"
                                >
                                  选课
                                </button>
                                <button
                                  v-else
                                  class="btn btn--sm btn--danger"
                                  type="button"
                                  :disabled="actionLoading !== null"
                                  @click="drop(cls)"
                                >
                                  退课
                                </button>
                                <button
                                  class="btn btn--sm btn--ghost"
                                  type="button"
                                  :disabled="actionLoading !== null || !swapSourceClassId || isEnrolledClass(cls.id)"
                                  @click="swap(cls)"
                                >
                                  换到此班
                                </button>
                              </div>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </template>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <Pager :page="coursePage" :page-size="coursePageSize" :total="courseTotal" :disabled="listLoading" @change="loadCourses" />
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">我的已选课程</h3>
        <router-link class="btn btn--ghost btn--sm" :to="{ name: 'student-timetable' }">查看课表</router-link>
      </div>
      <div v-if="enrolled.length === 0" class="muted">还没有选上任何课程。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>课程号</th>
              <th>课程名</th>
              <th>学分</th>
              <th>教学班 ID</th>
              <th>来源</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in enrolled" :key="row.id">
              <td class="mono">{{ row.courseCode }}</td>
              <td>{{ row.courseName }}</td>
              <td>{{ formatCredits(row.credits) }}</td>
              <td class="mono">{{ row.classId }}</td>
              <td>{{ sourceLabel(row.source) }}{{ row.usesReserved ? '（使用预留）' : '' }}</td>
              <td>
                <router-link class="btn btn--sm btn--ghost" :to="{ name: 'student-timetable' }">在课表中查看</router-link>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
