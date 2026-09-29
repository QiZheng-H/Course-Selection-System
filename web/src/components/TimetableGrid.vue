<script setup lang="ts">
/**
 * 周课表：行 = 节次 1-10，列 = 周一~周日。
 *
 * 说明：
 *   - 前端只负责“把后端返回的时段画到格子里”，不判断选课规则；
 *   - 同一格出现两门及以上课程时标红显示“冲突”，用于展示后端给出的冲突。
 */
import { computed } from 'vue';
import type { GridEntry, GridSession, ScheduleConflict } from '@/api/types';
import { sessionText } from '@/utils/labels';

const props = defineProps<{
  entries: GridEntry[];
  conflicts?: ScheduleConflict[];
}>();

const DAYS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

interface Block {
  key: string;
  entry: GridEntry;
  session: GridSession;
  isStart: boolean;
}

const cellMap = computed<Record<string, Block[]>>(() => {
  const map: Record<string, Block[]> = {};
  for (const entry of props.entries) {
    entry.sessions.forEach((session, index) => {
      const start = Math.max(1, Math.min(10, session.periodStart));
      const end = Math.max(1, Math.min(10, session.periodEnd));
      for (let period = start; period <= end; period += 1) {
        const key = `${session.dayOfWeek}-${period}`;
        if (!map[key]) map[key] = [];
        map[key].push({ key: `${entry.id}-${index}-${period}`, entry, session, isStart: period === start });
      }
    });
  }
  return map;
});

const conflictCells = computed(() => {
  const keys = new Set<string>();
  for (const [key, blocks] of Object.entries(cellMap.value)) {
    if (blocks.length > 1) keys.add(key);
  }
  return keys;
});

/** 后端返回的冲突涉及的教学班 id（用于高亮） */
const backendConflictClassIds = computed(() => {
  const ids = new Set<number | string>();
  for (const conflict of props.conflicts ?? []) {
    ids.add(conflict.leftClassId);
    ids.add(conflict.rightClassId);
  }
  return ids;
});

function blocksOf(day: number, period: number): Block[] {
  return cellMap.value[`${day}-${period}`] ?? [];
}

function isConflictCell(day: number, period: number): boolean {
  return conflictCells.value.has(`${day}-${period}`);
}

function isConflictEntry(entry: GridEntry): boolean {
  return backendConflictClassIds.value.has(entry.id);
}
</script>

<template>
  <div class="timetable">
    <table class="timetable__table">
      <thead>
        <tr>
          <th class="timetable__corner">节次</th>
          <th v-for="day in DAYS" :key="day.value">{{ day.label }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="period in PERIODS" :key="period">
          <th class="timetable__period">第{{ period }}节</th>
          <td
            v-for="day in DAYS"
            :key="`${day.value}-${period}`"
            class="timetable__cell"
            :class="{ 'timetable__cell--conflict': isConflictCell(day.value, period) }"
          >
            <div
              v-for="block in blocksOf(day.value, period)"
              :key="block.key"
              class="timetable__block"
              :class="{
                'timetable__block--cont': !block.isStart,
                'timetable__block--conflict': isConflictEntry(block.entry),
              }"
            >
              <template v-if="block.isStart">
                <div class="timetable__block-title">{{ block.entry.title }}</div>
                <div v-if="block.entry.subtitle" class="timetable__block-sub">{{ block.entry.subtitle }}</div>
                <div class="timetable__block-time">{{ sessionText(block.session) }}</div>
                <div v-if="block.session.room" class="timetable__block-time">教室：{{ block.session.room }}</div>
              </template>
              <span v-else class="timetable__cont-mark">↑</span>
            </div>
            <div v-if="isConflictCell(day.value, period)" class="timetable__conflict-tag">冲突</div>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="entries.length === 0" class="muted">当前课表没有任何课程。</p>
  </div>
</template>
