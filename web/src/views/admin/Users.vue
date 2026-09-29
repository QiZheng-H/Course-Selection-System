<script setup lang="ts">
/**
 * 学生账号：面向业务管理员的“学生查询 + 账号导入”页面。
 * 只调用已有的账号接口，所有业务判断（是否能停用、密码是否合规）仍由后端最终裁定。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { apiErrorInfo } from '@/api/errors';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type { Role, UserImportResult, UserRow } from '@/api/types';
import { formatDateTime } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

/* ------------------------------- 页内类型 ------------------------------- */

type TabKey = 'search' | 'import';

/** 从文件或文本框解析出的一行学生信息 */
interface ParsedStudentRow {
  /** 名单中的行号（从 1 开始，含表头行） */
  line: number;
  studentNo: string;
  name: string;
  grade: string | null;
  major: string | null;
  /** 该行自带的初始密码；为空表示使用页面上填写的默认初始密码 */
  password: string;
  errors: string[];
}

interface ImportProblem {
  row: number;
  reason: string;
}

interface ImportFailure {
  /** 出问题的起始行号 */
  row: number;
  /** 受影响的学生数量 */
  count: number;
  reason: string;
}

interface ImportOutcome {
  attempted: number;
  created: number;
  updated: number;
  skipped: ImportProblem[];
  failed: ImportFailure[];
  finishedAt: string;
}

/* ------------------------------- 公共状态 ------------------------------- */

const toast = useToast();
const tab = ref<TabKey>('search');

const PREVIEW_LIMIT = 20;
const DEFAULT_IMPORT_PASSWORD = '123456';
const CSV_HEADER = '学号,姓名,年级,专业,初始密码';
const CSV_SAMPLE = ['20249001,张三,2024,计算机科学与技术,123456', '20249002,李四,2024,软件工程,123456'].join('\n');

/* ------------------------------- 学生查询 ------------------------------- */

const users = ref<UserRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const roleFilter = ref('');
const keyword = ref('');
const loading = ref(false);
const loadError = ref('');
const expandedId = ref<number | null>(null);

const resetTarget = ref<UserRow | null>(null);
const resetPassword = ref('');
const resetting = ref(false);
const resetOutcome = ref<{ ok: boolean; message: string } | null>(null);

const statusChanging = ref<number | null>(null);

function accountLabel(row: UserRow): string {
  return row.studentNo || row.username;
}

function roleLabel(role: Role): string {
  return role === 'admin' ? '管理员' : '学生';
}

async function loadUsers(targetPage = page.value): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const data = await api.get<{ items: UserRow[]; total: number }>('/admin/users', {
      role: roleFilter.value || undefined,
      keyword: keyword.value.trim() || undefined,
      page: targetPage,
      pageSize,
    });
    users.value = data.items;
    total.value = data.total;
    page.value = targetPage;
    if (expandedId.value !== null && !data.items.some((item) => item.id === expandedId.value)) {
      expandedId.value = null;
    }
  } catch (error) {
    // 读取失败时清空列表，绝不把未取得的数据显示成 0
    users.value = [];
    total.value = 0;
    expandedId.value = null;
    loadError.value = apiErrorInfo(error, '读取失败').message;
  } finally {
    loading.value = false;
  }
}

function search(): void {
  expandedId.value = null;
  void loadUsers(1);
}

function resetSearch(): void {
  keyword.value = '';
  roleFilter.value = '';
  search();
}

function toggleDetails(row: UserRow): void {
  expandedId.value = expandedId.value === row.id ? null : row.id;
}

/** 停用 / 启用账号：普通操作，不做二次确认 */
async function changeStatus(row: UserRow): Promise<void> {
  const next = row.status === 'active' ? 'disabled' : 'active';
  statusChanging.value = row.id;
  try {
    await api.patch(`/admin/users/${row.id}/status`, { status: next });
    if (next === 'disabled') {
      toast.success('账号已停用', [`${accountLabel(row)} 已无法登录，原有登录状态已失效`]);
    } else {
      toast.success('账号已启用', [`${accountLabel(row)} 已可以重新登录`]);
    }
    await loadUsers();
  } catch (error) {
    reportApiError(error, next === 'disabled' ? '停用账号失败' : '启用账号失败');
  } finally {
    statusChanging.value = null;
  }
}

