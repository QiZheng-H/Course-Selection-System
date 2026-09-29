<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { reportApiError } from '@/stores/toast';
import type { ClassDto, GridEntry, TimetablePayload } from '@/api/types';
import { formatCredits, sourceLabel } from '@/utils/labels';
import TimetableGrid from '@/components/TimetableGrid.vue';

const loading = ref(true);
const errorMessage = ref('');
const timetable = ref<TimetablePayload | null>(null);
const entries = ref<GridEntry[]>([]);
const missingSessions = ref<number[]>([]);

const credits = computed(() => timetable.value?.totalCredits ?? 0);
const creditLimit = computed(() => timetable.value?.creditLimit ?? 0);
const overLimit = computed(() => creditLimit.value > 0 && credits.value > creditLimit.value);

async function load(): Promise<void> {
  loading.value = true;
  errorMessage.value = '';
  try {
    const data = await api.get<{ timetable: TimetablePayload }>('/timetable');
    timetable.value = data.timetable;
    const missing: number[] = [];
    const built = await Promise.all(
      data.timetable.classes.map(async (cls): Promise<GridEntry> => {
        try {
          const detail = await api.get<{ class: ClassDto }>(`/classes/${cls.classId}`);
          return {
            id: cls.classId,
            title: cls.courseName,
            subtitle: `${cls.classCode} · 来源：${sourceLabel(cls.source)}${cls.usesReserved ? '（使用毕业保障预留）' : ''}`,
            source: cls.source,
            credits: cls.credits,
            sessions: detail.class.sessions,
          };
        } catch {
          missing.push(cls.classId);
          return {
            id: cls.classId,
            title: cls.courseName,
            subtitle: `${cls.classCode} · 来源：${sourceLabel(cls.source)}`,
            source: cls.source,
            credits: cls.credits,
            sessions: [],
          };
        }
      }),
    );
    entries.value = built;
    missingSessions.value = missing;
  } catch (error) {
    errorMessage.value = apiErrorInfo(error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load().catch((error) => reportApiError(error, '读取课表失败'));
});

function printPage(): void {
  window.print();
}
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">我的正式课表</h1>
        <p class="page__desc">
          课表来自正式选课结果（预分配 / 统一分配 / 候补提升 / 手工选课），正常情况下不应该出现冲突。
        </p>
      </div>
      <div class="inline">
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
        <button class="btn btn--ghost btn--sm" type="button" @click="printPage">打印课表</button>
      </div>
    </div>

    <p v-if="errorMessage" class="alert alert--error">{{ errorMessage }}</p>

    <div class="grid grid--3">
      <div class="stat">
        <div class="stat__label">已落实课程</div>
        <div class="stat__value">{{ entries.length }}</div>
        <div class="stat__extra">门</div>
      </div>
      <div class="stat">
        <div class="stat__label">学分合计</div>
        <div class="stat__value">{{ formatCredits(credits) }}</div>
        <div class="stat__extra">学分上限 {{ formatCredits(creditLimit) }}</div>
      </div>
      <div class="stat">
        <div class="stat__label">冲突数量</div>
        <div class="stat__value">{{ timetable?.conflicts.length ?? 0 }}</div>
        <div class="stat__extra">正常情况下应为 0</div>
      </div>
    </div>

    <p v-if="overLimit" class="alert alert--error">
      当前总学分 {{ formatCredits(credits) }} 已超过上限 {{ formatCredits(creditLimit) }}，请联系管理员核对。
    </p>

    <section v-if="timetable && timetable.conflicts.length > 0" class="card">
      <h3 class="card__title">检测到的时间冲突</h3>
      <div class="alert alert--error" style="margin-top: 8px">
        <ul>
          <li v-for="(conflict, index) in timetable.conflicts" :key="index">
            {{ conflict.leftCourseName }}（{{ conflict.leftText }}）与 {{ conflict.rightCourseName }}（{{ conflict.rightText }}）
            <span v-if="conflict.weeks.length > 0">，第 {{ conflict.weeks.join('、') }} 周</span>
          </li>
        </ul>
      </div>
    </section>

    <p v-if="missingSessions.length > 0" class="alert alert--warning">
      有 {{ missingSessions.length }} 个教学班的详细时段读取失败，这些课程不会出现在下方课表网格中（课程列表仍会显示）。
    </p>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">周课表（行 = 节次 1-10，列 = 周一~周日）</h3>
        <span class="muted small">同一格出现两门课程时会标红并显示“冲突”</span>
      </div>
      <div v-if="loading" class="empty">加载中…</div>
      <TimetableGrid v-else :entries="entries" :conflicts="timetable?.conflicts ?? []" />
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">课程来源明细</h3>
      </div>
      <div v-if="entries.length === 0" class="muted">当前没有已落实的课程。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>课程</th>
              <th>教学班</th>
              <th>学分</th>
              <th>来源</th>
              <th>时段</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in timetable?.classes ?? []" :key="row.classId">
              <td>{{ row.courseName }}</td>
              <td class="mono">{{ row.classCode }}</td>
              <td>{{ formatCredits(row.credits) }}</td>
              <td>
                <span class="badge" :class="row.source === 'manual' ? 'badge--elective' : 'badge--ok'">
                  {{ sourceLabel(row.source) }}
                </span>
                <span v-if="row.usesReserved" class="badge badge--warn">使用毕业保障预留</span>
              </td>
              <td class="small">
                <div v-for="(text, index) in row.sessions" :key="index">{{ text }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
