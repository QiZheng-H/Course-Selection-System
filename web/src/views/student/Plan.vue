<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type {
  AgentStatus,
  BatchDto,
  EnrolledRow,
  ExplainPayload,
  ParsedPreference,
  Plan,
  PlanningResult,
} from '@/api/types';
import { demandLabel, formatCredits } from '@/utils/labels';

const toast = useToast();

const preferenceText = ref('必须选数据结构，尽量选人工智能导论，周三上午不要排课，不超过 22 学分');
const targetCourseIdsText = ref('');
const maxCredits = ref<number | null>(null);
const avoidDays = ref<number[]>([]);

const status = ref<AgentStatus | null>(null);
const parsed = ref<ParsedPreference | null>(null);
const result = ref<PlanningResult | null>(null);
const currentBatch = ref<BatchDto | null>(null);
const enrolled = ref<EnrolledRow[]>([]);

const planning = ref(false);
const parsing = ref(false);
const savingDraft = ref(false);
const explainLoading = ref(false);
const explainCourseId = ref<number | null>(null);
const explain = ref<ExplainPayload | null>(null);

const dayOptions = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

const activePlanIndex = ref(0);
const activePlan = computed<Plan | null>(() => result.value?.plans[activePlanIndex.value] ?? null);
const enrolledCourseIds = computed(() => new Set(enrolled.value.map((row) => row.courseId)));

function toggleDay(day: number): void {
  const index = avoidDays.value.indexOf(day);
  if (index >= 0) avoidDays.value.splice(index, 1);
  else avoidDays.value.push(day);
}

async function parseOnly(): Promise<void> {
  if (!preferenceText.value.trim()) {
    toast.warning('请先输入偏好描述');
    return;
  }
  parsing.value = true;
  try {
    const data = await api.post<{ parsed: ParsedPreference }>('/agent/parse', { text: preferenceText.value });
    parsed.value = data.parsed;
  } catch (error) {
    reportApiError(error, '偏好解析失败');
  } finally {
    parsing.value = false;
  }
}

async function generatePlan(): Promise<void> {
  planning.value = true;
  try {
    const data = await api.post<PlanningResult>('/agent/plan', {
      preferenceText: preferenceText.value.trim() || undefined,
      targetCourseIds: targetCourseIdsText.value
        .split(/[,，\s]+/)
        .map((item) => Number.parseInt(item, 10))
        .filter((item) => Number.isInteger(item) && item > 0),
      avoidDays: avoidDays.value,
      maxCredits: maxCredits.value ?? undefined,
    });
    result.value = data;
    activePlanIndex.value = 0;
    parsed.value = await api
      .post<{ parsed: ParsedPreference }>('/agent/parse', { text: preferenceText.value })
      .then((res) => res.parsed)
      .catch(() => parsed.value);
    toast.success(`已生成 ${data.plans.length} 套方案`);
  } catch (error) {
    reportApiError(error, '生成方案失败');
  } finally {
    planning.value = false;
  }
}

async function savePlanToDraft(): Promise<void> {
  const plan = activePlan.value;
  if (!plan) return;
  if (!currentBatch.value) {
    toast.warning('当前没有进行中的批次，无法保存志愿草稿');
    return;
  }
  const items = plan.items.filter((item) => !enrolledCourseIds.value.has(item.courseId));
  const skipped = plan.items.length - items.length;
  if (items.length === 0) {
    toast.warning('该方案中的课程都已在你的有效选课中，无需写入草稿');
    return;
  }
  const ok = await askConfirm({
    title: '把该方案填入志愿草稿',
    message: '这会用该方案覆盖当前批次的志愿草稿（不会自动提交）。是否继续？',
    details: [
      `批次：${currentBatch.value.name}（${currentBatch.value.term}）`,
      `写入 ${items.length} 门课程，全局排名按方案顺序 1..${items.length}`,
      skipped > 0 ? `已跳过 ${skipped} 门已在修/已选的课程` : '没有跳过任何课程',
      '保存后请到“志愿”页检查排名与替代组，再自行决定是否提交。',
    ],
    confirmText: '覆盖草稿',
    danger: false,
  });
  if (!ok) return;
  savingDraft.value = true;
  try {
    await api.put('/preferences/draft', {
      batchId: currentBatch.value.id,
      preferences: items.map((item, index) => ({
        courseId: item.courseId,
        globalRank: index + 1,
        classIds: [item.classId],
        note: `${plan.label}：${item.reasons.join('；')}`,
        groupCode: null,
      })),
      groups: [],
    });
    toast.success('已保存到志愿草稿', ['请到“志愿”页确认后自行提交，系统不会自动提交。']);
  } catch (error) {
    reportApiError(error, '保存草稿失败');
  } finally {
    savingDraft.value = false;
  }
}

