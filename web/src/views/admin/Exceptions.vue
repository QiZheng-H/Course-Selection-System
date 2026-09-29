<script setup lang="ts">
/**
 * 待处理问题（原「异常清单」）。
 *
 * 面向不懂技术的管理员，按“是否阻塞下一步”分成三组：
 *   1. 必须解决，才能继续（未处理 + 严重）：不处理就无法发布选课结果；
 *   2. 可以继续，但需关注（未处理 + 非严重）：不阻塞流程，但要评估业务影响；
 *   3. 已处理：默认收起，保留处理说明、处理人与处理时间。
 *
 * 重要：填写处理说明只记录处理过程，不会改变名额或课表；系统会按业务条件重新检查，
 * 条件仍然不满足时问题会继续出现。因此页面不提供任何跳过校验的入口。
 * 问题类型代码、内部编号与精确时间只出现在「显示详细信息」折叠区。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { loadActivities, useActivity } from '@/stores/activity';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type { AuditPayload, ExceptionRow, Paged } from '@/api/types';
import { formatDateTime, severityLabel } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

/** 异常记录 + 处理人（处理人由审计日志补充，列表接口暂未返回该字段） */
interface AdminException extends ExceptionRow {
  resolvedByName?: string | null;
}

/** 处理该问题的入口页面（与路由 name 对应，页面上不出现具体网址） */
type FixRouteName = 'admin-workspace' | 'admin-students-guarantee' | 'admin-teaching-courses' | 'admin-records-config';

interface ExceptionMeta {
  /** 中文业务名称；类型未识别时使用通用标题 */
  label: string;
  /** 是否识别出问题类型；未识别时原始代码只放在“显示详细信息”里 */
  known: boolean;
  /** 会阻塞哪个动作（仅“必须解决”组展示） */
  blocks: string;
  /** 业务影响（面向管理员，不出现技术名词） */
  impact: string;
  /** 建议动作 */
  suggestion: string;
  fix: FixRouteName;
  fixLabel: string;
}

/** 问题类型 → 业务语言。字段缺失或未识别时走 UNKNOWN_META。 */
const KIND_META: Record<string, Omit<ExceptionMeta, 'known'>> = {
  guarantee_no_solution: {
    label: '毕业必要课程无法同时安排',
    blocks: '会阻塞发布选课结果',
    impact: '该学生的毕业必要课程在本轮无法同时安排，直接发布会导致学生缺少毕业必需课程。',
    suggestion: '到毕业保护名单查看无解原因，调整受保护课程或相关教学班的时间与容量，然后重新生成分配方案。',
    fix: 'admin-students-guarantee',
    fixLabel: '去毕业保护名单处理',
  },
  guarantee_no_authorization: {
    label: '缺少学生兜底授权',
    blocks: '会阻塞发布选课结果',
    impact: '该学生没有有效的兜底授权，系统不会自动为其扩大选择范围，毕业保障无法落实。',
    suggestion: '联系学生本人确认可以接受的教学班。授权只能由学生自己确认，管理员不能代为提交。',
    fix: 'admin-students-guarantee',
    fixLabel: '去毕业保护名单查看',
  },
  guarantee_rejected_all: {
    label: '毕业保障课程全部未落实',
    blocks: '会阻塞发布选课结果',
    impact: '学生接受的教学班都不可用（不属于本课程、名额已满或时间冲突），毕业保障课程一门都没有落实。',
    suggestion: '检查该课程的教学班是否已取消、名额是否被占满，必要时与学生协调其他教学班或其他可行课程。',
    fix: 'admin-students-guarantee',
    fixLabel: '去毕业保护名单查看',
  },
  guarantee_not_submitted: {
    label: '保护学生未提交志愿',
    blocks: '不阻塞发布选课结果',
    impact: '处在毕业保护名单中的学生没有提交志愿，系统无法自动兜底，该学生可能缺少毕业保障课程。',
    suggestion: '提醒学生在截止前提交志愿；若该学生本轮不需要保障，可在毕业保护名单中确认后移除。',
    fix: 'admin-students-guarantee',
    fixLabel: '去毕业保护名单查看',
  },
  allocation_timeout: {
    label: '分配计算超时',
    blocks: '会阻塞发布选课结果',
    impact: '本轮没有生成可发布的分配方案，学生看不到任何选课结果。',
    suggestion: '到工作台重新生成分配方案；若反复超时，可先减少教学班时间冲突或缩小本轮规模。',
    fix: 'admin-workspace',
    fixLabel: '去工作台重新生成',
  },
  class_cancelled: {
    label: '教学班已取消',
    blocks: '会阻塞发布选课结果',
    impact: '涉及的教学班已经取消，仍按原方案分配会产生无效的选课记录。',
    suggestion: '到教学资料核对教学班状态与容量，补齐替代教学班后重新生成分配方案。',
    fix: 'admin-teaching-courses',
    fixLabel: '去教学资料核对',
  },
  data_inconsistent: {
    label: '数据不一致',
    blocks: '会阻塞发布选课结果',
    impact: '本轮生成分配方案时发现数据前后对不上，结果不可信，不能直接发布。',
    suggestion: '到工作台重新生成分配方案；若同样的问题反复出现，请核对最近改动的教学资料与志愿数据。',
    fix: 'admin-workspace',
    fixLabel: '去工作台处理',
  },
};

