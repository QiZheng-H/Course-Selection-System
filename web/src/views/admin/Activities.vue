<script setup lang="ts">
/**
 * 选课活动管理（内部仍称“批次”）。
 *
 * 这里只负责创建与查看活动，以及把某个活动设为“当前选择”。
 * 阶段推进全部在“选课工作台”里用有明确含义的按钮完成，
 * 因此本页不再提供状态下拉框，也没有“强制执行”。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { reportApiError, useToast } from '@/stores/toast';
import { useActivity, loadActivities, selectActivity } from '@/stores/activity';
import type { BatchDto } from '@/api/types';
import { batchStatusLabel, formatDateTime, toIsoOrNull } from '@/utils/labels';

const toast = useToast();
const router = useRouter();
const activity = useActivity();

const loading = ref(false);
const loadError = ref('');
const creating = ref(false);
const showTechnical = ref(false);
const showCreate = ref(false);

const createForm = reactive({
  term: '',
  name: '',
  creditLimit: 30,
  openAt: '',
  closeAt: '',
  note: '',
});

const batches = computed(() => activity.batches.value);

function defaultTerm(): string {
  const now = new Date();
  const startYear = now.getMonth() + 1 >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${startYear + 1}-1`;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    await loadActivities(true);
  } catch (error) {
    loadError.value = apiErrorInfo(error, '读取失败').message;
  } finally {
    loading.value = false;
  }
}

async function createBatch(): Promise<void> {
  if (!createForm.term.trim() || !createForm.name.trim()) {
    toast.warning('请填写学期与活动名称');
    return;
  }
  creating.value = true;
  try {
    const created = await api.post<BatchDto>('/admin/batches', {
      term: createForm.term.trim(),
      name: createForm.name.trim(),
      creditLimit: createForm.creditLimit,
      openAt: toIsoOrNull(createForm.openAt),
      closeAt: toIsoOrNull(createForm.closeAt),
      note: createForm.note || null,
    });
    toast.success('选课活动已创建', ['现在处于“资料准备”阶段，可以在工作台点“检查并开放预选”。']);
    selectActivity(created.id);
    createForm.name = '';
    createForm.note = '';
    showCreate.value = false;
    await load();
    await router.push({ name: 'admin-workspace' });
  } catch (error) {
    reportApiError(error, '创建选课活动失败');
  } finally {
    creating.value = false;
  }
}

function chooseBatch(batch: BatchDto): void {
  selectActivity(batch.id);
  toast.info(`已切换到「${batch.name}」`, ['所有页面都会使用这个选课活动。']);
  void router.push({ name: 'admin-workspace' });
}

onMounted(() => {
  createForm.term = defaultTerm();
  void load();
});
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">选课活动管理</h1>
        <p class="page__desc">
          每次选课对应一个“选课活动”。阶段推进请在工作台按顺序操作，本页只负责创建与切换活动。
        </p>
      </div>
      <div class="inline">
        <button class="btn btn--primary btn--sm" type="button" @click="showCreate = !showCreate">
          {{ showCreate ? '取消创建' : '创建选课活动' }}
        </button>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <p v-if="loadError" class="alert alert--error">
      <strong>读取失败</strong>：{{ loadError }}
      <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="load">重试</button>
    </p>

    <section v-if="showCreate" class="card">
      <div class="card__header">
        <h3 class="card__title">创建选课活动</h3>
      </div>
      <div class="grid grid--3">
        <label class="field">
          <span class="field__label">学期（例如 2026-2027-1）</span>
          <input v-model="createForm.term" class="input" type="text" />
        </label>
        <label class="field">
          <span class="field__label">活动名称</span>
          <input v-model="createForm.name" class="input" type="text" placeholder="例如 2026-2027 学年第一学期选课" />
        </label>
        <label class="field">
          <span class="field__label">学分上限</span>
          <input v-model.number="createForm.creditLimit" class="input" type="number" min="1" step="1" />
        </label>
        <label class="field">
          <span class="field__label">计划开放时间（可选）</span>
          <input v-model="createForm.openAt" class="input" type="datetime-local" />
        </label>
        <label class="field">
          <span class="field__label">计划截止时间（可选）</span>
          <input v-model="createForm.closeAt" class="input" type="datetime-local" />
        </label>
        <label class="field">
          <span class="field__label">备注（可选）</span>
          <input v-model="createForm.note" class="input" type="text" />
        </label>
      </div>
      <p class="tips">创建后处于“资料准备”阶段，不会立即对学生开放。资料与配置齐全后，在工作台点“检查并开放预选”。</p>
      <button class="btn btn--primary" type="button" :disabled="creating" @click="createBatch">
        {{ creating ? '创建中…' : '创建活动' }}
      </button>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">全部活动（{{ batches.length }}）</h3>
        <button class="btn btn--ghost btn--sm" type="button" @click="showTechnical = !showTechnical">
          {{ showTechnical ? '隐藏详细信息' : '显示详细信息' }}
        </button>
      </div>
      <div v-if="batches.length === 0" class="empty">还没有任何选课活动，先创建一个。</div>
      <div v-else class="list">
        <div v-for="batch in batches" :key="batch.id" class="list__item">
          <div class="inline">
            <strong>{{ batch.name }}</strong>
            <span class="badge badge--muted">{{ batch.term }}</span>
            <span class="badge" :class="batch.status === 'closed' ? 'badge--muted' : 'badge--ok'">
              {{ batchStatusLabel(batch.status) }}
            </span>
            <span v-if="batch.status === 'closed'" class="badge badge--muted">历史</span>
            <span class="badge" :class="batch.configReady ? 'badge--ok' : 'badge--warn'">
              资料{{ batch.configReady ? '齐全' : '不齐全' }}
            </span>
            <span class="spacer"></span>
            <button
              class="btn btn--sm"
              :class="batch.id === activity.selectedId.value ? 'btn--ghost' : 'btn--primary'"
              type="button"
              :disabled="batch.id === activity.selectedId.value"
              @click="chooseBatch(batch)"
            >
              {{ batch.id === activity.selectedId.value ? '当前选择' : '切换到这个活动' }}
            </button>
          </div>
          <div class="small muted">
            开放 {{ formatDateTime(batch.openAt) }} · 截止 {{ formatDateTime(batch.closeAt) }} · 结果发布
            {{ formatDateTime(batch.publishedAt) }} · 结束 {{ formatDateTime(batch.closedAt) }}
          </div>
          <div class="small muted">
            提交：有效 {{ batch.submissions.submitted }} / 撤回 {{ batch.submissions.withdrawn }} / 涉及学生
            {{ batch.submissions.students }}
          </div>
          <p v-if="!batch.configReady" class="alert alert--warning small" style="margin-top: 6px">
            还缺：{{ batch.configIssues.join('；') }}
            <button class="btn btn--ghost btn--sm" type="button" @click="router.push({ name: 'admin-records-config' })">
              去补配置
            </button>
          </p>
          <div v-if="showTechnical" class="small muted">
            内部编号 #{{ batch.id }} · 阶段版本 v{{ batch.stageRevision ?? 1 }} ·
            {{ batch.snapshotHash ? `快照 ${batch.snapshotHash.slice(0, 12)}…` : '尚无快照' }} ·
            重新开放提交 {{ batch.reopenCount ?? 0 }} 次 · 最近调整 {{ formatDateTime(batch.lastReopenedAt) }}
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