function openReset(row: UserRow): void {
  resetTarget.value = row;
  resetPassword.value = '';
  resetOutcome.value = null;
}

function closeReset(): void {
  resetTarget.value = null;
  resetPassword.value = '';
  resetOutcome.value = null;
}

/** 重置密码：普通操作，不做二次确认，但成功 / 失败都给出明确结果 */
async function submitReset(): Promise<void> {
  const target = resetTarget.value;
  if (!target) return;
  if (resetPassword.value.length < 6) {
    resetOutcome.value = { ok: false, message: '新密码至少 6 位，请重新输入。' };
    toast.warning('新密码至少 6 位');
    return;
  }
  resetting.value = true;
  resetOutcome.value = null;
  try {
    await api.post(`/admin/users/${target.id}/password`, { password: resetPassword.value });
    resetOutcome.value = {
      ok: true,
      message: `已重置「${target.displayName}（${accountLabel(target)}）」的密码。该账号原有登录状态已失效，需要用新密码重新登录。`,
    };
    resetPassword.value = '';
    toast.success('密码已重置');
  } catch (error) {
    resetOutcome.value = { ok: false, message: apiErrorInfo(error, '重置密码失败').message };
    reportApiError(error, '重置密码失败');
  } finally {
    resetting.value = false;
  }
}

/* ------------------------------- 账号导入 ------------------------------- */

const importText = ref('');
const importFileName = ref('');
const importPassword = ref(DEFAULT_IMPORT_PASSWORD);
const importing = ref(false);
const importOutcome = ref<ImportOutcome | null>(null);

/** 按逗号（中英文）、制表符切分一行，兼容双引号包裹的字段 */
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',' || char === '，' || char === '\t') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isHeaderRow(cells: string[]): boolean {
  const first = (cells[0] ?? '').replace(/^\uFEFF/, '').trim();
  return first.includes('学号');
}

function problemKind(error: string): string {
  return error.startsWith('学号重复') ? '学号重复' : error;
}

/** 把纯文本名单解析成学生记录并逐行校验（不调用后端） */
function parseStudentRows(text: string): ParsedStudentRow[] {
  const rows: ParsedStudentRow[] = [];
  const firstSeen = new Map<string, number>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const cells = splitCells(line);
    if (rows.length === 0 && isHeaderRow(cells)) return;

    const studentNo = (cells[0] ?? '').trim();
    const name = (cells[1] ?? '').trim();
    const grade = (cells[2] ?? '').trim();
    const major = (cells[3] ?? '').trim();
    const password = (cells[4] ?? '').trim();
    const lineNo = index + 1;

    const errors: string[] = [];
    if (!studentNo) errors.push('学号为空');
    if (!name) errors.push('缺少姓名');
    if (password && password.length < 6) errors.push('初始密码不足 6 位');
    if (studentNo) {
      const seenAt = firstSeen.get(studentNo);
      if (seenAt !== undefined) {
        errors.push(`学号重复（第 ${seenAt} 行已出现）`);
      } else {
        firstSeen.set(studentNo, lineNo);
      }
    }

    rows.push({
      line: lineNo,
      studentNo,
      name,
      grade: grade || null,
      major: major || null,
      password,
      errors,
    });
  });
  return rows;
}

const parsedRows = computed(() => parseStudentRows(importText.value));
const importableRows = computed(() => parsedRows.value.filter((row) => row.errors.length === 0));
const problemRows = computed(() => parsedRows.value.filter((row) => row.errors.length > 0));
const previewRows = computed(() => parsedRows.value.slice(0, PREVIEW_LIMIT));
const previewHidden = computed(() => Math.max(0, parsedRows.value.length - PREVIEW_LIMIT));