const UNKNOWN_META: ExceptionMeta = {
  label: '需要核实的问题',
  known: false,
  blocks: '会阻塞发布选课结果',
  impact: '系统记录了一条需要人工核实的问题，具体原因见“显示详细信息”。',
  suggestion: '先查看详细信息确认影响范围；若与教学班或志愿数据有关，请到对应页面核对后重新生成分配方案。',
  fix: 'admin-workspace',
  fixLabel: '去工作台查看',
};

const toast = useToast();
const router = useRouter();
const activity = useActivity();
/** 当前选课活动来自全局选择，页面内不再放批次下拉框 */
const currentActivity = activity.selected;

const openItems = ref<AdminException[]>([]);
const openTotal = ref(0);
const handledItems = ref<AdminException[]>([]);
const handledTotal = ref(0);
const loading = ref(false);
const loadedOnce = ref(false);
const loadError = ref('');

const handledPage = ref(1);
const handledPageSize = 10;

const resolutionText = reactive<Record<number, string>>({});
const resolving = reactive<Record<number, boolean>>({});

/** 必须解决：未处理且严重，不处理无法发布选课结果 */
const blockingItems = computed(() => openItems.value.filter((row) => row.severity === 'critical'));
/** 可以继续，但需关注：未处理且非严重 */
const attentionItems = computed(() => openItems.value.filter((row) => row.severity !== 'critical'));
const handledPageItems = computed(() => {
  const start = (handledPage.value - 1) * handledPageSize;
  return handledItems.value.slice(start, start + handledPageSize);
});
const counts = computed(() => ({
  blocking: blockingItems.value.length,
  attention: attentionItems.value.length,
  handled: handledTotal.value,
}));
/** 单次最多读取 200 条，超出时给出提示而不是静默丢弃 */
const truncated = computed(() => openTotal.value > openItems.value.length);

/** 处理人姓名：列表接口未返回时，用审计日志补齐（失败只影响这一个字段） */
const resolverNames = ref<Record<number, string>>({});

function metaOf(kind: string): ExceptionMeta {
  const found = KIND_META[kind];
  return found ? { ...found, known: true } : UNKNOWN_META;
}

function subjectOf(row: AdminException): string {
  const parts: string[] = [];
  if (row.studentName || row.studentNo) {
    parts.push(`学生：${row.studentName ?? '（未记录姓名）'}${row.studentNo ? `（${row.studentNo}）` : ''}`);
  }
  if (row.courseName) parts.push(`课程：${row.courseName}`);
  return parts.length > 0 ? parts.join(' · ') : '影响范围：本次选课活动整体';
}

function detailText(row: AdminException): string {
  if (!row.detail) return '无';
  try {
    return JSON.stringify(JSON.parse(row.detail), null, 2);
  } catch {
    return row.detail;
  }
}

function resolverOf(row: AdminException): string {
  return row.resolvedByName ?? resolverNames.value[row.id] ?? '—';
}

function changeHandledPage(page: number): void {
  handledPage.value = page;
}

async function loadResolverNames(): Promise<void> {
  try {
    const data = await api.get<AuditPayload>('/admin/audit', {
      action: 'exception.resolve',
      page: 1,
      pageSize: 200,
    });
    const map: Record<number, string> = {};
    for (const row of data.items) {
      if (row.entity_id === null || !row.actor_name) continue;
      const id = Number(row.entity_id);
      if (Number.isInteger(id) && map[id] === undefined) map[id] = row.actor_name;
    }
    resolverNames.value = map;
  } catch {
    resolverNames.value = {};
  }
}

