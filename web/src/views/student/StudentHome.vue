<script setup lang="ts">
/**
 * 学生端首页「我的选课」。
 *
 * 只做一件事：用一屏说清“现在是什么阶段、我该做什么、我的志愿与课表长什么样”。
 * 所有阶段判断、可做操作、名额与冲突都由后端给出（useStage + 志愿接口），
 * 前端不推断业务规则，也不显示任何内部状态名、字段名或记录号。
 *
 * 阶段变化不在这里轮询：外壳每 20 秒刷新一次阶段，本页监听批次变化后重新读取。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { loadStage, useStage } from '@/stores/stage';
import type {
  ClassDto,
  DraftPayload,
  GridEntry,
  PreferenceItem,
  PreferencePreview,
  PreferencesPayload,
  PreferenceView,
  StageKey,
} from '@/api/types';
import { formatCredits, sessionText } from '@/utils/labels';

interface ProfileInfo {
  name: string;
  major: string | null;
  grade: string | null;
  programName: string | null;
}

interface ProfilePayload {
  profile: ProfileInfo & { studentNo: string };
}

/** 课程卡上要显示的那一行信息（来自该课程的第一个教学班） */
interface ClassSummary {
  classCode: string;
  sessionText: string;
  teacherName: string;
}

type StageCopy = { title: string; desc: (context: { draftCount: number }) => string };

const router = useRouter();
const { stage } = useStage();

const profile = ref<ProfileInfo | null>(null);
const view = ref<PreferenceView | null>(null);
const draft = ref<DraftPayload | null>(null);
const preview = ref<PreferencePreview | null>(null);
const loadError = ref('');
const loading = ref(true);

/** 教学班信息按需补全：志愿接口只给教学班编号，卡片上要显示时间与教师 */
const classInfoCache = reactive<Record<number, ClassSummary>>({});

const stageKey = computed<StageKey>(() => stage.value?.stageKey ?? 'no_activity');
const batchId = computed<number | null>(() => stage.value?.batchId ?? null);
const canSubmitPreference = computed(() => stage.value?.canSubmitPreference ?? false);

/** 学生已整理的志愿门数：以草稿为准，还没提交过时用草稿兜底 */
const draftCount = computed(() => draft.value?.preferences.length ?? 0);
/** 列表里展示的已是“正式提交版本”；没有再回落到草稿 */
const wantedItems = computed<PreferenceItem[]>(() => {
  const items = view.value?.items ?? [];
  return items.slice().sort((left, right) => left.globalRank - right.globalRank);
});
const wantedCount = computed(() => (wantedItems.value.length > 0 ? wantedItems.value.length : draftCount.value));

const isSubmitted = computed(() => view.value?.status === 'submitted');
const submittedBadgeClass = computed(() => (isSubmitted.value ? 'badge badge--ok' : 'badge badge--muted'));

const plannedCreditsText = computed(() =>
  preview.value ? formatCredits(preview.value.plannedCredits) : '—',
);

/** 冲突 / 名额已满：预演里只要有排不进课表的志愿，就用警告语气提示 */
const hasTrouble = computed(() => {
  const summary = preview.value?.summary;
  if (!summary) return false;
  return summary.conflict + summary.noSeat > 0;
});

/** 排不进课表的志愿里最靠前的那一个，用于“与第 N 志愿时间冲突” */
const troubleRank = computed<number | null>(() => {
  const attempts = preview.value?.attempts ?? [];
  const bad = attempts
    .filter((attempt) => attempt.status === 'conflict' || attempt.status === 'no_seat' || attempt.status === 'over_limit')
    .sort((left, right) => left.rank - right.rank);
  return bad[0]?.rank ?? null;
});

const summaryText = computed(() => {
  const summary = preview.value?.summary;
  if (!summary) return '—';
  return `${summary.total} 门志愿 · ${hasTrouble.value ? `${summary.conflict + summary.noSeat} 门有时间冲突` : '暂无时间冲突'}`;
});

/** 我的学期计划右侧小字：只说明“有没有正式提交”，不出现版本号之外的技术细节 */
const submittedNote = computed(() => (isSubmitted.value ? '已提交' : '未提交'));