const problemSummary = computed(() => {
  const counts = new Map<string, number>();
  for (const row of problemRows.value) {
    for (const error of row.errors) {
      const kind = problemKind(error);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([reason, count]) => ({ reason, count }));
});

function failedAccountCount(outcome: ImportOutcome): number {
  return outcome.failed.reduce((sum, item) => sum + item.count, 0);
}

/** 纯前端生成 CSV 模板（含 BOM，方便 Excel 直接打开中文） */
function downloadTemplate(): void {
  const content = `\uFEFF${CSV_HEADER}\n${CSV_SAMPLE}\n`;
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '学生账号导入模板.csv';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    importText.value = text;
    importFileName.value = file.name;
    importOutcome.value = null;
    toast.success('已读取文件', [`${file.name}，解析到 ${parseStudentRows(text).length} 条记录`]);
  } catch {
    toast.error('读取文件失败', ['请确认文件是 CSV 或 TXT 文本文件后重试']);
  } finally {
    input.value = '';
  }
}

function clearImport(): void {
  importText.value = '';
  importFileName.value = '';
  importOutcome.value = null;
}

async function submitImport(): Promise<void> {
  const rows = importableRows.value;
  if (parsedRows.value.length === 0) {
    toast.warning('请先上传文件或粘贴学生名单');
    return;
  }
  if (rows.length === 0) {
    toast.warning('没有可导入的记录', ['请先按预览中的校验提示修正名单']);
    return;
  }
  if (rows.some((row) => !row.password)) {
    if (!importPassword.value) {
      toast.warning('请填写初始密码', ['名单中部分记录没有填写初始密码']);
      return;
    }
    if (importPassword.value.length < 6) {
      toast.warning('初始密码至少 6 位');
      return;
    }
  }

  // 后端按“一个默认口令对应一批”导入；名单自带不同初始密码时按密码分组提交
  const groups = new Map<string, ParsedStudentRow[]>();
  for (const row of rows) {
    const password = row.password || importPassword.value;
    const bucket = groups.get(password);
    if (bucket) bucket.push(row);
    else groups.set(password, [row]);
  }

  const passwordText =
    groups.size === 1
      ? `初始密码：${Array.from(groups.keys())[0]}`
      : `初始密码：按名单中的“初始密码”列分别设置（共 ${groups.size} 种），未填写的使用 ${importPassword.value}`;

  const ok = await askConfirm({
    title: '确认导入学生账号',
    message: `将为 ${rows.length} 名学生创建或更新账号：新学号会新建学生账号，已存在的学号会更新姓名、年级、专业，不会改动已有密码。`,
    details: [`本次新增 / 更新 ${rows.length} 个学生账号`, passwordText, '学生首次登录后应尽快修改初始密码'],
    confirmText: '确认导入',
    danger: false,
  });
  if (!ok) return;

  importing.value = true;
  const outcome: ImportOutcome = {
    attempted: rows.length,
    created: 0,
    updated: 0,
    skipped: [],
    failed: [],
    finishedAt: new Date().toISOString(),
  };
  try {
    for (const [password, bucket] of groups) {
      try {
        const result = await api.post<UserImportResult>('/admin/users/import', {
          rows: bucket.map((row) => ({
            studentNo: row.studentNo,
            name: row.name,
            grade: row.grade,
            major: row.major,
          })),
          defaultPassword: password,
        });
        outcome.created += result.created;
        outcome.updated += result.updated;
        for (const issue of result.skipped) {
          const source = bucket[issue.row - 1];
          outcome.skipped.push({ row: source ? source.line : issue.row, reason: issue.reason });
        }
      } catch (error) {
        outcome.failed.push({
          row: bucket[0] ? bucket[0].line : 0,
          count: bucket.length,
          reason: apiErrorInfo(error, '导入失败').message,
        });
      }
    }
    outcome.finishedAt = new Date().toISOString();
    importOutcome.value = outcome;
    if (outcome.failed.length === 0) {
      toast.success('导入完成', [`新增 ${outcome.created}，更新 ${outcome.updated}，跳过 ${outcome.skipped.length}`]);
    } else {
      toast.warning('部分名单未导入', [
        `新增 ${outcome.created}，更新 ${outcome.updated}，未导入 ${failedAccountCount(outcome)} 个账号`,
      ]);
    }
    await loadUsers(1);
  } finally {
    importing.value = false;
  }
}

