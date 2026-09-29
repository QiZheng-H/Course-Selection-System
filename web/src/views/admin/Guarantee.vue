<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type {
  BatchDto,
  ClassDto,
  CourseDto,
  EnrolledRow,
  GuaranteeConfirmResult,
  GuaranteePayload,
  UserRow,
} from '@/api/types';
import { batchStatusLabel, formatDateTime } from '@/utils/labels';

const toast = useToast();

const batches = ref<BatchDto[]>([]);
const batchId = ref<number | null>(null);
const payload = ref<GuaranteePayload | null>(null);
const loading = ref(false);

const courses = ref<CourseDto[]>([]);
const students = ref<UserRow[]>([]);
const studentKeyword = ref('');
const selectedStudentIds = ref<number[]>([]);
const confirmForm = reactive({ courseId: null as number | null, reason: '' });
const confirming = ref(false);
const lastSuggestion = ref<GuaranteeConfirmResult | null>(null);

const authForm = reactive({
  studentId: null as number | null,
  sourceClassId: null as number | null,
  targetCourseId: null as number | null,
  targetClassId: null as number | null,
  expiresAt: '',
});
const studentEnrollments = ref<EnrolledRow[]>([]);
const targetClasses = ref<ClassDto[]>([]);
const granting = ref(false);

const infeasibleStudents = computed(() => (payload.value?.feasibility.students ?? []).filter((student) => !student.feasible));

async function loadBatches(): Promise<void> {
  try {
    const data = await api.get<{ batches: BatchDto[]; current: BatchDto | null }>('/admin/batches');
    batches.value = data.batches;
    if (batchId.value === null && data.batches.length > 0) batchId.value = (data.current ?? data.batches[0]).id;
    await loadGuarantee();
  } catch (error) {
    reportApiError(error, '读取批次失败');
  }
}

async function loadGuarantee(): Promise<void> {
  loading.value = true;
  try {
    payload.value = await api.get<GuaranteePayload>('/admin/guarantee', {
      batchId: batchId.value ?? undefined,
    });
  } catch (error) {
    reportApiError(error, '读取毕业保障数据失败');
  } finally {
    loading.value = false;
  }
}

async function loadReferenceData(): Promise<void> {
  try {
    const [courseRes, studentRes] = await Promise.all([
      api.get<{ items: CourseDto[] }>('/admin/courses', { pageSize: 200 }),
      api.get<{ items: UserRow[] }>('/admin/users', { role: 'student', pageSize: 200 }),
    ]);
    courses.value = courseRes.items;
    students.value = studentRes.items;
  } catch (error) {
    reportApiError(error, '读取基础数据失败');
  }
}

async function searchStudents(): Promise<void> {
  try {
    const data = await api.get<{ items: UserRow[] }>('/admin/users', {
      role: 'student',
      keyword: studentKeyword.value.trim() || undefined,
      pageSize: 200,
    });
    students.value = data.items;
  } catch (error) {
    reportApiError(error, '搜索学生失败');
  }
}

function toggleStudent(studentId: number): void {
  if (selectedStudentIds.value.includes(studentId)) {
    selectedStudentIds.value = selectedStudentIds.value.filter((id) => id !== studentId);
  } else {
    selectedStudentIds.value.push(studentId);
  }
}