/**
 * 第 3 步的状态完全由后端阶段决定：
 * 还能提交时是进行中；已经提交、或本阶段已不能提交时，这一步显示为已完成。
 */
const reviewStepState = computed<'done' | 'active'>(() =>
  view.value?.status === 'submitted' ? 'done' : canSubmitPreference.value ? 'active' : 'done',
);

const HERO_COPY: Record<StageKey, StageCopy> = {
  preference_open: {
    title: '你的选课计划，还差最后一步。',
    desc: ({ draftCount: count }) =>
      count > 0 ? `已整理好 ${count} 门志愿，检查后就可以提交了。` : '先在志愿页挑几门想上的课，再来检查提交。',
  },
  materials: {
    title: '选课还没开始，先看看培养方案。',
    desc: () => '这段时间可以先了解专业要求，选课开放后再来整理志愿。',
  },
  plan_pending: {
    title: '志愿已提交，等待分配结果。',
    desc: () => '现在不用再操作，分配结果公布后会在这里提示你。',
  },
  plan_ready: {
    title: '志愿已提交，等待分配结果。',
    desc: () => '分配正在安排中，结果公布后会在这里提示你。',
  },
  result_published: {
    title: '结果已公布，退改选还未开放。',
    desc: () => '现在只能查看结果，暂时不能选退换课。',
  },
  change_open: {
    title: '退改选进行中，可以继续调整。',
    desc: () => '想换课或退课，都可以在结果页直接操作。',
  },
  closed: {
    title: '本次选课已结束。',
    desc: () => '本轮已经结束，下面的记录只作查看。',
  },
  no_activity: {
    title: '当前没有进行中的选课活动。',
    desc: () => '等管理员开放新一轮选课后，这里会显示你可以做的事。',
  },
};

const heroCopy = computed<StageCopy>(() => HERO_COPY[stageKey.value]);
const heroTitle = computed(() => heroCopy.value.title);
const heroDesc = computed(() => heroCopy.value.desc({ draftCount: draftCount.value }));

/** 阶段说明 + 截止时间（没有截止时间时只显示阶段） */
const heroEyebrow = computed(() => {
  const label = stage.value?.stageLabel ?? '当前阶段';
  const closeAt = stage.value?.closeAt;
  return closeAt ? `${label} · ${formatDateTimeText(closeAt)} 截止` : label;
});

/** 主按钮与次按钮：都指向学生真正的下一步 */
type StudentRouteName = 'student-program' | 'student-preferences' | 'student-results' | 'student-timetable';
const heroActions = computed<{ primaryLabel: string; primaryTo: StudentRouteName; ghostTo: StudentRouteName | null }>(() => {
  const key = stageKey.value;
  if (key === 'no_activity') {
    return { primaryLabel: '查看培养方案', primaryTo: 'student-program', ghostTo: null };
  }
  if (key === 'preference_open') {
    return { primaryLabel: '检查并提交志愿 ↗', primaryTo: 'student-preferences', ghostTo: null };
  }
  if (key === 'change_open') {
    return { primaryLabel: '去选退课 ↗', primaryTo: 'student-results', ghostTo: 'student-timetable' };
  }
  const ghostTo = key === 'result_published' || key === 'closed' ? 'student-timetable' : null;
  return { primaryLabel: '查看我的志愿', primaryTo: 'student-preferences', ghostTo };
});

/* -------------------------------- 问候与日期 -------------------------------- */

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const today = new Date();
const greetingDate = `${today.getMonth() + 1} 月 ${today.getDate()} 日`;
const greetingWeekday = WEEKDAY_NAMES[today.getDay()] ?? '';

/**
 * 学期季节：优先按批次学期文字判断，读不到时退回到当前月份（秋季学期 8 月—次年 1 月）。
 */
const termSeason = computed(() => {
  const term = stage.value?.term ?? '';
  if (term.includes('秋') || term.includes('第一学期')) return '秋季';
  if (term.includes('春') || term.includes('第二学期')) return '春季';
  const month = today.getMonth() + 1;
  return month >= 8 || month <= 1 ? '秋季' : '春季';
});

const greetingSubtitle = computed(() => `${greetingWeekday} · ${termSeason.value}选课`);

function formatDateTimeText(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)} 月 ${pad(date.getDate())} 日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* --------------------------------- 课程卡 --------------------------------- */