onMounted(() => {
  void loadUsers(1);
});
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">学生账号</h1>
        <p class="page__desc">按学号查询学生账号、重置密码、停用或启用账号；也可以批量新建学生账号。</p>
      </div>
      <div class="inline">
        <button
          class="btn btn--sm"
          :class="tab === 'search' ? 'btn--primary' : 'btn--ghost'"
          type="button"
          @click="tab = 'search'"
        >
          学生查询
        </button>
        <button
          class="btn btn--sm"
          :class="tab === 'import' ? 'btn--primary' : 'btn--ghost'"
          type="button"
          @click="tab = 'import'"
        >
          账号导入
        </button>
      </div>
    </div>

    <!-- ============================ 学生查询 ============================ -->
    <template v-if="tab === 'search'">
      <section class="card">
        <div class="card__header">
          <h3 class="card__title">查询条件</h3>
          <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="loadUsers(page)">刷新</button>
        </div>
        <div class="grid grid--3">
          <label class="field">
            <span class="small muted">学号 / 姓名 / 用户名</span>
            <input
              v-model="keyword"
              class="input"
              type="text"
              placeholder="输入关键词后回车查询"
              @keyup.enter="search"
            />
          </label>
          <label class="field">
            <span class="small muted">角色</span>
            <select v-model="roleFilter" class="select" @change="search">
              <option value="">全部角色</option>
              <option value="student">学生</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          <div class="field">
            <span class="small muted">操作</span>
            <div class="inline">
              <button class="btn btn--primary" type="button" :disabled="loading" @click="search">查询</button>
              <button class="btn btn--ghost" type="button" :disabled="loading" @click="resetSearch">重置条件</button>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card__header">
          <h3 class="card__title">查询结果</h3>
          <span v-if="!loadError" class="small muted">共 {{ total }} 个账号</span>
        </div>

        <div v-if="loadError" class="alert alert--error">
          <strong>读取失败</strong>
          <div>{{ loadError }}</div>
          <button class="btn btn--primary btn--sm" type="button" style="margin-top: 8px" @click="loadUsers(page)">
            重试
          </button>
        </div>

        <template v-else>
          <div v-if="loading" class="empty">正在读取…</div>
          <div v-else-if="users.length === 0" class="empty">没有符合条件的学生账号。</div>
          <div v-else class="table-wrap">
            <table class="table table--compact">
              <thead>
                <tr>
                  <th>学号</th>
                  <th>姓名</th>
                  <th>角色</th>
                  <th>年级</th>
                  <th>专业</th>
                  <th>账号状态</th>
                  <th>最近登录</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="row in users" :key="row.id">
                  <tr>
                    <td class="mono">{{ accountLabel(row) }}</td>
                    <td>{{ row.displayName }}</td>
                    <td>
                      <span class="badge" :class="row.role === 'admin' ? 'badge--warn' : 'badge--muted'">
                        {{ roleLabel(row.role) }}
                      </span>
                    </td>
                    <td class="small muted">{{ row.grade || '—' }}</td>
                    <td class="small muted">{{ row.major || '—' }}</td>
                    <td>
                      <span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--danger'">
                        {{ row.status === 'active' ? '正常' : '已停用' }}
                      </span>
                    </td>
                    <td class="small muted">{{ formatDateTime(row.lastLoginAt) }}</td>
                    <td>
                      <div class="inline">
                        <button class="btn btn--sm btn--ghost" type="button" @click="openReset(row)">重置密码</button>
                        <button
                          class="btn btn--sm btn--ghost"
                          type="button"
                          :disabled="statusChanging === row.id"
                          @click="changeStatus(row)"
                        >
                          {{ statusChanging === row.id ? '处理中…' : row.status === 'active' ? '停用账号' : '启用账号' }}
                        </button>
                        <button class="btn btn--sm btn--ghost" type="button" @click="toggleDetails(row)">
                          {{ expandedId === row.id ? '收起详细信息' : '显示详细信息' }}
                        </button>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="expandedId === row.id">
                    <td colspan="8">
                      <div class="grid grid--4">
                        <div>
                          <div class="small muted">登录用户名</div>
                          <div class="mono">{{ row.username }}</div>
                        </div>
                        <div>
                          <div class="small muted">角色</div>
                          <div>{{ roleLabel(row.role) }}</div>
                        </div>
                        <div>
                          <div class="small muted">账号创建时间</div>
                          <div class="small">{{ formatDateTime(row.createdAt) }}</div>
                        </div>
                        <div>
                          <div class="small muted">账号编号（内部使用）</div>
                          <div class="mono">{{ row.id }}</div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <Pager
            v-if="total > 0"
            :page="page"
            :page-size="pageSize"
            :total="total"
            :disabled="loading"
            @change="loadUsers"
          />
        </template>
      </section>

      <section v-if="resetTarget" class="card card--flat">
        <div class="card__header">
          <h3 class="card__title">重置密码：{{ resetTarget.displayName }}（{{ accountLabel(resetTarget) }}）</h3>
          <button class="btn btn--ghost btn--sm" type="button" @click="closeReset">关闭</button>
        </div>
        <p class="tips">新密码至少 6 位。重置后该账号当前的登录状态会失效，需要用新密码重新登录。</p>
        <div v-if="resetOutcome" class="alert" :class="resetOutcome.ok ? '' : 'alert--error'">
          <span class="badge" :class="resetOutcome.ok ? 'badge--ok' : 'badge--danger'">
            {{ resetOutcome.ok ? '重置成功' : '重置失败' }}
          </span>
          <div style="margin-top: 6px">{{ resetOutcome.message }}</div>
        </div>
        <div class="inline" style="margin-top: 10px">
          <input
            v-model="resetPassword"
            class="input"
            type="text"
            placeholder="新密码（至少 6 位）"
            style="max-width: 280px"
            @keyup.enter="submitReset"
          />
          <button class="btn btn--primary" type="button" :disabled="resetting" @click="submitReset">
            {{ resetting ? '重置中…' : '确认重置' }}
          </button>
        </div>
      </section>
    </template>

    <!-- ============================ 账号导入 ============================ -->
    <template v-else>
      <section class="card">
        <div class="card__header">
          <h3 class="card__title">第一步：准备学生名单</h3>
          <button class="btn btn--ghost btn--sm" type="button" @click="downloadTemplate">下载 CSV 模板</button>
        </div>
        <p class="tips">
          每行一名学生，用逗号分隔，顺序为：学号、姓名、年级、专业、初始密码。可以上传 CSV / TXT
          文件，也可以直接粘贴到下面的文本框；初始密码留空表示使用下方填写的初始密码。
        </p>

        <div class="grid grid--2">
          <label class="field">
            <span class="small muted">上传 CSV / TXT 文件</span>
            <input class="input" type="file" accept=".csv,.txt,text/csv,text/plain" @change="onFilePicked" />
            <span v-if="importFileName" class="small muted">已读取文件：{{ importFileName }}</span>
          </label>
          <label class="field">
            <span class="small muted">初始密码（名单中留空时使用，至少 6 位）</span>
            <input v-model="importPassword" class="input" type="text" placeholder="默认 123456" />
          </label>
        </div>

        <label class="field">
          <span class="small muted">或直接粘贴名单（每行一条，逗号分隔）</span>
          <textarea
            v-model="importText"
            class="input"
            rows="8"
            placeholder="20249001,张三,2024,计算机科学与技术,123456"
          ></textarea>
        </label>

        <div class="inline">
          <button class="btn btn--ghost btn--sm" type="button" :disabled="importText.length === 0" @click="clearImport">
            清空名单
          </button>
          <span class="spacer"></span>
          <span class="small muted">
            共 {{ parsedRows.length }} 条，可导入 {{ importableRows.length }} 条，有问题 {{ problemRows.length }} 条
          </span>
        </div>
      </section>

      <section v-if="parsedRows.length > 0" class="card">
        <div class="card__header">
          <h3 class="card__title">第二步：核对预览与校验</h3>
          <span class="small muted">下方最多显示前 {{ PREVIEW_LIMIT }} 条</span>
        </div>
        <div class="inline">
          <span class="badge badge--ok">可导入 {{ importableRows.length }}</span>
          <span class="badge" :class="problemRows.length > 0 ? 'badge--danger' : 'badge--muted'">
            有问题 {{ problemRows.length }}
          </span>
          <span v-if="previewHidden > 0" class="small muted">另有 {{ previewHidden }} 条未在下方显示</span>
        </div>

        <div v-if="problemSummary.length > 0" class="alert alert--warning" style="margin-top: 10px">
          <strong>有以下问题的记录不会被导入，请先修正</strong>
          <ul class="tips">
            <li v-for="item in problemSummary" :key="item.reason">{{ item.reason }}：{{ item.count }} 条</li>
          </ul>
        </div>

        <div class="table-wrap" style="margin-top: 10px">
          <table class="table table--compact">
            <thead>
              <tr>
                <th>行号</th>
                <th>学号</th>
                <th>姓名</th>
                <th>年级</th>
                <th>专业</th>
                <th>初始密码</th>
                <th>校验结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in previewRows" :key="row.line">
                <td class="small muted">{{ row.line }}</td>
                <td class="mono">{{ row.studentNo || '—' }}</td>
                <td>{{ row.name || '—' }}</td>
                <td class="small muted">{{ row.grade || '—' }}</td>
                <td class="small muted">{{ row.major || '—' }}</td>
                <td class="mono small">{{ row.password || importPassword || '—' }}</td>
                <td>
                  <span v-if="row.errors.length === 0" class="badge badge--ok">可导入</span>
                  <span v-else class="badge badge--danger">{{ row.errors.join('；') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <div class="card__header">
          <h3 class="card__title">第三步：确认导入</h3>
        </div>
        <p class="tips">
          导入时按学号创建学生账号；已存在的学号会更新姓名、年级、专业，不会改动该账号现有密码。学生首次登录后应尽快修改初始密码。
        </p>
        <div class="inline">
          <button
            class="btn btn--primary"
            type="button"
            :disabled="importing || importableRows.length === 0"
            @click="submitImport"
          >
            {{ importing ? '导入中…' : `确认导入（${importableRows.length} 条）` }}
          </button>
          <span v-if="importableRows.length === 0" class="small muted">当前没有可导入的记录。</span>
        </div>

        <div
          v-if="importOutcome"
          class="alert"
          :class="importOutcome.failed.length > 0 || importOutcome.skipped.length > 0 ? 'alert--warning' : ''"
          style="margin-top: 10px"
        >
          <strong>上次导入结果（{{ formatDateTime(importOutcome.finishedAt) }}）</strong>
          <div class="inline" style="margin-top: 6px">
            <span class="badge badge--ok">新增 {{ importOutcome.created }}</span>
            <span class="badge badge--muted">更新 {{ importOutcome.updated }}</span>
            <span class="badge" :class="importOutcome.skipped.length > 0 ? 'badge--warn' : 'badge--muted'">
              跳过 {{ importOutcome.skipped.length }}
            </span>
            <span class="badge" :class="importOutcome.failed.length > 0 ? 'badge--danger' : 'badge--muted'">
              失败 {{ failedAccountCount(importOutcome) }}
            </span>
          </div>
          <div v-if="importOutcome.skipped.length > 0" class="small" style="margin-top: 6px">
            <div v-for="item in importOutcome.skipped" :key="`skip-${item.row}-${item.reason}`">
              第 {{ item.row }} 行：{{ item.reason }}
            </div>
          </div>
          <div v-if="importOutcome.failed.length > 0" class="small" style="margin-top: 6px">
            <div v-for="item in importOutcome.failed" :key="`fail-${item.row}-${item.reason}`">
              从第 {{ item.row }} 行起的 {{ item.count }} 个账号未导入：{{ item.reason }}
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
