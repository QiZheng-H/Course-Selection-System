<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { askConfirm } from '@/stores/confirm';
import { reportApiError, useToast } from '@/stores/toast';
import type { UserImportResult, UserRow } from '@/api/types';
import { formatDateTime } from '@/utils/labels';
import Pager from '@/components/Pager.vue';

interface ProgramRow {
  id: number;
  code: string;
  name: string;
  grade?: string | null;
  major?: string | null;
}

const toast = useToast();

const users = ref<UserRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const roleFilter = ref('');
const keyword = ref('');
const loading = ref(false);

const programs = ref<ProgramRow[]>([]);

const createForm = reactive({
  username: '',
  password: '',
  displayName: '',
  role: 'student' as 'student' | 'admin',
  studentNo: '',
  grade: '2024',
  major: '计算机科学与技术',
  programId: null as number | null,
});
const creating = ref(false);

const resetTarget = ref<UserRow | null>(null);
const resetPassword = ref('');
const resetting = ref(false);

const statusChanging = ref<number | null>(null);

const importText = ref('20249001,张三,2024,计算机科学与技术,CS-2024\n20249002,李四,2024,计算机科学与技术,CS-2024');
const importPassword = ref('123456');
const importing = ref(false);
const importResult = ref<UserImportResult | null>(null);

async function loadUsers(targetPage = page.value): Promise<void> {
  loading.value = true;
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
  } catch (error) {
    reportApiError(error, '读取账号列表失败');
  } finally {
    loading.value = false;
  }
}

async function createUser(): Promise<void> {
  if (!createForm.username.trim() || !createForm.password) {
    toast.warning('请填写用户名与初始密码');
    return;
  }
  creating.value = true;
  try {
    await api.post('/admin/users', {
      username: createForm.username.trim(),
      password: createForm.password,
      displayName: createForm.displayName.trim() || createForm.username.trim(),
      role: createForm.role,
      studentNo: createForm.role === 'student' ? createForm.studentNo.trim() || createForm.username.trim() : undefined,
      grade: createForm.role === 'student' ? createForm.grade || null : null,
      major: createForm.role === 'student' ? createForm.major || null : null,
      programId: createForm.role === 'student' ? createForm.programId : undefined,
    });
    toast.success('账号已创建');
    createForm.username = '';
    createForm.password = '';
    createForm.displayName = '';
    createForm.studentNo = '';
    await loadUsers(1);
  } catch (error) {
    reportApiError(error, '创建账号失败');
  } finally {
    creating.value = false;
  }
}

async function changeStatus(row: UserRow): Promise<void> {
  const next = row.status === 'active' ? 'disabled' : 'active';
  const ok = await askConfirm({
    title: next === 'disabled' ? '停用账号' : '启用账号',
    message:
      next === 'disabled'
        ? `停用「${row.displayName}（${row.username}）」后，该账号的所有会话会立即失效。`
        : `启用「${row.displayName}（${row.username}）」后，该账号可以重新登录。`,
    confirmText: next === 'disabled' ? '确认停用' : '确认启用',
    danger: next === 'disabled',
  });
  if (!ok) return;
  statusChanging.value = row.id;
  try {
    await api.patch(`/admin/users/${row.id}/status`, { status: next });
    toast.success(next === 'disabled' ? '账号已停用' : '账号已启用');
    await loadUsers();
  } catch (error) {
    reportApiError(error, '修改账号状态失败');
  } finally {
    statusChanging.value = null;
  }
}

function openReset(row: UserRow): void {
  resetTarget.value = row;
  resetPassword.value = '';
}

async function submitReset(): Promise<void> {
  if (!resetTarget.value) return;
  if (resetPassword.value.length < 6) {
    toast.warning('密码至少 6 位');
    return;
  }
  const target = resetTarget.value;
  const ok = await askConfirm({
    title: '重置密码',
    message: `将重置「${target.displayName}（${target.username}）」的密码，该账号现有会话会全部失效。`,
    confirmText: '确认重置',
  });
  if (!ok) return;
  resetting.value = true;
  try {
    await api.post(`/admin/users/${target.id}/password`, { password: resetPassword.value });
    toast.success('密码已重置');
    resetTarget.value = null;
    resetPassword.value = '';
  } catch (error) {
    reportApiError(error, '重置密码失败');
  } finally {
    resetting.value = false;
  }
}