function courseInitial(name: string): string {
  return name.trim().slice(0, 1) || '课';
}

/** 补全某门课程第一个教学班的信息（失败时静默降级为只显示教学班编号） */
async function ensureClassInfo(item: PreferenceItem): Promise<void> {
  const classId = item.classChoices[0]?.classId;
  if (!classId || classInfoCache[classId]) return;
  try {
    const data = await api.get<{ class: ClassDto }>(`/classes/${classId}`);
    const sessions = data.class.sessions ?? [];
    classInfoCache[classId] = {
      classCode: data.class.classCode,
      sessionText: sessions.length > 0 ? sessionText(sessions[0]) : '',
      teacherName: data.class.teacher?.name ?? '',
    };
  } catch {
    // 读不到教学班详情不影响主流程，卡片上只显示已有信息
  }
}

function classSummaryOf(item: PreferenceItem): ClassSummary | null {
  const classId = item.classChoices[0]?.classId;
  if (!classId) return null;
  return classInfoCache[classId] ?? null;
}

function courseMeta(item: PreferenceItem): string {
  const choice = item.classChoices[0];
  if (!choice) return '尚未指定教学班，由系统安排';
  const summary = classSummaryOf(item);
  const parts = [summary?.sessionText || choice.classCode];
  if (summary?.teacherName) parts.push(summary.teacherName);
  return parts.join(' · ');
}

/* -------------------------------- 紧凑周课表 -------------------------------- */

/** 只画周一~周五、三行：第 1-2 节 / 第 3-4 节 / 第 5-6 节 */
const MINI_DAYS = [1, 2, 3, 4, 5];
const MINI_DAY_LABEL: Record<number, string> = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五' };
interface MiniRow {
  label: string;
  from: number;
  to: number;
}
const MINI_ROWS: MiniRow[] = [
  { label: '第 1-2 节', from: 1, to: 2 },
  { label: '第 3-4 节', from: 3, to: 4 },
  { label: '第 5-6 节', from: 5, to: 6 },
];

/** 落在某个小格里的志愿课（同一格多门时叠加显示） */
interface MiniBlock {
  key: string;
  title: string;
  room: string | null;
  tone: string;
}

/** 节次落在第几行；跨行的课按起始节次归档 */
function miniRowIndex(periodStart: number): number {
  const index = MINI_ROWS.findIndex((row) => periodStart >= row.from && periodStart <= row.to);
  return index;
}

/** 把预演课表落到小格子里；格子里的顺序与课表条目顺序一致，颜色循环使用 */
const miniGrid = computed<MiniBlock[][][]>(() => {
  const cells: MiniBlock[][][] = MINI_ROWS.map(() => MINI_DAYS.map(() => []));
  const tonePool = ['a', 'b', 'c', 'd'];
  const entries = preview.value?.entries ?? [];

  entries.forEach((entry: GridEntry, entryIndex: number) => {
    const tone = tonePool[entryIndex % tonePool.length];
    for (const session of entry.sessions) {
      const row = miniRowIndex(session.periodStart);
      const column = MINI_DAYS.indexOf(session.dayOfWeek);
      if (row < 0 || column < 0) continue;
      cells[row][column].push({
        key: `${entry.id}-${session.dayOfWeek}-${session.periodStart}`,
        title: entry.title,
        room: session.room ?? null,
        tone,
      });
    }
  });
  return cells;
});

/** 一格最多显示 2 门，其余折叠成“…” */
function visibleBlocks(blocks: MiniBlock[]): MiniBlock[] {
  return blocks.slice(0, 2);
}

function hiddenBlockCount(blocks: MiniBlock[]): number {
  return Math.max(0, blocks.length - 2);
}

function blockClass(block: MiniBlock): string {
  return `timetable-mini__block timetable-mini__block--${block.tone}`;
}

/** 课表脚注：有冲突时点明是与第几志愿冲突，没有冲突时给一个明确的安心结论 */
const timetableFootText = computed(() => {
  if (!preview.value) return '—';
  if (hasTrouble.value && troubleRank.value !== null) return `⚠ 与第 ${troubleRank.value} 志愿时间冲突`;
  if (hasTrouble.value) return '⚠ 部分志愿排不进课表';
  return '✓ 时间安排不冲突';
});
const timetableFootClass = computed(() => (hasTrouble.value ? 'small' : 'small muted'));
const timetableFootStyle = computed(() =>
  hasTrouble.value ? { color: 'var(--color-warning)' } : undefined,
);