async function loadExplain(courseId: number): Promise<void> {
  explainCourseId.value = courseId;
  explainLoading.value = true;
  explain.value = null;
  try {
    explain.value = await api.get<ExplainPayload>('/agent/explain', { courseId });
  } catch (error) {
    reportApiError(error, '读取解释失败');
  } finally {
    explainLoading.value = false;
  }
}

onMounted(async () => {
  try {
    status.value = await api.get<AgentStatus>('/agent/status');
  } catch (error) {
    reportApiError(error, '读取模型状态失败');
  }
  try {
    const batchData = await api.get<{ current: BatchDto | null }>('/student/batches');
    currentBatch.value = batchData.current;
  } catch {
    // 忽略
  }
  try {
    const records = await api.get<{ enrolled: EnrolledRow[] }>('/student/records');
    enrolled.value = records.enrolled;
  } catch {
    // 忽略
  }
});

function parsedSummary(): Array<{ label: string; value: string }> {
  if (!parsed.value) return [];
  const ids = (list: number[]): string => (list.length > 0 ? list.join('、') : '无');
  return [
    { label: '必须选（课程 ID）', value: ids(parsed.value.mustHaveCourseIds) },
    { label: '尽量选（课程 ID）', value: ids(parsed.value.preferCourseIds) },
    { label: '不想选（课程 ID）', value: ids(parsed.value.avoidCourseIds) },
    { label: '避开星期', value: parsed.value.avoidDays.length > 0 ? parsed.value.avoidDays.map((d) => `周${d}`).join('、') : '无' },
    { label: '学分上限', value: parsed.value.maxCredits === null ? '未识别' : String(parsed.value.maxCredits) },
    { label: '未识别片段', value: parsed.value.unmatched.length > 0 ? parsed.value.unmatched.join('；') : '无' },
  ];
}
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">偏好与规划</h1>
        <p class="page__desc">
          用自然语言描述你的偏好，系统会解析成结构化条件，再由确定性规则引擎排出推荐方案与最多 2 套有明显区别的备选方案。
        </p>
      </div>
    </div>

    <section v-if="status" class="card">
      <div class="inline">
        <strong>模型可用性：</strong>
        <span class="badge" :class="status.model.configured ? 'badge--ok' : 'badge--warn'">
          {{ status.model.configured ? `在线模型已配置（${status.model.provider ?? '未知供应商'}）` : '在线模型未配置' }}
        </span>
        <span class="badge badge--muted">离线规则引擎可用：{{ status.fallbackAvailable ? '是' : '否' }}</span>
      </div>
      <p class="alert alert--info" style="margin-top: 10px">{{ status.notice }}</p>
      <p class="tips">
        分工说明：模型只用于理解偏好与解释；排课、规则检查、容量与正式结果一律由确定性程序给出。Agent 永远不会直接提交志愿或修改正式课表。
      </p>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">偏好输入</h3>
      </div>
      <label class="field">
        <span class="field__label">自然语言偏好</span>
        <textarea
          v-model="preferenceText"
          class="textarea"
          placeholder="例如：必须选数据结构，尽量选人工智能导论，周三上午不要排课，不超过 22 学分"
        ></textarea>
      </label>

      <div class="grid grid--3">
        <label class="field">
          <span class="field__label">指定课程 ID（可选，逗号分隔）</span>
          <input v-model="targetCourseIdsText" class="input" type="text" placeholder="例如 6,13" />
        </label>
        <label class="field">
          <span class="field__label">学分上限（可选）</span>
          <input v-model.number="maxCredits" class="input" type="number" min="1" step="1" placeholder="留空使用批次上限" />
        </label>
        <div class="field">
          <span class="field__label">避开星期（可选）</span>
          <div class="inline">
            <label v-for="day in dayOptions" :key="day.value" class="checkbox">
              <input type="checkbox" :checked="avoidDays.includes(day.value)" @change="toggleDay(day.value)" />
              {{ day.label }}
            </label>
          </div>
        </div>
      </div>

      <div class="inline">
        <button class="btn btn--primary" type="button" :disabled="planning" @click="generatePlan">
          {{ planning ? '规划中…' : '生成规划方案' }}
        </button>
        <button class="btn btn--ghost" type="button" :disabled="parsing" @click="parseOnly">
          {{ parsing ? '解析中…' : '只看偏好解析结果' }}
        </button>
      </div>
    </section>

    <section v-if="parsed" class="card">
      <div class="card__header">
        <h3 class="card__title">偏好解析结果（POST /api/agent/parse）</h3>
      </div>
      <div class="kv">
        <template v-for="row in parsedSummary()" :key="row.label">
          <span class="kv__key">{{ row.label }}</span>
          <span>{{ row.value }}</span>
        </template>
      </div>
      <p class="tips" style="margin-top: 8px">
        “未识别片段”表示系统无法把它匹配到具体课程，请在下面的结构化表单中手动补充，或直接手动选课。
      </p>
    </section>

    <template v-if="result">
      <section class="card">
        <div class="card__header">
          <h3 class="card__title">规划结果</h3>
          <span class="badge badge--muted">
            模式：{{ result.mode === 'online' ? '在线模型' : result.mode === 'offline-fallback' ? '模型降级' : '离线规则引擎' }}
          </span>
        </div>
        <p class="alert alert--info">{{ result.notice }}</p>
        <p v-if="result.model.degradedReason" class="small muted">
          降级原因：{{ result.model.degradedReason }}
        </p>
        <div class="tabs" style="margin-top: 10px">
          <button
            v-for="(plan, index) in result.plans"
            :key="plan.label"
            class="tab"
            :class="{ 'tab--active': activePlanIndex === index }"
            type="button"
            @click="activePlanIndex = index"
          >
            {{ plan.label }}（{{ plan.items.length }} 门 / {{ formatCredits(plan.totalCredits) }} 学分）
          </button>
        </div>

        <div v-if="activePlan">
          <p class="muted">{{ activePlan.description }}（来源：{{ activePlan.source }}）</p>
          <div class="inline" style="margin-bottom: 10px">
            <span class="badge">学分合计 {{ formatCredits(activePlan.totalCredits) }} / 上限 {{ formatCredits(activePlan.creditLimit) }}</span>
            <span class="spacer"></span>
            <button class="btn btn--primary btn--sm" type="button" :disabled="savingDraft" @click="savePlanToDraft">
              {{ savingDraft ? '保存中…' : '把该方案填入志愿草稿' }}
            </button>
          </div>

          <div v-if="activePlan.items.length === 0" class="empty">该方案没有可安排的课程。</div>
          <div v-else class="list">
            <div v-for="item in activePlan.items" :key="item.courseId" class="list__item">
              <div class="inline">
                <strong>{{ item.courseName }}</strong>
                <span class="mono small">{{ item.courseCode }}</span>
                <span class="badge">{{ formatCredits(item.credits) }} 学分</span>
                <span class="badge badge--muted">{{ demandLabel(item.demandLevel) }}</span>
                <span class="badge">{{ item.classCode }}</span>
                <span v-if="enrolledCourseIds.has(item.courseId)" class="badge badge--ok">已在你的有效选课中</span>
                <span class="spacer"></span>
                <button class="btn btn--ghost btn--sm" type="button" @click="loadExplain(item.courseId)">为什么是这个结果</button>
              </div>
              <div class="small muted">
                {{ item.sessions.join('；') }}
              </div>
              <ul class="reason-list">
                <li v-for="(reason, index) in item.reasons" :key="index">{{ reason }}</li>
              </ul>
            </div>
          </div>

          <div v-if="activePlan.unmet.length > 0" class="alert alert--warning" style="margin-top: 10px">
            <strong>未满足项</strong>
            <ul>
              <li v-for="item in activePlan.unmet" :key="item.courseId">
                {{ item.courseName }}：{{ item.reasons.join('；') }}
              </li>
            </ul>
          </div>
          <div v-if="activePlan.warnings.length > 0" class="alert alert--warning" style="margin-top: 8px">
            <strong>警告</strong>
            <ul>
              <li v-for="(warning, index) in activePlan.warnings" :key="index">{{ warning }}</li>
            </ul>
          </div>
        </div>
      </section>

      <section v-if="result.conflicts.length > 0 || result.pendingConfirmations.length > 0" class="card">
        <h3 class="card__title">需要关注</h3>
        <div v-if="result.conflicts.length > 0" class="alert alert--error" style="margin-top: 8px">
          <strong>推荐方案与已落实课表存在冲突</strong>
          <ul>
            <li v-for="(conflict, index) in result.conflicts" :key="index">
              {{ conflict.leftCourseName }}（{{ conflict.leftText }}）与 {{ conflict.rightCourseName }}（{{ conflict.rightText }}）
            </li>
          </ul>
        </div>
        <div v-if="result.pendingConfirmations.length > 0" class="alert alert--warning" style="margin-top: 8px">
          <strong>仍需确认的培养要求</strong>
          <ul>
            <li v-for="(item, index) in result.pendingConfirmations" :key="index">{{ item }}</li>
          </ul>
        </div>
      </section>

      <section class="card">
        <div class="card__header">
          <h3 class="card__title">培养需求进度</h3>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>需求类别</th>
                <th>要求学分</th>
                <th>已计入</th>
                <th>剩余</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in result.requirements" :key="item.requirementId">
                <td>{{ item.name }}</td>
                <td>{{ formatCredits(item.requiredCredits) }}</td>
                <td>{{ formatCredits(item.countedCredits) }}</td>
                <td>{{ formatCredits(item.remainingCredits) }}</td>
                <td>
                  <span class="badge" :class="item.satisfied ? 'badge--ok' : 'badge--warn'">
                    {{ item.satisfied ? '已满足' : '未满足' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">为什么是这个结果</h3>
        <span v-if="explainCourseId" class="muted small">课程 ID：{{ explainCourseId }}</span>
      </div>
      <p v-if="!explainCourseId" class="muted">在上面的方案里点击“为什么是这个结果”，或先选择一门课程。</p>
      <div v-else-if="explainLoading" class="muted">查询中…</div>
      <div v-else-if="explain">
        <div class="inline">
          <strong>{{ explain.course ? `${explain.course.name}（${explain.course.code}）` : `课程 ${explainCourseId}` }}</strong>
          <span v-if="explain.demand" class="badge badge--muted">{{ demandLabel(explain.demand.level) }}</span>
          <span v-if="explain.allocation" class="badge" :class="explain.allocation.decision === 'allocated' ? 'badge--ok' : 'badge--warn'">
            最近判定：{{ explain.allocation.decision }}
          </span>
        </div>
        <pre class="mono" style="white-space: pre-wrap; margin-top: 8px">{{ explain.text }}</pre>
        <h4 style="margin-top: 10px">来源（sources）</h4>
        <div class="table-wrap">
          <table class="table table--compact">
            <thead>
              <tr>
                <th>来源</th>
                <th>说明</th>
                <th>取值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(source, index) in explain.sources" :key="index">
                <td>{{ source.kind }}</td>
                <td>{{ source.description }}</td>
                <td>{{ source.value }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="tips" style="margin-top: 8px">
          排序规则：培养需求等级 → 全局志愿排名 → 固定随机键。随机键在提交志愿时固定，重交与重试都不会重抽。
        </p>
      </div>
    </section>
  </div>
</template>