async function confirmGuarantee(): Promise<void> {
  if (batchId.value === null || confirmForm.courseId === null) {
    toast.warning('请选择批次与课程');
    return;
  }
  if (selectedStudentIds.value.length === 0) {
    toast.warning('请至少选择一名学生');
    return;
  }
  const course = courses.value.find((item) => item.id === confirmForm.courseId);
  const ok = await askConfirm({
    title: '确认毕业保障名单',
    message: '确认后这些学生会被标记为“毕业保障保护”，系统会同时检查他们的多门必要课程是否联合可行，并给出教学班预留建议。',
    details: [
      `课程：${course?.name ?? confirmForm.courseId}`,
      `学生：${selectedStudentIds.value.length} 人`,
      '联合无解的学生会被记入关键异常清单，不会自动视为保障完成。',
    ],
    confirmText: '确认名单',
    danger: false,
  });
  if (!ok) return;
  confirming.value = true;
  try {
    const result = await api.post<GuaranteeConfirmResult>('/admin/guarantee', {
      batchId: batchId.value,
      courseId: confirmForm.courseId,
      studentIds: selectedStudentIds.value,
      reason: confirmForm.reason || undefined,
    });
    lastSuggestion.value = result;
    toast.success('已确认保障名单', [`新增 ${result.added} 条，当前保护 ${result.studentCount} 人`]);
    const infeasible = result.feasibility.filter((student) => !student.feasible);
    if (infeasible.length > 0) {
      toast.warning('存在联合无解的学生', infeasible.map((student) => `${student.studentNo}：${student.courseNames.join('、')}`));
    }
    selectedStudentIds.value = [];
    confirmForm.reason = '';
    await loadGuarantee();
  } catch (error) {
    reportApiError(error, '确认保障名单失败');
  } finally {
    confirming.value = false;
  }
}

async function onAuthStudentChange(): Promise<void> {
  authForm.sourceClassId = null;
  studentEnrollments.value = [];
  if (authForm.studentId === null) return;
  try {
    const data = await api.get<{ enrolled: EnrolledRow[] }>('/student/records', { studentId: authForm.studentId });
    studentEnrollments.value = data.enrolled;
  } catch (error) {
    reportApiError(error, '读取该学生的已选课程失败');
  }
}

async function onAuthTargetCourseChange(): Promise<void> {
  authForm.targetClassId = null;
  targetClasses.value = [];
  if (authForm.targetCourseId === null) return;
  try {
    const data = await api.get<{ items: ClassDto[] }>('/admin/classes', { courseId: authForm.targetCourseId, pageSize: 100 });
    targetClasses.value = data.items;
  } catch (error) {
    reportApiError(error, '读取目标教学班失败');
  }
}

async function grantAuthorization(): Promise<void> {
  if (batchId.value === null || authForm.studentId === null || authForm.sourceClassId === null || authForm.targetCourseId === null) {
    toast.warning('请完整选择学生、原教学班与目标课程');
    return;
  }
  const source = studentEnrollments.value.find((row) => row.classId === authForm.sourceClassId);
  const target = courses.value.find((item) => item.id === authForm.targetCourseId);
  const ok = await askConfirm({
    title: '授予自动替换授权',
    message: '授权表示允许系统用“目标课程”替换学生当前的原教学班。授权带版本，关键资料变化后会自动失效。',
    details: [
      `学生：${authForm.studentId}`,
      `原教学班：${source ? `${source.courseCode} ${source.courseName}（${source.classId}）` : authForm.sourceClassId}`,
      `目标课程：${target ? `${target.code} ${target.name}` : authForm.targetCourseId}`,
      authForm.targetClassId ? `目标教学班：${authForm.targetClassId}` : '目标教学班：不限',
    ],
    confirmText: '授予授权',
    danger: false,
  });
  if (!ok) return;
  granting.value = true;
  try {
    const result = await api.post<{ id: number; status: string }>('/admin/guarantee/authorizations', {
      studentId: authForm.studentId,
      batchId: batchId.value,
      sourceClassId: authForm.sourceClassId,
      targetCourseId: authForm.targetCourseId,
      targetClassId: authForm.targetClassId ?? undefined,
      expiresAt: authForm.expiresAt ? new Date(authForm.expiresAt).toISOString() : undefined,
    });
    toast.success('授权已授予', [`授权 #${result.id}（${result.status}）`]);
    authForm.sourceClassId = null;
    authForm.targetCourseId = null;
    authForm.targetClassId = null;
  } catch (error) {
    reportApiError(error, '授予授权失败');
  } finally {
    granting.value = false;
  }
}

