<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type {
  BatchDto,
  ConfirmationStatus,
  EnrolledRow,
  ProgressSnapshot,
  TimelineEvent,
  WaitlistEntry,
} from '@/api/types';
import { batchStatusLabel, formatCredits, formatDateTime } from '@/utils/labels';

interface ProfilePayload {
  profile: {
    userId: number;
    studentNo: string;
    name: string;
    grade: string | null;
    major: string | null;
    programName: string | null;
    programCode: string | null;
    totalCredits: number | null;
    expectedGraduateAt: string | null;
    lastLoginAt: string | null;
  };
  confirmation: ConfirmationStatus;
}

const toast = useToast();

const loading = ref(true);
const errorMessage = ref('');
const batches = ref<BatchDto[]>([]);
const currentBatch = ref<BatchDto | null>(null);
const profile = ref<ProfilePayload['profile'] | null>(null);
const confirmation = ref<ConfirmationStatus | null>(null);
const records = ref<{ enrolled: EnrolledRow[]; counts: Record<string, number> }>({ enrolled: [], counts: {} });
const progress = ref<ProgressSnapshot | null>(null);
const creditLimit = ref<number | null>(null);
const waitlist = ref<WaitlistEntry[]>([]);
const timeline = ref<TimelineEvent[]>([]);
const confirming = ref(false);

const enrolledCredits = computed(() => records.value.enrolled.reduce((sum, row) => sum + row.credits, 0));
const waitingCount = computed(
  () => waitlist.value.filter((entry) => entry.status === 'queued' || entry.status === 'suspended').length,
);
const unsatisfiedRequirements = computed(
  () => (progress.value?.requirements ?? []).filter((item) => !item.satisfied),
);

const hints = computed<string[]>(() => {
  const list: string[] = [];
  if (!currentBatch.value) {
    list.push('当前没有进行中的选课批次，请等待管理员开放。');
  } else {
    if (!currentBatch.value.configReady) {
      list.push(`批次必需配置尚未齐全：${currentBatch.value.configIssues.join('；')}`);
    }
    if (currentBatch.value.status === 'preparing') {
      list.push('批次处于资料准备阶段，暂不开放志愿提交。');
    }
    if (currentBatch.value.closeAt) {
      list.push(`本轮志愿截止时间：${formatDateTime(currentBatch.value.closeAt)}（以服务器时间为准）。`);
    }
  }
  if (confirmation.value?.needsReconfirm) {
    list.push('关键资料（培养方案/修读记录）已更新，需要重新确认后才能参与正式竞争。');
  } else if (confirmation.value && !confirmation.value.confirmed) {
    list.push('你还没有确认个人修读记录，请尽快在“修读记录”页确认。');
  }
  const suspended = waitlist.value.filter((entry) => entry.status === 'suspended');
  if (suspended.length > 0) {
    list.push(`有 ${suspended.length} 条候补申请暂挂，条件变化后系统会自动重新检查。`);
  }
  if (unsatisfiedRequirements.value.length > 0) {
    list.push(`还有 ${unsatisfiedRequirements.value.length} 个培养需求类别未完成，可在“偏好与规划”页生成方案。`);
  }
  return list;
});

async function load(): Promise<void> {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [batchRes, profileRes, recordsRes, progressRes, timelineRes] = await Promise.all([
      api.get<{ batches: BatchDto[]; current: BatchDto | null }>('/student/batches'),
      api.get<ProfilePayload>('/student/profile'),
      api.get<{ records: unknown[]; enrolled: EnrolledRow[]; confirmation: ConfirmationStatus }>('/student/records'),
      api.get<{ progress: ProgressSnapshot; creditLimit: number }>('/student/progress'),
      api.get<{ timeline: TimelineEvent[] }>('/student/timeline'),
    ]);
    batches.value = batchRes.batches;
    currentBatch.value = batchRes.current;
    profile.value = profileRes.profile;
    confirmation.value = profileRes.confirmation;
    records.value = {
      enrolled: recordsRes.enrolled,
      counts: (recordsRes.records as Array<{ status: string }>).reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {}),
    };
    progress.value = progressRes.progress;
    creditLimit.value = progressRes.creditLimit;
    timeline.value = timelineRes.timeline;

    if (batchRes.current) {
      const waitlistRes = await api.get<{ entries: WaitlistEntry[] }>('/waitlist', { batchId: batchRes.current.id });
      waitlist.value = waitlistRes.entries;
    } else {
      waitlist.value = [];
    }
  } catch (error) {
    errorMessage.value = apiErrorInfo(error).message;
  } finally {
    loading.value = false;
  }
}