interface ParsedImportRow {
  studentNo: string;
  name: string;
  grade: string | null;
  major: string | null;
  programCode: string | null;
}

function parseImportRows(): ParsedImportRow[] {
  return importText.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const cells = line.split(/[,，\t]/).map((cell) => cell.trim());
      return {
        studentNo: cells[0] ?? '',
        name: cells[1] ?? '',
        grade: cells[2] || null,
        major: cells[3] || null,
        programCode: cells[4] || null,
      };
    });
}

async function importUsers(): Promise<void> {
  const rows = parseImportRows();
  if (rows.length === 0) {
    toast.warning('请至少填写一行数据');
    return;
  }
  const ok = await askConfirm({
    title: '批量导入学生账号',
    message: '按学号新建或更新学生账号；已存在的学号会更新姓名与培养信息，不会修改密码。',
    details: [`共 ${rows.length} 行`, `默认口令：${importPassword.value}`],
    confirmText: '开始导入',
    danger: false,
  });
  if (!ok) return;
  importing.value = true;
  try {
    const result = await api.post<UserImportResult>('/admin/users/import', {
      rows,
      defaultPassword: importPassword.value,
    });
    importResult.value = result;
    toast.success('导入完成', [`新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped.length}`]);
    await loadUsers(1);
  } catch (error) {
    reportApiError(error, '批量导入失败');
  } finally {
    importing.value = false;
  }
}

onMounted(async () => {
  try {
    const data = await api.get<{ programs: ProgramRow[] }>('/admin/programs');
    programs.value = data.programs;
  } catch {
    // 培养方案列表失败不影响账号管理
  }
  await loadUsers(1);
});
</script>