async function load(): Promise<void> {
  const batchId = activity.selectedId.value;
  if (!batchId) {
    openItems.value = [];
    openTotal.value = 0;
    handledItems.value = [];
    handledTotal.value = 0;
    handledPage.value = 1;
    loadError.value = '';
    loadedOnce.value = true;
    return;
  }
  loading.value = true;
  loadError.value = '';
  try {
    const [open, resolved, ignored] = await Promise.all([
      api.get<Paged<AdminException>>('/admin/exceptions', { batchId, status: 'open', page: 1, pageSize: 200 }),
      api.get<Paged<AdminException>>('/admin/exceptions', { batchId, status: 'resolved', page: 1, pageSize: 200 }),
      api.get<Paged<AdminException>>('/admin/exceptions', { batchId, status: 'ignored', page: 1, pageSize: 200 }),
    ]);
    openItems.value = open.items;
    openTotal.value = open.total;
    handledItems.value = [...resolved.items, ...ignored.items].sort((a, b) => {
      const left = a.resolvedAt ?? a.createdAt;
      const right = b.resolvedAt ?? b.createdAt;
      return right.localeCompare(left) || b.id - a.id;
    });
    handledTotal.value = resolved.total + ignored.total;
    handledPage.value = 1;
    await loadResolverNames();
  } catch (error) {
    // 读取失败时清空数据并保留错误信息，绝不用 0 冒充“没有问题”
    openItems.value = [];
    openTotal.value = 0;
    handledItems.value = [];
    handledTotal.value = 0;
    loadError.value = apiErrorInfo(error, '读取失败').message;
  } finally {
    loading.value = false;
    loadedOnce.value = true;
  }
}

async function reloadAll(): Promise<void> {
  await loadActivities(true);
  await load();
}

async function resolve(row: AdminException): Promise<void> {
  const text = (resolutionText[row.id] ?? '').trim();
  if (!text) {
    toast.warning('请先填写处理说明', ['处理说明会记录到问题处理过程中，便于后续核对。']);
    return;
  }
  const meta = metaOf(row.kind);
  const ok = await askConfirm({
    title: '标记为已处理',
    message: '这只会记录处理过程，不会改变名额或课表；如果条件仍不满足，问题会继续出现。',
    details: [`问题：${meta.label}`, subjectOf(row), `处理说明：${text}`],
    confirmText: '记录并标记已处理',
    cancelText: '再检查一下',
    danger: false,
  });
  if (!ok) return;
  resolving[row.id] = true;
  try {
    await api.post(`/admin/exceptions/${row.id}/resolve`, { resolution: text, status: 'resolved' });
    resolutionText[row.id] = '';
    toast.success('已记录处理过程', ['如果名额或时间条件仍不满足，系统下次检查时还会提示这个问题。']);
    await load();
  } catch (error) {
    reportApiError(error, '记录处理过程失败');
  } finally {
    resolving[row.id] = false;
  }
}

onMounted(async () => {
  await loadActivities();
  await load();
});