async function confirmRecords(): Promise<void> {
  const ok = await askConfirm({
    title: '确认个人修读记录',
    message: '确认后表示你认可学校导入的修读记录，确认状态会作为参与正式竞争的前提。',
    confirmText: '确认',
    danger: false,
  });
  if (!ok) return;
  confirming.value = true;
  try {
    await api.post('/student/records/confirm');
    toast.success('已确认个人修读记录');
    await load();
  } catch (error) {
    reportApiError(error, '确认失败');
  } finally {
    confirming.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">选课概览</h1>
        <p class="page__desc">
          <template v-if="profile">
            {{ profile.name }}（{{ profile.studentNo }}） · {{ profile.major ?? '未填写专业' }} ·
            {{ profile.programName ?? '未关联培养方案' }}
          </template>
        </p>
      </div>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
    </div>

    <p v-if="errorMessage" class="alert alert--error">{{ errorMessage }}</p>

    <div class="grid grid--4">
      <div class="stat">
        <div class="stat__label">当前批次状态</div>
        <div class="stat__value" style="font-size: 16px">
          {{ currentBatch ? batchStatusLabel(currentBatch.status) : '无进行中批次' }}
        </div>
        <div class="stat__extra">
          <template v-if="currentBatch">
            {{ currentBatch.name }}（{{ currentBatch.term }}）<br />
            开放：{{ formatDateTime(currentBatch.openAt) }}<br />
            截止：{{ formatDateTime(currentBatch.closeAt) }}
          </template>
          <template v-else>请联系管理员开放批次</template>
        </div>
      </div>

      <div class="stat">
        <div class="stat__label">我的学分</div>
        <div class="stat__value">{{ formatCredits(enrolledCredits) }}</div>
        <div class="stat__extra">
          已获得 {{ formatCredits(progress?.passedCredits) }} 学分<br />
          本学期已选 {{ formatCredits(progress?.selectedCredits) }} 学分<br />
          学分上限 {{ formatCredits(creditLimit ?? currentBatch?.creditLimit) }}
        </div>
      </div>

      <div class="stat">
        <div class="stat__label">已选课程数</div>
        <div class="stat__value">{{ records.enrolled.length }}</div>
        <div class="stat__extra">
          含预分配/分配/候补提升/手工选课<br />
          已通过 {{ records.counts.passed ?? 0 }} 门 · 未通过 {{ records.counts.failed ?? 0 }} 门
        </div>
      </div>

      <div class="stat">
        <div class="stat__label">候补申请</div>
        <div class="stat__value">{{ waitingCount }}</div>
        <div class="stat__extra">
          其中暂挂 {{ waitlist.filter((entry) => entry.status === 'suspended').length }} 条<br />
          已提升 {{ waitlist.filter((entry) => entry.status === 'promoted').length }} 条
        </div>
      </div>

      <div class="stat">
        <div class="stat__label">待确认资料</div>
        <div class="stat__value" style="font-size: 16px">
          <span v-if="confirmation?.needsReconfirm" class="badge badge--danger">需重新确认</span>
          <span v-else-if="confirmation?.confirmed" class="badge badge--ok">已确认</span>
          <span v-else class="badge badge--warn">未确认</span>
        </div>
        <div class="stat__extra">
          确认时间：{{ formatDateTime(confirmation?.confirmedAt) }}
          <button
            v-if="!confirmation?.confirmed || confirmation?.needsReconfirm"
            class="btn btn--sm btn--primary"
            style="margin-top: 6px"
            type="button"
            :disabled="confirming"
            @click="confirmRecords"
          >
            {{ confirming ? '提交中…' : '确认我的修读记录' }}
          </button>
        </div>
      </div>
    </div>

    <div class="grid grid--2">
      <section class="card">
        <div class="card__header">
          <h3 class="card__title">待处理提示</h3>
        </div>
        <ul v-if="hints.length > 0" class="tips">
          <li v-for="(hint, index) in hints" :key="index">{{ hint }}</li>
        </ul>
        <p v-else class="muted">当前没有需要特别处理的事项。</p>
      </section>

      <section class="card">
        <div class="card__header">
          <h3 class="card__title">我的时间轴</h3>
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
              志愿：
              <template v-if="event.preferenceStatus === 'submitted'">已提交 v{{ event.preferenceVersion }}（{{ formatDateTime(event.submittedAt) }}）</template>
              <template v-else-if="event.preferenceStatus === 'withdrawn'">已撤回 v{{ event.preferenceVersion }}</template>
              <template v-else>未提交</template>
              <br />
              开放 {{ formatDateTime(event.openAt) }} · 截止 {{ formatDateTime(event.closeAt) }} · 发布
              {{ formatDateTime(event.publishedAt) }}
            </div>
            <div v-if="event.waitlist.length > 0" class="small muted">
              候补：{{ event.waitlist.map((item) => `${item.courseName}(${item.status}${item.position ? ` 第${item.position}位` : ''})`).join('；') }}
            </div>
          </div>
        </div>
      </section>
    </div>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">本学期已选课程</h3>
        <router-link class="btn btn--ghost btn--sm" :to="{ name: 'student-timetable' }">查看我的课表</router-link>
      </div>
      <div v-if="records.enrolled.length === 0" class="muted">还没有选上任何课程。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>课程号</th>
              <th>课程名</th>
              <th>学分</th>
              <th>来源</th>
              <th>是否使用预留</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in records.enrolled" :key="row.id">
              <td class="mono">{{ row.courseCode }}</td>
              <td>{{ row.courseName }}</td>
              <td>{{ formatCredits(row.credits) }}</td>
              <td>{{ row.source }}</td>
              <td>{{ row.usesReserved ? '是（毕业保障预留）' : '否' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">培养需求完成情况</h3>
      </div>
      <div v-if="!progress || progress.requirements.length === 0" class="muted">没有可用的培养方案数据。</div>
      <div v-else class="table-wrap">
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
            <tr v-for="item in progress.requirements" :key="item.requirementId">
              <td>{{ item.name }}<span class="badge badge--muted" style="margin-left: 6px">{{ item.code }}</span></td>
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
      <p class="tips" style="margin-top: 8px">
        口径说明：已通过学分与正在修读学分都算“已有安排”；本学期已选也算安排，但“已选不等于已通过”。
      </p>
    </section>
  </div>
</template>
