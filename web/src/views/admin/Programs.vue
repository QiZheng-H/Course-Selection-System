<script setup lang="ts">
/**
 * 培养方案核对（管理端）。
 * 管理员在这里核对演示库中的培养方案是否与学校官方文件一致：
 * 原文件、来源网址、页码、模块学分要求、课程代码/学分/必修选修/建议修读学期。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { reportApiError } from '@/stores/toast';
import { formatCredits } from '@/utils/labels';

interface ProgramRow {
  id: number;
  code: string;
  name: string;
  grade: string | null;
  major: string | null;
  totalCredits: number;
  version: string;
  status: string;
  publishedAt: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  sourcePages: string | null;
  sourceNote: string | null;
  requirementCount: number;
  studentCount: number;
}

interface ProgramCourse {
  courseId: number;
  code: string;
  name: string;
  credits: number;
  courseNature: string | null;
  suggestedTerm: string | null;
  relation: string;
}

interface ProgramRequirement {
  id: number;
  code: string;
  name: string;
  category: string | null;
  nature: string | null;
  requiredCredits: number;
  minCourses: number;
  priority: number;
  note: string | null;
  sourcePages: string | null;
  courses: ProgramCourse[];
}

const programs = ref<ProgramRow[]>([]);
const selectedId = ref<number | null>(null);
const detail = ref<{ program: ProgramRow; requirements: ProgramRequirement[]; demoNotice: string | null } | null>(null);
const demoNotice = ref<string | null>(null);
const loading = ref(false);
const keyword = ref('');

const filteredRequirements = computed(() => {
  const list = detail.value?.requirements ?? [];
  const text = keyword.value.trim();
  if (!text) return list;
  return list.filter(
    (module) =>
      module.name.includes(text) ||
      module.code.includes(text) ||
      module.courses.some((course) => course.code.includes(text) || course.name.includes(text)),
  );
});

const totalPlanCourses = computed(() =>
  (detail.value?.requirements ?? []).reduce((sum, module) => sum + module.courses.length, 0),
);

async function loadPrograms(): Promise<void> {
  try {
    const data = await api.get<{ programs: ProgramRow[]; demoNotice: string | null }>('/admin/programs');
    programs.value = data.programs;
    demoNotice.value = data.demoNotice;
    if (selectedId.value === null && data.programs.length > 0) {
      await loadDetail(data.programs[0].id);
    }
  } catch (error) {
    reportApiError(error, '读取培养方案失败');
  }
}

async function loadDetail(programId: number): Promise<void> {
  loading.value = true;
  selectedId.value = programId;
  try {
    detail.value = await api.get<{ program: ProgramRow; requirements: ProgramRequirement[]; demoNotice: string | null }>(
      `/admin/programs/${programId}`,
    );
  } catch (error) {
    reportApiError(error, '读取培养方案明细失败');
  } finally {
    loading.value = false;
  }
}

async function onProgramChange(): Promise<void> {
  if (selectedId.value !== null) await loadDetail(selectedId.value);
}

onMounted(loadPrograms);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">培养方案核对</h1>
        <p class="page__desc">
          核对演示库中的培养方案与学校官方文件是否一致；来源网址与页码来自官方发布页面。
        </p>
      </div>
      <div class="inline">
        <label class="field" style="margin-bottom: 0">
          <span class="field__label">培养方案</span>
          <select v-model.number="selectedId" class="select" @change="onProgramChange">
            <option v-for="item in programs" :key="item.id" :value="item.id">
              {{ item.name }}（{{ item.code }} · {{ item.grade }}）
            </option>
          </select>
        </label>
        <button class="btn btn--ghost btn--sm" type="button" @click="loadPrograms">刷新</button>
      </div>
    </div>

    <p v-if="demoNotice" class="alert alert--info">{{ demoNotice }}</p>

    <section v-if="detail" class="card">
      <div class="inline">
        <span class="badge">{{ detail.program.status === 'published' ? '已发布' : detail.program.status }}</span>
        <span class="badge badge--muted">版本 {{ detail.program.version }}</span>
        <span class="badge">总学分 {{ formatCredits(detail.program.totalCredits) }}</span>
        <span class="badge badge--muted">模块 {{ detail.program.requirementCount }}</span>
        <span class="badge badge--muted">官方课程 {{ totalPlanCourses }}</span>
        <span class="badge badge--muted">绑定学生 {{ detail.program.studentCount }}</span>
      </div>
      <div class="alert" style="margin-top: 10px">
        <strong>官方来源</strong>
        <div class="small">原文件：{{ detail.program.sourceFile ?? '—' }}</div>
        <div class="small">页码：{{ detail.program.sourcePages ?? '—' }}</div>
        <div v-if="detail.program.sourceUrl" class="small">
          <a :href="detail.program.sourceUrl" target="_blank" rel="noopener">{{ detail.program.sourceUrl }}</a>
        </div>
        <div v-if="detail.program.sourceNote" class="small muted" style="margin-top: 6px">{{ detail.program.sourceNote }}</div>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">课程设置与学分分布</h3>
        <input v-model="keyword" class="input" type="search" placeholder="按模块或课程号/名称筛选" style="max-width: 260px" />
      </div>
      <div v-if="loading" class="muted">读取中…</div>
      <div v-else-if="filteredRequirements.length === 0" class="empty">没有符合条件的模块。</div>
      <div v-else class="stack">
        <div v-for="module in filteredRequirements" :key="module.id" class="card" style="box-shadow: none">
          <div class="card__header">
            <h4 class="card__title">
              {{ module.name }}
              <span class="badge" :class="module.nature === '必修' ? 'badge--ok' : 'badge--muted'">{{ module.nature ?? '—' }}</span>
              <span class="badge badge--muted">{{ formatCredits(module.requiredCredits) }} 学分</span>
            </h4>
            <span class="muted small">官方页码：{{ module.sourcePages ?? '—' }}</span>
          </div>
          <div v-if="module.note" class="small muted" style="margin-bottom: 6px">{{ module.note }}</div>
          <div v-if="module.courses.length === 0" class="muted small">官方未给出课程号（只登记学分要求）。</div>
          <div v-else class="table-wrap">
            <table class="table table--compact">
              <thead>
                <tr>
                  <th>课程代码</th>
                  <th>课程名称</th>
                  <th>学分</th>
                  <th>必修/选修</th>
                  <th>建议修读学年学期</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="course in module.courses" :key="course.courseId">
                  <td class="mono">{{ course.code }}</td>
                  <td>{{ course.name }}</td>
                  <td>{{ formatCredits(course.credits) }}</td>
                  <td>
                    <span class="badge" :class="course.courseNature === '必修' ? 'badge--ok' : 'badge--muted'">
                      {{ course.courseNature ?? '—' }}
                    </span>
                  </td>
                  <td>{{ course.suggestedTerm ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