/* --------------------------------- 文案条 --------------------------------- */

const noteText = computed(() =>
  isSubmitted.value
    ? '志愿已提交，截止前仍可修改，最终安排以选课结果为准。'
    : '志愿草稿尚未提交，最终安排以选课结果为准。',
);

/* -------------------------------- 数据加载 -------------------------------- */

async function loadProfile(): Promise<void> {
  try {
    const data = await api.get<ProfilePayload>('/student/profile');
    profile.value = data.profile;
  } catch (error) {
    loadError.value = apiErrorInfo(error).message;
  }
}

async function loadPreferences(targetBatchId: number): Promise<void> {
  try {
    const data = await api.get<PreferencesPayload>('/preferences', { batchId: targetBatchId });
    view.value = data.view;
    draft.value = data.draft;
    preview.value = null;

    // 列表里展示的是正式提交版本；没有提交记录时让学生至少看到自己整理过的课
    const listItems = data.view.items.length > 0 ? data.view.items : [];
    await Promise.all(listItems.map((item) => ensureClassInfo(item)));

    // 预演只读：用草稿数据问后端“按现在的名额会排成什么样”
    const draftPreferences = data.draft.preferences ?? [];
    if (draftPreferences.length > 0 || listItems.length > 0) {
      try {
        preview.value = await api.post<PreferencePreview>('/preferences/preview', {
          batchId: targetBatchId,
          preferences: draftPreferences,
          groups: data.draft.groups ?? [],
        });
      } catch {
        // 预演失败时保留“—”与隐藏状态，不把没拿到的数据当成 0
        preview.value = null;
      }
    }
  } catch (error) {
    loadError.value = apiErrorInfo(error).message;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  await loadStage();
  const targetBatchId = batchId.value;
  await Promise.all([loadProfile(), targetBatchId === null ? Promise.resolve() : loadPreferences(targetBatchId)]);
  loading.value = false;
}

onMounted(() => {
  void load();
});

// 阶段由外壳刷新；批次换了（开放新一轮 / 切换活动）就重新读取本页数据
watch(batchId, (next, previous) => {
  if (next === previous || next === null) return;
  loadError.value = '';
  void loadPreferences(next);
});
</script>

<template>
  <div class="page">
    <!-- ① 问候区 -->
    <div class="greeting">
      <div>
        <h1 class="greeting__title">嗨，{{ profile?.name ?? '同学' }}。</h1>
        <p class="greeting__desc">新学期，从一份喜欢的课表开始。</p>
      </div>
      <div class="greeting__date">
        {{ greetingDate }}
        <small>{{ greetingSubtitle }}</small>
      </div>
    </div>

    <!-- 读取失败：只报错并提供重试，不显示任何“0 门 / 0 学分” -->
    <p v-if="loadError" class="alert alert--error">
      读取失败
      <span class="small muted">{{ loadError }}</span>
      <button class="btn btn--ghost btn--sm" type="button" style="margin-left: 10px" :disabled="loading" @click="load">
        {{ loading ? '读取中…' : '重试' }}
      </button>
    </p>

    <!-- ② 阶段大卡 -->
    <section class="hero">
      <div>
        <p class="hero__eyebrow">{{ heroEyebrow }}</p>
        <h2 class="hero__title">{{ heroTitle }}</h2>
        <p class="hero__desc">{{ heroDesc }}</p>
        <div class="hero__actions">
          <button
            class="btn btn--primary btn--lg"
            type="button"
            @click="router.push({ name: heroActions.primaryTo })"
          >
            {{ heroActions.primaryLabel }}
          </button>
          <button
            v-if="heroActions.ghostTo"
            class="btn btn--ghost"
            type="button"
            @click="router.push({ name: heroActions.ghostTo })"
          >
            查看课表
          </button>
        </div>
      </div>

      <aside class="hero__side">
        <div class="hero__side-head">
          <span>我的学期计划</span>
          <span class="badge" :class="submittedBadgeClass">{{ submittedNote }}</span>
        </div>
        <div class="hero__metric">
          <span class="hero__metric-value">{{ plannedCreditsText }}</span>
          <span class="hero__metric-label">拟选学分</span>
        </div>
        <p class="small muted" :style="hasTrouble ? { color: 'var(--color-warning)' } : undefined">{{ summaryText }}</p>
      </aside>
    </section>

    <!-- ③ 三步小进度：状态一律由后端阶段决定 -->
    <nav class="stepper stepper--compact">
      <span class="stepper__item stepper__item--done">
        <span class="stepper__dot">✓</span>
        <span class="stepper__label">挑选课程</span>
      </span>
      <span class="stepper__line"></span>
      <span class="stepper__item stepper__item--done">
        <span class="stepper__dot">✓</span>
        <span class="stepper__label">安排志愿顺序</span>
      </span>
      <span class="stepper__line"></span>
      <span class="stepper__item" :class="`stepper__item--${reviewStepState}`">
        <span class="stepper__dot">{{ reviewStepState === 'done' ? '✓' : '3' }}</span>
        <span class="stepper__label">检查并提交</span>
      </span>
    </nav>

    <!-- ④ 两栏 -->
    <div class="two-col">
      <section>
        <div class="inline">
          <h3 class="section-title">
            想上的课
            <span class="section-title__count">{{ wantedCount }} 门</span>
          </h3>
          <span class="spacer"></span>
          <button class="link-btn" type="button" @click="router.push({ name: 'student-preferences' })">查看全部 ↗</button>
        </div>

        <div v-if="wantedItems.length === 0" class="card" style="margin-top: 10px">
          <div class="empty">
            <p>还没选课</p>
            <button class="btn btn--primary btn--sm" type="button" @click="router.push({ name: 'student-preferences' })">
              去挑课
            </button>
          </div>
        </div>

        <div v-else style="margin-top: 10px">
          <article v-for="item in wantedItems" :key="item.preferenceId" class="course-card">
            <span class="course-card__icon">{{ courseInitial(item.courseName) }}</span>
            <div class="course-card__body">
              <h4 class="course-card__title">{{ item.courseName }}</h4>
              <p class="course-card__meta">{{ courseMeta(item) }}</p>
            </div>
            <div class="course-card__side">
              <div class="course-card__credits">{{ formatCredits(item.credits) }} 学分</div>
              <div class="course-card__rank">第 {{ item.globalRank }} 志愿</div>
            </div>
          </article>
        </div>
      </section>

      <section class="card">
        <div class="card__header">
          <h3 class="card__title">课表先看一看</h3>
          <span class="small muted">志愿草稿</span>
        </div>

        <!-- 紧凑周课表：左侧节次 + 顶部周几，一格多门课时叠加显示 -->
        <div class="timetable-mini timetable-mini--labeled">
          <div class="timetable-mini__corner"></div>
          <div v-for="day in MINI_DAYS" :key="`head-${day}`" class="timetable-mini__head">
            {{ MINI_DAY_LABEL[day] }}
          </div>
          <template v-for="(row, rowIndex) in miniGrid" :key="`row-${rowIndex}`">
            <div class="timetable-mini__period">{{ MINI_ROWS[rowIndex]?.label }}</div>
            <div v-for="(cell, columnIndex) in row" :key="`cell-${rowIndex}-${columnIndex}`" class="timetable-mini__cell">
              <div v-for="block in visibleBlocks(cell)" :key="`${columnIndex}-${block.key}`" :class="blockClass(block)">
                <strong>{{ block.title }}</strong>
                <span v-if="block.room">{{ block.room }}</span>
              </div>
              <div v-if="hiddenBlockCount(cell) > 0" class="small muted">…</div>
            </div>
          </template>
        </div>

        <div class="timetable-mini__foot">
          <span :class="timetableFootClass" :style="timetableFootStyle">{{ timetableFootText }}</span>
          <button class="link-btn" type="button" @click="router.push({ name: 'student-timetable' })">
            完整周次在详情中查看
          </button>
        </div>
      </section>
    </div>

    <!-- ⑤ 底部说明 -->
    <p class="note">
      <span class="note__index">①</span>
      <span>{{ noteText }}</span>
    </p>
  </div>
</template>
