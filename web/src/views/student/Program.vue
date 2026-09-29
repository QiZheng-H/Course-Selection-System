<script setup lang="ts">
/**
 * 培养方案（学生视角）。
 * 全部内容来自学校官方发布的 2024 级本科培养计划，并展示原文件、来源网址与具体页码。
 * 教师、教学班时间与容量属于演示模拟配置，页面顶部单独标注。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { reportApiError } from '@/stores/toast';
import type { StudentProgramPlan } from '@/api/types';
import { formatCredits } from '@/utils/labels';

const plan = ref<StudentProgramPlan | null>(null);
const loading = ref(false);
const activeModuleCode = ref<string | null>(null);
const onlyUnsatisfied = ref(false);

const modules = computed(() => plan.value?.modules ?? []);

/** 只显示有官方课程号的模块（未给出课程号的模块仍会显示学分要求） */
const visibleModules = computed(() => {
  if (!onlyUnsatisfied.value) return modules.value;
  return modules.value.filter((module) => module.courses.length > 0);
});

const activeModule = computed(() => modules.value.find((module) => module.code === activeModuleCode.value) ?? null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    plan.value = await api.get<StudentProgramPlan>('/student/program-plan');
    if (activeModuleCode.value === null && plan.value.modules.length > 0) {
      activeModuleCode.value = plan.value.modules[0].code;
    }
  } catch (error) {
    reportApiError(error, '读取培养方案失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">我的培养方案</h1>
        <p class="page__desc">
          课程代码、名称、学分、必修/选修属性、类别学分要求与建议修读学年学期均来自学校官方培养计划；
          教师、教学班时间与容量由本系统另行配置，属于演示数据。
        </p>
      </div>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
    </div>

    <p v-if="plan?.demoNotice" class="alert alert--info">{{ plan.demoNotice }}</p>

    <section v-if="plan?.program" class="card">
      <div class="card__header">
        <h3 class="card__title">{{ plan.program.name }}（{{ plan.program.code }}）</h3>
      </div>
      <div class="grid grid--3">
        <div class="stat">
          <div class="stat__label">总学分</div>
          <div class="stat__value">{{ formatCredits(plan.program.totalCredits) }}</div>
          <div class="stat__extra">官方培养计划要求</div>
        </div>
        <div class="stat">
          <div class="stat__label">年级 / 专业</div>
          <div class="stat__value">{{ plan.program.grade }}</div>
          <div class="stat__extra">{{ plan.program.major }}</div>
        </div>
        <div class="stat">
          <div class="stat__label">方案版本</div>
          <div class="stat__value">{{ plan.program.version }}</div>
          <div class="stat__extra">{{ plan.program.status === 'published' ? '已发布' : plan.program.status }}</div>
        </div>
      </div>

      <div class="alert" style="margin-top: 10px">
        <strong>官方来源</strong>
        <div class="small">原文件：{{ plan.program.sourceFile }}</div>
        <div class="small">页码：{{ plan.program.sourcePages }}</div>
        <div v-if="plan.program.sourceSha256" class="small muted mono">SHA-256：{{ plan.program.sourceSha256 }}</div>
        <div v-if="plan.program.sourceUrl" class="small">
          <a :href="plan.program.sourceUrl" target="_blank" rel="noopener">打开官方 PDF</a>
        </div>
        <div v-if="plan.program.sourceNote" class="small muted" style="margin-top: 6px">{{ plan.program.sourceNote }}</div>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">课程类别与学分要求</h3>
        <label class="checkbox">
          <input v-model="onlyUnsatisfied" type="checkbox" />
          只看有课程号的模块
        </label>
      </div>
      <div v-if="visibleModules.length === 0" class="empty">没有可显示的模块。</div>
      <div v-else class="table-wrap">
        <table class="table table--compact">
          <thead>
            <tr>
              <th>课程性质</th>
              <th>类别（模块）</th>
              <th>学分要求</th>
              <th>课程数</th>
              <th>官方页码</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="module in visibleModules" :key="module.id">
              <td>
                <span class="badge" :class="module.nature === '必修' ? 'badge--ok' : 'badge--muted'">
                  {{ module.nature ?? '—' }}
                </span>
              </td>
              <td>
                {{ module.name }}
                <div v-if="module.note" class="small muted">{{ module.note }}</div>
              </td>
              <td>{{ formatCredits(module.requiredCredits) }}</td>
              <td>{{ module.courses.length }}</td>
              <td class="small muted">{{ module.sourcePages ?? '—' }}</td>
              <td>
                <button
                  class="btn btn--ghost btn--sm"
                  type="button"
                  :disabled="module.courses.length === 0"
                  @click="activeModuleCode = module.code"
                >
                  查看课程
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="activeModule" class="card">
      <div class="card__header">
        <h3 class="card__title">{{ activeModule.name }}（{{ activeModule.nature ?? '—' }} · {{ formatCredits(activeModule.requiredCredits) }} 学分）</h3>
        <span class="muted small">官方页码：{{ activeModule.sourcePages ?? '—' }}</span>
      </div>
      <div v-if="activeModule.courses.length === 0" class="empty">
        官方培养计划只给出该模块的学分要求，未列出课程号；具体课程见学校对应的通识课程目录。
      </div>
      <div v-else class="table-wrap">
        <table class="table">
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
            <tr v-for="course in activeModule.courses" :key="course.courseId">
              <td class="mono">{{ course.code }}</td>
              <td>{{ course.name }}</td>
              <td>{{ formatCredits(course.credits) }}</td>
              <td>
                <span class="badge" :class="course.nature === '必修' ? 'badge--ok' : 'badge--muted'">
                  {{ course.nature ?? '—' }}
                </span>
              </td>
              <td>{{ course.suggestedTerm ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