// 导航栏切换选课活动后先清空旧活动的数据，再重新加载
watch(
  () => activity.selectedId.value,
  (next, previous) => {
    if (next === previous) return;
    openItems.value = [];
    openTotal.value = 0;
    handledItems.value = [];
    handledTotal.value = 0;
    handledPage.value = 1;
    void load();
  },
);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">待处理问题</h1>
        <p class="page__desc">
          这里按“会不会影响下一步”把问题分成三组：必须解决的问题不处理就不能发布选课结果；需要关注的问题不阻塞流程，但要评估业务影响。
        </p>
      </div>
      <div class="inline">
        <span class="muted small">当前选课活动：{{ currentActivity ? currentActivity.name : '未选择' }}</span>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="reloadAll">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 读取失败：只显示错误与重试，不显示任何当成 0 的统计 -->
    <div v-if="loadError" class="alert alert--error">
      <div class="inline">
        <span>读取失败：{{ loadError }}</span>
        <span class="spacer"></span>
        <button class="btn btn--ghost btn--sm" type="button" @click="reloadAll">重试</button>
      </div>
    </div>

    <section v-else-if="!loadedOnce" class="card">
      <div class="empty">正在读取…</div>
    </section>

    <template v-else-if="currentActivity">
      <div class="alert alert--warning">
        <strong>请注意：</strong>填写处理说明只记录处理过程，<strong>不会改变名额或课表</strong>。系统会按真实条件重新检查，条件仍然不满足时，问题会继续出现；要真正解决，请先到对应页面调整教学班、保护名单或重新生成分配方案。
      </div>

      <section class="grid grid--3">
        <div class="stat">
          <div class="stat__label">必须解决，才能继续</div>
          <div class="stat__value">{{ counts.blocking }}</div>
          <div class="stat__extra">不处理无法发布选课结果</div>
        </div>
        <div class="stat">
          <div class="stat__label">可以继续，但需关注</div>
          <div class="stat__value">{{ counts.attention }}</div>
          <div class="stat__extra">不阻塞流程，请评估业务影响</div>
        </div>
        <div class="stat">
          <div class="stat__label">已处理</div>
          <div class="stat__value">{{ counts.handled }}</div>
          <div class="stat__extra">只记录处理过程，条件不满足时问题会再次出现</div>
        </div>
      </section>

      <div v-if="truncated" class="alert alert--warning">
        待处理问题较多，当前只列出最近 200 条（共 {{ openTotal }} 条）。请先处理最紧急的问题，刷新后继续。
      </div>

      <!-- ① 必须解决 -->
      <section class="card">
        <div class="card__header">
          <h3 class="card__title">必须解决，才能继续（{{ blockingItems.length }}）</h3>
          <span class="muted small">这些问题不处理，无法发布选课结果</span>
        </div>
        <div v-if="blockingItems.length === 0" class="empty">没有必须解决的阻塞问题。</div>
        <div v-else class="stack">
          <article v-for="row in blockingItems" :key="row.id" class="todo todo--critical">
            <div class="inline">
              <span class="todo__title">{{ metaOf(row.kind).label }}</span>
              <span class="badge badge--danger">必须解决</span>
              <span v-if="!metaOf(row.kind).known" class="badge badge--muted">类型未识别</span>
              <span class="spacer"></span>
              <button class="btn btn--primary btn--sm" type="button" @click="router.push({ name: metaOf(row.kind).fix })">
                {{ metaOf(row.kind).fixLabel }}
              </button>
            </div>
            <div class="todo__detail">{{ subjectOf(row) }}</div>
            <ul class="todo__items">
              <li>{{ metaOf(row.kind).blocks }}</li>
              <li>业务影响：{{ metaOf(row.kind).impact }}</li>
              <li>建议：{{ metaOf(row.kind).suggestion }}</li>
            </ul>

            <details style="margin-top: 6px">
              <summary class="small muted">显示详细信息</summary>
              <div class="small muted" style="margin-top: 4px">
                <div>问题类型：{{ metaOf(row.kind).known ? metaOf(row.kind).label : '类型未识别' }}</div>
                <div>问题类型代码：<span class="mono">{{ row.kind }}</span></div>
                <div>记录编号：<span class="mono">{{ row.id }}</span></div>
                <div>发生时间：{{ formatDateTime(row.createdAt) }}</div>
                <div v-if="row.batchId !== null">所属选课活动编号：<span class="mono">{{ row.batchId }}</span></div>
                <div v-if="row.detail !== null">
                  原始详细信息：
                  <pre class="mono small" style="white-space: pre-wrap; margin: 4px 0 0">{{ detailText(row) }}</pre>
                </div>
              </div>
            </details>

            <div class="inline" style="margin-top: 8px">
              <label class="field" style="margin-bottom: 0; flex: 1; min-width: 240px">
                <span class="field__label">处理说明（必填）</span>
                <input
                  v-model="resolutionText[row.id]"
                  class="input"
                  type="text"
                  placeholder="例如：已协调学生改选另一教学班，并确认不再冲突"
                />
              </label>
              <button class="btn btn--primary btn--sm" type="button" :disabled="resolving[row.id]" @click="resolve(row)">
                {{ resolving[row.id] ? '记录中…' : '填写处理说明并标记已处理' }}
              </button>
            </div>
          </article>
        </div>
      </section>

      <!-- ② 可以继续，但需关注 -->
      <section class="card card--flat">
        <div class="card__header">
          <h3 class="card__title">可以继续，但需关注（{{ attentionItems.length }}）</h3>
          <span class="muted small">不阻塞发布选课结果，但需要确认业务影响</span>
        </div>
        <div v-if="attentionItems.length === 0" class="empty">没有需要关注的问题。</div>
        <div v-else class="stack">
          <article v-for="row in attentionItems" :key="row.id" class="todo">
            <div class="inline">
              <span class="todo__title">{{ metaOf(row.kind).label }}</span>
              <span class="badge badge--warn">需要关注</span>
              <span class="badge" :class="row.severity === 'warning' ? 'badge--warn' : 'badge--muted'">
                {{ severityLabel(row.severity) }}
              </span>
              <span v-if="!metaOf(row.kind).known" class="badge badge--muted">类型未识别</span>
              <span class="spacer"></span>
              <button class="btn btn--ghost btn--sm" type="button" @click="router.push({ name: metaOf(row.kind).fix })">
                {{ metaOf(row.kind).fixLabel }}
              </button>
            </div>
            <div class="todo__detail">{{ subjectOf(row) }}</div>
            <ul class="todo__items">
              <li>业务影响：{{ metaOf(row.kind).impact }}</li>
              <li>建议：{{ metaOf(row.kind).suggestion }}</li>
            </ul>

            <details style="margin-top: 6px">
              <summary class="small muted">显示详细信息</summary>
              <div class="small muted" style="margin-top: 4px">
                <div>问题类型代码：<span class="mono">{{ row.kind }}</span></div>
                <div>记录编号：<span class="mono">{{ row.id }}</span></div>
                <div>发生时间：{{ formatDateTime(row.createdAt) }}</div>
                <div v-if="row.batchId !== null">所属选课活动编号：<span class="mono">{{ row.batchId }}</span></div>
                <div v-if="row.detail !== null">
                  原始详细信息：
                  <pre class="mono small" style="white-space: pre-wrap; margin: 4px 0 0">{{ detailText(row) }}</pre>
                </div>
              </div>
            </details>

            <div class="inline" style="margin-top: 8px">
              <label class="field" style="margin-bottom: 0; flex: 1; min-width: 240px">
                <span class="field__label">处理说明（必填）</span>
                <input
                  v-model="resolutionText[row.id]"
                  class="input"
                  type="text"
                  placeholder="例如：已提醒学生提交志愿，并记录沟通结果"
                />
              </label>
              <button class="btn btn--ghost btn--sm" type="button" :disabled="resolving[row.id]" @click="resolve(row)">
                {{ resolving[row.id] ? '记录中…' : '填写处理说明并标记已处理' }}
              </button>
            </div>
          </article>
        </div>
      </section>

      <!-- ③ 已处理：默认收起 -->
      <section class="card">
        <details>
          <summary class="card__header" style="cursor: pointer">
            <h3 class="card__title">已处理（{{ handledTotal }}）</h3>
            <span class="muted small">默认收起，点击展开查看处理说明、处理人与处理时间</span>
          </summary>
          <div v-if="handledItems.length === 0" class="empty">还没有已处理的问题。</div>
          <template v-else>
            <div class="list">
              <div v-for="row in handledPageItems" :key="row.id" class="list__item">
                <div class="inline">
                  <strong>{{ metaOf(row.kind).label }}</strong>
                  <span class="badge badge--ok">{{ row.status === 'ignored' ? '已忽略' : '已处理' }}</span>
                  <span class="muted small">{{ subjectOf(row) }}</span>
                </div>
                <div class="small" style="margin-top: 4px">处理说明：{{ row.resolution ?? '—' }}</div>
                <div class="muted small">处理人：{{ resolverOf(row) }} · 处理时间：{{ formatDateTime(row.resolvedAt) }}</div>

                <details style="margin-top: 6px">
                  <summary class="small muted">显示详细信息</summary>
                  <div class="small muted" style="margin-top: 4px">
                    <div>问题类型：{{ metaOf(row.kind).known ? metaOf(row.kind).label : '类型未识别' }}</div>
                    <div>问题类型代码：<span class="mono">{{ row.kind }}</span></div>
                    <div>记录编号：<span class="mono">{{ row.id }}</span></div>
                    <div>发生时间：{{ formatDateTime(row.createdAt) }}</div>
                    <div v-if="row.batchId !== null">所属选课活动编号：<span class="mono">{{ row.batchId }}</span></div>
                    <div v-if="row.detail !== null">
                      原始详细信息：
                      <pre class="mono small" style="white-space: pre-wrap; margin: 4px 0 0">{{ detailText(row) }}</pre>
                    </div>
                  </div>
                </details>
              </div>
            </div>
            <Pager
              v-if="handledItems.length > handledPageSize"
              :page="handledPage"
              :page-size="handledPageSize"
              :total="handledItems.length"
              :disabled="loading"
              @change="changeHandledPage"
            />
          </template>
        </details>
      </section>
    </template>

    <section v-else class="card">
      <h3 class="card__title">还没有可处理的选课活动</h3>
      <p class="muted">问题按当前选课活动展示。请先在工作台创建或选择一个选课活动。</p>
      <div v-if="activity.state.error" class="alert alert--error" style="margin-top: 8px">
        <div class="inline">
          <span>读取选课活动失败：{{ activity.state.error }}</span>
          <span class="spacer"></span>
          <button class="btn btn--ghost btn--sm" type="button" @click="reloadAll">重试</button>
        </div>
      </div>
      <div class="inline" style="margin-top: 10px">
        <button class="btn btn--primary" type="button" @click="router.push({ name: 'admin-workspace' })">去工作台</button>
      </div>
    </section>
  </div>
</template>