onMounted(async () => {
  await Promise.all([loadReferenceData(), loadBatches()]);
});
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">毕业保障</h1>
        <p class="page__desc">
          保障名单会占用教学班预留名额；系统会检查每名学生多门必要课程的“联合可行性”，无解的学生必须显式处理。
        </p>
      </div>
      <div class="inline">
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">批次</span>
          <select v-model.number="batchId" class="select" @change="loadGuarantee">
            <option :value="null">全部批次</option>
            <option v-for="item in batches" :key="item.id" :value="item.id">
              {{ item.name }}（{{ item.term }} · {{ batchStatusLabel(item.status) }}）
            </option>
          </select>
        </label>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="loadGuarantee">刷新</button>
      </div>
    </div>

    <div v-if="infeasibleStudents.length > 0" class="alert alert--error">
      <strong>⚠ 有 {{ infeasibleStudents.length }} 名学生的保障课程联合无解（必须处理）</strong>
      <ul>
        <li v-for="student in infeasibleStudents" :key="student.studentId">
          {{ student.studentNo }}：{{ student.courseNames.join('、') }} ——
          {{ student.conflicts.flatMap((conflict) => conflict.messages).join('；') || '这些课程的所有教学班两两冲突，无法同时安排' }}
        </li>
      </ul>
      <p class="small">
        这类学生不能视为保障完成，需要在“异常与操作记录”中形成明确处理结果（例如调整教学班、替换课程或授予替换授权）。
      </p>
    </div>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">确认保障名单</h3>
      </div>
      <div class="grid grid--3">
        <label class="field">
          <span class="field__label">保障课程</span>
          <select v-model.number="confirmForm.courseId" class="select">
            <option :value="null">请选择课程</option>
            <option v-for="course in courses" :key="course.id" :value="course.id">{{ course.code }} {{ course.name }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">原因说明（可选）</span>
          <input v-model="confirmForm.reason" class="input" type="text" placeholder="例如：毕业年级必须完成" />
        </label>
        <div class="field">
          <span class="field__label">搜索学生</span>
          <div class="inline">
            <input v-model="studentKeyword" class="input" type="text" placeholder="学号或姓名" @keyup.enter="searchStudents" />
            <button class="btn btn--ghost btn--sm" type="button" @click="searchStudents">搜索</button>
          </div>
        </div>
      </div>

      <div class="inline" style="margin-bottom: 6px">
        <span class="badge">已选 {{ selectedStudentIds.length }} 人</span>
        <button class="btn btn--sm btn--ghost" type="button" @click="selectedStudentIds = []">清空选择</button>
      </div>
      <div class="table-wrap" style="max-height: 260px; overflow-y: auto">
        <table class="table table--compact">
          <thead>
            <tr>
              <th>选择</th>
              <th>学号</th>
              <th>姓名</th>
              <th>年级 / 专业</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="student in students" :key="student.id">
              <td>
                <input
                  type="checkbox"
                  :checked="selectedStudentIds.includes(student.id)"
                  @change="toggleStudent(student.id)"
                />
              </td>
              <td class="mono">{{ student.studentNo ?? student.username }}</td>
              <td>{{ student.displayName }}</td>
              <td class="small muted">{{ student.grade ?? '—' }} / {{ student.major ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <button class="btn btn--primary" style="margin-top: 10px" type="button" :disabled="confirming" @click="confirmGuarantee">
        {{ confirming ? '提交中…' : '确认名单并检查联合可行性' }}
      </button>
    </section>

    <section v-if="lastSuggestion" class="card">
      <div class="card__header">
        <h3 class="card__title">教学班预留建议</h3>
        <span class="badge">当前保护 {{ lastSuggestion.studentCount }} 人</span>
      </div>
      <div v-if="lastSuggestion.reservationSuggestion.length === 0" class="muted">该课程没有开放的教学班。</div>
      <div v-else class="table-wrap">
        <table class="table table--compact">
          <thead>
            <tr>
              <th>教学班</th>
              <th>建议预留</th>
              <th>容量</th>
              <th>当前预留</th>
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
      <p class="tips">建议值仅作参考：预留名额的最终调整请通过教学班配置完成，系统不会自动修改容量。</p>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">联合可行性（每个学生）</h3>
      </div>
      <div v-if="!payload || payload.feasibility.students.length === 0" class="muted">当前没有保障名单记录。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>学号</th>
              <th>保护课程</th>
              <th>是否可行</th>
              <th>冲突说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="student in payload.feasibility.students" :key="student.studentId">
              <td class="mono">{{ student.studentNo }}</td>
              <td>{{ student.courseNames.join('、') }}</td>
              <td>
                <span class="badge" :class="student.feasible ? 'badge--ok' : 'badge--danger'">
                  {{ student.feasible ? '存在可行方案' : '无解' }}
                </span>
              </td>
              <td class="small">
                <span v-if="student.conflicts.length === 0" class="muted">—</span>
                <ul v-else>
                  <li v-for="(conflict, index) in student.conflicts" :key="index">
                    {{ conflict.courseNames.join('、') }}：{{ conflict.messages.join('；') }}
                  </li>
                </ul>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">预留名额可释放性</h3>
      </div>
      <div v-if="!payload || payload.feasibility.releasable.length === 0" class="muted">没有可统计的课程。</div>
      <div v-else class="table-wrap">
        <table class="table table--compact">
          <thead>
            <tr>
              <th>课程</th>
              <th>是否可释放</th>
              <th>有效保护人数</th>
              <th>已保障人数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in payload.feasibility.releasable" :key="row.courseId">
              <td>{{ row.courseName }}</td>
              <td>
                <span class="badge" :class="row.releasable ? 'badge--ok' : 'badge--warn'">{{ row.releasable ? '可释放' : '不可释放' }}</span>
              </td>
              <td>{{ row.activeReservations }}</td>
              <td>{{ row.fulfilled }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">保障名单</h3>
      </div>
      <div v-if="!payload || payload.reservations.length === 0" class="empty">还没有确认任何保障名单。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>课程</th>
              <th>学号</th>
              <th>姓名</th>
              <th>状态</th>
              <th>原因</th>
              <th>确认时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in payload.reservations" :key="row.id">
              <td>{{ row.courseName }}</td>
              <td class="mono">{{ row.studentNo }}</td>
              <td>{{ row.studentName }}</td>
              <td><span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--muted'">{{ row.status }}</span></td>
              <td class="small muted">{{ row.reason ?? '—' }}</td>
              <td class="small muted">{{ formatDateTime(row.confirmedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">授予替换（升级）授权</h3>
      </div>
      <p class="tips">必须选择“原教学班”和“目标课程”；可选目标教学班与过期时间。学生当前必须仍在修读原教学班，否则后端会拒绝。</p>
      <div class="grid grid--3">
        <label class="field">
          <span class="field__label">学生</span>
          <select v-model.number="authForm.studentId" class="select" @change="onAuthStudentChange">
            <option :value="null">请选择学生</option>
            <option v-for="student in students" :key="student.id" :value="student.id">
              {{ student.studentNo ?? student.username }} {{ student.displayName }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">原教学班（该学生当前在修）</span>
          <select v-model.number="authForm.sourceClassId" class="select">
            <option :value="null">请选择原教学班</option>
            <option v-for="row in studentEnrollments" :key="row.classId" :value="row.classId">
              {{ row.courseCode }} {{ row.courseName }} · 教学班 {{ row.classId }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">目标课程</span>
          <select v-model.number="authForm.targetCourseId" class="select" @change="onAuthTargetCourseChange">
            <option :value="null">请选择目标课程</option>
            <option v-for="course in courses" :key="course.id" :value="course.id">{{ course.code }} {{ course.name }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">目标教学班（可选，不限则留空）</span>
          <select v-model.number="authForm.targetClassId" class="select">
            <option :value="null">不限</option>
            <option v-for="cls in targetClasses" :key="cls.id" :value="cls.id">{{ cls.classCode }}（余 {{ cls.generalAvailable }}）</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">过期时间（可选）</span>
          <input v-model="authForm.expiresAt" class="input" type="datetime-local" />
        </label>
      </div>
      <button class="btn btn--primary" type="button" :disabled="granting" @click="grantAuthorization">
        {{ granting ? '授予中…' : '授予授权' }}
      </button>
    </section>
  </div>
</template>
