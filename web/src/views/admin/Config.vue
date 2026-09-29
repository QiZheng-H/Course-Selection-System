<script setup lang="ts">
/**
 * 基础配置。
 *
 * 只展示管理员真正需要理解的项；技术字段名放在“详细信息”里，
 * 保存普通配置不做反复确认。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { useToast } from '@/stores/toast';
import { formatDateTime } from '@/utils/labels';

interface ConfigRow {
  key: string;
  value: string;
  valueType: string;
  description: string | null;
  updatedAt: string;
}

const toast = useToast();
const loading = ref(true);
const loadError = ref('');
const saving = ref(false);
const configs = ref<ConfigRow[]>([]);
const issues = ref<string[]>([]);
const configReady = ref(true);
const showTechnical = ref(false);

/** 面向业务的配置项说明与分组 */
const CONFIG_META: Record<string, { label: string; help: string; group: string }> = {
  credit_limit_default: {
    label: '每学期学分上限',
    help: '学生一学期最多可选多少学分。缺失时不能开放预选。',
    group: '选课规则',
  },
  planning_timeout_ms: {
    label: '后台计算时间上限（毫秒）',
    help: '生成分配方案单次计算允许的最长时间；超时不发布任何部分结果。',
    group: '选课规则',
  },
  public_supplement_enabled: {
    label: '允许公开补选',
    help: '在退改选阶段，没有合格候补但仍有名额时，允许学生直接补选。',
    group: '选课规则',
  },
  class_swap_enabled: {
    label: '允许同课换班',
    help: '允许学生在同一门课的不同教学班之间换班。',
    group: '选课规则',
  },
  agent_online_enabled: {
    label: '启用在线模型',
    help: '关闭时使用离线规则引擎，不访问任何网络服务。',
    group: '辅助规划',
  },
  current_term: {
    label: '当前学期',
    help: '教学班与“本学期开课”以此为准。修改前请确认教学班资料已经就绪。',
    group: '学期与资料',
  },
  demo_data_notice: {
    label: '演示数据说明',
    help: '展示给学生与管理员的数据来源说明。',
    group: '学期与资料',
  },
};

const form = reactive<Record<string, string>>({});
const groups = computed(() => {
  const map = new Map<string, ConfigRow[]>();
  for (const row of configs.value) {
    const group = CONFIG_META[row.key]?.group ?? '其它配置';
    map.set(group, [...(map.get(group) ?? []), row]);
  }
  return Array.from(map.entries());
});

function labelOf(key: string): string {
  return CONFIG_META[key]?.label ?? key;
}

function helpOf(row: ConfigRow): string {
  return CONFIG_META[row.key]?.help ?? row.description ?? '';
}

function isBoolean(row: ConfigRow): boolean {
  return row.valueType === 'boolean' || row.value === 'true' || row.value === 'false';
}

function isNumber(row: ConfigRow): boolean {
  return row.valueType === 'number';
}

function dirty(row: ConfigRow): boolean {
  return form[row.key] !== row.value;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const data = await api.get<{ configs: ConfigRow[]; configReady: boolean; issues: string[] }>('/admin/configs');
    configs.value = data.configs;
    configReady.value = data.configReady;
    issues.value = data.issues;
    for (const row of data.configs) form[row.key] = row.value;
  } catch (error) {
    loadError.value = apiErrorInfo(error, '读取失败').message;
  } finally {
    loading.value = false;
  }
}

async function save(row: ConfigRow): Promise<void> {
  saving.value = true;
  try {
    await api.put('/admin/configs', {
      configs: [{ key: row.key, value: form[row.key], valueType: row.valueType, description: row.description }],
    });
    toast.success(`${labelOf(row.key)}已保存`, ['新的设置会立即对学生生效。']);
    await load();
  } catch (error) {
    const info = apiErrorInfo(error, '保存失败');
    toast.error(info.title, [info.message, ...info.lines]);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">基础配置</h1>
        <p class="page__desc">影响选课规则与开放条件的设置。保存后立即生效。</p>
      </div>
      <div class="inline">
        <button class="btn btn--ghost btn--sm" type="button" @click="showTechnical = !showTechnical">
          {{ showTechnical ? '隐藏详细信息' : '显示详细信息' }}
        </button>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <p v-if="loadError" class="alert alert--error">
      <strong>读取失败</strong>：{{ loadError }}
      <button class="btn btn--primary btn--sm" type="button" style="margin-left: 8px" @click="load">重试</button>
    </p>

    <p v-else-if="!configReady" class="alert alert--warning">
      <strong>必需配置尚未齐全，不能开放预选：</strong>{{ issues.join('；') }}
    </p>

    <section v-for="[group, rows] in groups" :key="group" class="card">
      <div class="card__header">
        <h3 class="card__title">{{ group }}</h3>
      </div>
      <div class="list">
        <div v-for="row in rows" :key="row.key" class="list__item">
          <div class="inline">
            <div>
              <strong>{{ labelOf(row.key) }}</strong>
              <div class="small muted">{{ helpOf(row) }}</div>
            </div>
            <span class="spacer"></span>
            <select v-if="isBoolean(row)" v-model="form[row.key]" class="select">
              <option value="true">允许</option>
              <option value="false">不允许</option>
            </select>
            <input
              v-else-if="isNumber(row)"
              v-model="form[row.key]"
              class="input input--sm"
              type="number"
              style="width: 140px"
            />
            <input v-else v-model="form[row.key]" class="input" type="text" style="max-width: 420px" />
            <button class="btn btn--primary btn--sm" type="button" :disabled="saving || !dirty(row)" @click="save(row)">
              {{ saving && dirty(row) ? '保存中…' : '保存' }}
            </button>
          </div>
          <div v-if="showTechnical" class="small muted" style="margin-top: 4px">
            字段：<span class="mono">{{ row.key }}</span> · 类型 {{ row.valueType }} · 最近更新 {{ formatDateTime(row.updatedAt) }}
          </div>
        </div>
      </div>
    </section>

    <div v-if="!loading && configs.length === 0 && !loadError" class="empty">还没有可配置项。</div>
  </div>
</template>