<template>
  <div class="page">
    <div class="page__header">
      <div>
        <h1 class="page__title">账号管理</h1>
        <p class="page__desc">学生与管理员使用同一个登录入口；停用账号会立即使其会话失效。</p>
      </div>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="loadUsers()">刷新</button>
    </div>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">新建账号</h3>
      </div>
      <div class="grid grid--3">
        <label class="field">
          <span class="field__label">用户名（学生可用学号）</span>
          <input v-model="createForm.username" class="input" type="text" />
        </label>
        <label class="field">
          <span class="field__label">初始密码（至少 6 位）</span>
          <input v-model="createForm.password" class="input" type="text" />
        </label>
        <label class="field">
          <span class="field__label">显示名称</span>
          <input v-model="createForm.displayName" class="input" type="text" />
        </label>
        <label class="field">
          <span class="field__label">角色</span>
          <select v-model="createForm.role" class="select">
            <option value="student">学生</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <template v-if="createForm.role === 'student'">
          <label class="field">
            <span class="field__label">学号（默认同用户名）</span>
            <input v-model="createForm.studentNo" class="input" type="text" />
          </label>
          <label class="field">
            <span class="field__label">年级</span>
            <input v-model="createForm.grade" class="input" type="text" />
          </label>
          <label class="field">
            <span class="field__label">专业</span>
            <input v-model="createForm.major" class="input" type="text" />
          </label>
          <label class="field">
            <span class="field__label">培养方案</span>
            <select v-model.number="createForm.programId" class="select">
              <option :value="null">不关联</option>
              <option v-for="program in programs" :key="program.id" :value="program.id">
                {{ program.code }} {{ program.name }}
              </option>
            </select>
          </label>
        </template>
      </div>
      <button class="btn btn--primary" type="button" :disabled="creating" @click="createUser">
        {{ creating ? '创建中…' : '创建账号' }}
      </button>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">账号列表</h3>
        <div class="inline">
          <select v-model="roleFilter" class="select" @change="loadUsers(1)">
            <option value="">全部角色</option>
            <option value="student">学生</option>
            <option value="admin">管理员</option>
          </select>
          <input v-model="keyword" class="input" type="text" placeholder="用户名或姓名" @keyup.enter="loadUsers(1)" />
          <button class="btn btn--ghost btn--sm" type="button" @click="loadUsers(1)">查询</button>
        </div>
      </div>
      <div v-if="users.length === 0" class="empty">没有符合条件的账号。</div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>用户名 / 学号</th>
              <th>姓名</th>
              <th>角色</th>
              <th>状态</th>
              <th>年级 / 专业</th>
              <th>最近登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in users" :key="row.id">
              <td>{{ row.id }}</td>
              <td class="mono">{{ row.username }}<div class="small muted">{{ row.studentNo ?? '' }}</div></td>
              <td>{{ row.displayName }}</td>
              <td>{{ row.role === 'admin' ? '管理员' : '学生' }}</td>
              <td>
                <span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--danger'">
                  {{ row.status === 'active' ? '正常' : '已停用' }}
                </span>
              </td>
              <td class="small muted">{{ row.grade ?? '—' }} / {{ row.major ?? '—' }}</td>
              <td class="small muted">{{ formatDateTime(row.lastLoginAt) }}</td>
              <td>
                <div class="inline">
                  <button class="btn btn--sm btn--ghost" type="button" :disabled="statusChanging === row.id" @click="changeStatus(row)">
                    {{ row.status === 'active' ? '停用' : '启用' }}
                  </button>
                  <button class="btn btn--sm btn--ghost" type="button" @click="openReset(row)">重置密码</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager :page="page" :page-size="pageSize" :total="total" :disabled="loading" @change="loadUsers" />
    </section>

    <section v-if="resetTarget" class="card">
      <div class="card__header">
        <h3 class="card__title">重置密码：{{ resetTarget.displayName }}（{{ resetTarget.username }}）</h3>
        <button class="btn btn--ghost btn--sm" type="button" @click="resetTarget = null">取消</button>
      </div>
      <div class="inline">
        <input v-model="resetPassword" class="input" type="text" placeholder="新密码（至少 6 位）" />
        <button class="btn btn--primary" type="button" :disabled="resetting" @click="submitReset">
          {{ resetting ? '重置中…' : '确认重置' }}
        </button>
      </div>
    </section>

    <section class="card">
      <div class="card__header">
        <h3 class="card__title">批量导入学生（rows 数组）</h3>
      </div>
      <p class="tips">每行一名学生，字段顺序：学号, 姓名, 年级, 专业, 培养方案代码（programCode）。已存在的学号会更新信息，不会修改密码。</p>
      <label class="field">
        <span class="field__label">数据（每行一条）</span>
        <textarea v-model="importText" class="textarea" rows="6"></textarea>
      </label>
      <div class="grid grid--3">
        <label class="field">
          <span class="field__label">默认口令</span>
          <input v-model="importPassword" class="input" type="text" />
        </label>
      </div>
      <div class="inline">
        <span class="badge">解析到 {{ parseImportRows().length }} 行</span>
        <button class="btn btn--primary" type="button" :disabled="importing" @click="importUsers">
          {{ importing ? '导入中…' : '开始导入' }}
        </button>
      </div>

      <div v-if="importResult" class="alert alert--info" style="margin-top: 10px">
        <strong>导入结果：</strong>新增 {{ importResult.created }}，更新 {{ importResult.updated }}，跳过
        {{ importResult.skipped.length }}
        <ul v-if="importResult.skipped.length > 0">
          <li v-for="(item, index) in importResult.skipped" :key="index">第 {{ item.row }} 行：{{ item.reason }}</li>
        </ul>
      </div>
      <p v-if="programs.length > 0" class="tips">可用培养方案代码：{{ programs.map((program) => program.code).join('、') }}</p>
    </section>
  </div>
</template>
