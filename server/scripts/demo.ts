#!/usr/bin/env node
/**
 * 完整演示脚本（对真实 HTTP 接口操作，用来验证“一次完整演示”）。
 *
 * 使用方式：
 *   1. 另开一个终端执行 npm run dev:server（或 npm start）
 *   2. 本目录执行：npx tsx scripts/demo.ts
 *
 * 脚本会按需求里的业务阶段走一遍：
 *   资料准备与预分配 → 预览与提交 → 截止冻结 → 试算 → 发布 → 候补与退改选 → 结束
 */
import path from 'node:path';
import Database from 'better-sqlite3';

const BASE = process.env.DEMO_BASE ?? 'http://127.0.0.1:3001';

let cookie = '';

interface ApiResult<T> {
  status: number;
  ok: boolean;
  data: T;
  error?: { code: string; message: string };
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) cookie = setCookie[0].split(';')[0];
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as { ok: boolean; data: T; error?: { code: string; message: string } }) : { ok: false, data: undefined as T };
  return {
    status: response.status,
    ok: parsed.ok,
    data: parsed.data,
    error: parsed.error,
  };
}

function step(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function line(text: string): void {
  process.stdout.write(`  ${text}\n`);
}

function must<T>(result: ApiResult<T>, what: string): T {
  if (!result.ok) {
    throw new Error(`${what} 失败（HTTP ${result.status}）：${result.error?.code} ${result.error?.message}`);
  }
  return result.data;
}


/**
 * 演示脚本用的只读查询：有些信息（例如候补学生的学号）没有对外接口，
 * 这里直接读演示数据库来展示结果，**只读不写**，不会绕过任何业务规则。
 */
function ctxDbRow(sql: string, ...params: Array<string | number>): Record<string, string> | null {
  try {
    // 演示脚本自己打开一个只读连接（不经过服务进程，也不需要迁移）
    const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'course-selection.db');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(sql).get(...params) as Record<string, string> | undefined;
    db.close();
    return row ?? null;
  } catch (error) {
    process.stderr.write(`（演示脚本读取数据库失败：${error instanceof Error ? error.message : String(error)}）\n`);
    return null;
  }
}

async function main(): Promise<void> {
  step('① 登录管理员');
  const admin = must(await api<{ user: { displayName: string; role: string } }>('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }), '管理员登录');
  line(`已登录：${admin.user.displayName}（${admin.user.role}）`);

  step('② 查看资料版本与配置');
  const versions = must(await api<{ versions: unknown[] }>('GET', '/api/admin/versions'), '读取资料版本');
  line(`已有资料版本记录 ${versions.versions.length} 条（发布过的资料会在这里留痕）`);
  const configs = must(await api<{ configReady: boolean; configs: Array<{ key: string; value: string }> }>('GET', '/api/admin/configs'), '读取配置');
  line(`配置是否齐全：${configs.configReady ? '是' : '否'}`);
  line(`学分上限：${configs.configs.find((c) => c.key === 'credit_limit_default')?.value ?? '(未配置)'}`);

  step('③ 创建选课批次并开放提交');
  const term = (await api<{ terms: string[] }>('GET', '/api/terms')).data?.terms?.[0] ?? '2026-2027-1';
  const batchName = `演示批次-${new Date().toISOString().slice(0, 19)}`;
  const batch = must(await api<{ id: number; status: string }>('POST', '/api/admin/batches', {
    term,
    name: batchName,
    creditLimit: 30,
  }), '创建批次');
  line(`批次 #${batch.id}（${term}）状态：${batch.status}`);
  for (const status of ['preview', 'open']) {
    const next = must(await api<{ status: string }>('POST', `/api/admin/batches/${batch.id}/transition`, { status }), `切换到 ${status}`);
    line(`状态 → ${next.status}`);
  }

  step('④ 学生登录并查看培养进度');
  const studentNo = '20241001';
  const studentLogin = must(await api<{ user: { id: number } }>('POST', '/api/auth/login', { username: studentNo, password: '123456' }), '学生登录');
  const studentId = studentLogin.user.id;
  line(`已登录学生 ${studentNo}（userId=${studentId}）`);
  const progress = must(await api<{ progress: { requirements: Array<{ name: string; remainingCredits: number }> } }>('GET', '/api/student/progress'), '读取进度');
  for (const requirement of progress.progress.requirements.slice(0, 4)) {
    line(`培养需求「${requirement.name}」还缺 ${requirement.remainingCredits} 学分`);
  }

  step('⑤ 选课助手规划（离线规则引擎，不联网）');
  const plan = must(await api<{ mode: string; notice: string; plans: Array<{ label: string; totalCredits: number; items: Array<{ courseName: string; demandLevel: string }> }> }>(
    'POST',
    '/api/agent/plan',
    { preferenceText: '必须选数据结构，尽量选人工智能导论，周三不要排课，不超过 22 学分', studentId },
  ), '生成规划');
  line(`模式：${plan.mode}｜${plan.notice}`);
  for (const p of plan.plans) {
    line(`${p.label}：${p.totalCredits} 学分，${p.items.length} 门课（${p.items.slice(0, 3).map((i) => `${i.courseName}[${i.demandLevel}]`).join('、')}）`);
  }

  step('⑥ 学生提交志愿（含替代组）');
  const classes = must(await api<{ items: Array<{ id: number; courseId: number; courseName: string; generalAvailable: number }> }>(
    'GET',
    `/api/classes?onlyAvailable=true&pageSize=12&studentId=${studentId}`,
  ), '检索教学班');
  // 志愿是按“课程”表达的：同一门课只出现一次，不同的教学班放在该课程的偏好顺序里
  const pickedByCourse = new Map<number, { courseName: string; classIds: number[] }>();
  for (const cls of classes.items) {
    const entry = pickedByCourse.get(cls.courseId) ?? { courseName: cls.courseName, classIds: [] };
    entry.classIds.push(cls.id);
    pickedByCourse.set(cls.courseId, entry);
  }
  const picked = Array.from(pickedByCourse.entries()).slice(0, 3).map(([courseId, entry]) => ({
    courseId,
    courseName: entry.courseName,
    classIds: entry.classIds,
  }));
  if (picked.length === 0) throw new Error('没有可用教学班，无法演示');
  const preferences = picked.map((cls, index) => ({
    courseId: cls.courseId,
    globalRank: index + 1,
    classIds: cls.classIds,
    groupCode: null,
  }));
  const validation = must(await api<{ ok: boolean; issues: Array<{ level: string; message: string }> }>(
    'POST',
    '/api/preferences/validate',
    { batchId: batch.id, preferences, groups: [], studentId },
  ), '校验志愿');
  line(`校验结果：${validation.ok ? '通过' : '有错误'}`);
  for (const issue of validation.issues.slice(0, 3)) line(`[${issue.level}] ${issue.message}`);
  const submission = must(await api<{ versionNo: number; submissionId: number }>(
    'POST',
    '/api/preferences/submit',
    { batchId: batch.id, preferences, groups: [], studentId },
  ), '提交志愿');
  line(`提交成功：版本 v${submission.versionNo}（submissionId=${submission.submissionId}）`);

  step('⑦ 更多学生提交志愿（制造竞争）');
  let submitted = 1;
  for (let i = 2; i <= 8; i += 1) {
    const no = `2024${String(1000 + i).padStart(4, '0')}`;
    await api('POST', '/api/auth/login', { username: no, password: '123456' });
    const theirClasses = must(await api<{ items: Array<{ id: number; courseId: number; courseName: string }> }>(
      'GET',
      `/api/classes?onlyAvailable=true&pageSize=40`,
    ), '检索教学班');
    // 按“课程”聚合，并且每名学生从不同的位置开始挑，制造真实的竞争分布
    const grouped = new Map<number, { courseName: string; classIds: number[] }>();
    for (const cls of theirClasses.items) {
      const entry = grouped.get(cls.courseId) ?? { courseName: cls.courseName, classIds: [] };
      entry.classIds.push(cls.id);
      grouped.set(cls.courseId, entry);
    }
    const pool = Array.from(grouped.entries());
    const start = (i - 1) % Math.max(1, pool.length);
    const theirPreferences = [0, 1, 2]
      .map((offset) => pool[(start + offset) % pool.length])
      .filter((entry): entry is [number, { courseName: string; classIds: number[] }] => Boolean(entry))
      .map(([courseId, entry], index) => ({ courseId, globalRank: index + 1, classIds: entry.classIds }));
    if (theirPreferences.length === 0) continue;
    const result = await api('POST', '/api/preferences/submit', { batchId: batch.id, preferences: theirPreferences, groups: [] });
    if (result.ok) submitted += 1;
    else line(`（学生 ${no} 提交被拒绝：${result.error?.code} ${result.error?.message}）`);
  }
  line(`共 ${submitted} 名学生完成提交`);

  step('⑦.5 制造真实竞争（多个学生抢同一个教学班）');
  // 分配是“能放就放”，如果申请都不冲突，所有人都会选上、也就没有候补可看。
  // 这里刻意让一批学生集中申请同一门课，让首轮出现落选者，从而演示候补队列。
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const allClasses = must(await api<{ items: Array<{ id: number; courseId: number; courseName: string; classCode: string; capacity: number; reservedSeats: number; enrolled: number }> }>(
    'GET',
    '/api/classes?onlyAvailable=true&pageSize=200',
  ), '检索教学班').items;

  // 选一门“报名人数最少”的课程，把它的**全部教学班**容量收紧到刚好只剩 1 个空位。
  // 只收紧一个班是没有用的：分配时会在同一门课程的其它教学班之间找位置。
  const byCourse = new Map<number, typeof allClasses>();
  for (const cls of allClasses) {
    const list = byCourse.get(cls.courseId) ?? [];
    list.push(cls);
    byCourse.set(cls.courseId, list);
  }
  const best = [...byCourse.values()]
    .filter((list) => list.every((cls) => cls.reservedSeats === 0) && list.length <= 3)
    .map((list) => ({
      list,
      enrolled: list.reduce((sum, cls) => sum + cls.enrolled, 0),
      spare: list.reduce((sum, cls) => sum + (cls.capacity - cls.enrolled), 0),
    }))
    .sort((a, b) => a.enrolled - b.enrolled || b.spare - a.spare)[0];

  let crowded: { courseId: number; courseName: string; classCode: string; id: number } | null = null;
  if (best && best.spare > 1) {
    let remaining = 1; // 全课程只留 1 个普通名额
    for (const cls of best.list) {
      const keep = remaining > 0 ? Math.min(cls.enrolled + remaining, cls.capacity) : cls.enrolled;
      const granted = Math.max(0, keep - cls.enrolled);
      remaining -= granted;
      if (keep <= cls.capacity) {
        await api('PATCH', `/api/admin/classes/${cls.id}`, { capacity: keep, reservedSeats: 0, status: 'open' });
      }
    }
    crowded = {
      courseId: best.list[0].courseId,
      courseName: best.list[0].courseName,
      classCode: best.list.map((c) => c.classCode).join(' / '),
      id: best.list[0].id,
    };
    line(`竞争课程：${crowded.courseName}（${crowded.classCode}）——管理员把该课程所有教学班收紧到合计只剩 1 个普通名额`);
  } else {
    line('没有找到可以安全收紧容量的课程，本次跳过“制造竞争”这一步。');
  }

  let contenders = 0;
  if (crowded) {
    for (let i = 21; i <= 30; i += 1) {
      const no = `2024${String(1000 + i).padStart(4, '0')}`;
      const loginResult = await api('POST', '/api/auth/login', { username: no, password: '123456' });
      if (!loginResult.ok) continue;
      const submit = await api('POST', '/api/preferences/submit', {
        batchId: batch.id,
        preferences: [{ courseId: crowded.courseId, globalRank: 1, classIds: [] }],
      });
      if (submit.ok) contenders += 1;
    }
    line(`另有 ${contenders} 名学生把该课程填为第一志愿，首轮必然出现落选者`);
    await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  }

  step('⑧ 管理员冻结批次（截止）并试算');
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const freeze = must(await api<{ contentHash: string }>('POST', `/api/admin/batches/${batch.id}/freeze`, {}), '冻结批次');
  line(`快照已生成，内容哈希：${freeze.contentHash.slice(0, 16)}…`);
  const simulate = must(await api<{ runId: number; report: { allocated: number; rejected: number; guaranteeFulfilled: number; exceptions: unknown[]; durationMs: number } }>(
    'POST',
    `/api/admin/batches/${batch.id}/allocate`,
    { mode: 'simulate' },
  ), '试算分配');
  line(`试算 runId=${simulate.runId}：落实 ${simulate.report.allocated} 项，未落实 ${simulate.report.rejected} 项，用时 ${simulate.report.durationMs}ms`);
  line(`保障异常 ${simulate.report.exceptions.length} 条`);

  step('⑨ 管理员确认发布结果（可安全重试）');
  const publish = must(await api<{ runId: number; status: string; report: { allocated: number } }>(
    'POST',
    `/api/admin/batches/${batch.id}/allocate`,
    { mode: 'publish', idempotencyKey: `demo-publish-${batch.id}`, timeoutMs: 60000 },
  ), '发布结果');
  line(`发布完成：run #${publish.runId}，落实 ${publish.report.allocated} 项`);
  const retry = must(await api<{ idempotentReplay: boolean }>(
    'POST',
    `/api/admin/batches/${batch.id}/allocate`,
    { mode: 'publish', idempotencyKey: `demo-publish-${batch.id}` },
  ), '重复发布');
  line(`重复发布是否复用结果：${retry.idempotentReplay ? '是（名额没有被重复扣减）' : '否'}`);

  step('⑩ 进入候补与退改选，落选申请自动候补');
  must(await api('POST', `/api/admin/batches/${batch.id}/transition`, { status: 'published' }), '切换到已发布');
  const enqueue = must(await api<{ queued: number }>('POST', `/api/admin/batches/${batch.id}/enqueue-waitlist`, {}), '转入候补');
  line(`转入候补 ${enqueue.queued} 条`);
  must(await api('POST', `/api/admin/batches/${batch.id}/transition`, { status: 'waitlist' }), '切换到候补阶段');
  line('批次状态：候补与退改选');

  step('⑪ 学生查看课表、候补顺位与结果解释');
  await api('POST', '/api/auth/login', { username: studentNo, password: '123456' });
  const timetable = must(await api<{ timetable: { classes: Array<{ courseName: string; classCode: string; source: string }>; totalCredits: number; creditLimit: number } }>(
    'GET',
    `/api/timetable?studentId=${studentId}`,
  ), '读取课表');
  line(`当前课表 ${timetable.timetable.classes.length} 门，共 ${timetable.timetable.totalCredits} 学分（上限 ${timetable.timetable.creditLimit}）`);
  for (const cls of timetable.timetable.classes) line(`- ${cls.courseName} ${cls.classCode}（来源：${cls.source}）`);
  const waitlist = must(await api<{ entries: Array<{ courseName: string; status: string; position: number | null; suspendHint: string }> }>(
    'GET',
    `/api/waitlist?batchId=${batch.id}&studentId=${studentId}`,
  ), '读取候补');
  for (const entry of waitlist.entries) {
    line(`候补：${entry.courseName}｜状态 ${entry.status}｜当前顺位 ${entry.position ?? '—'}｜${entry.suspendHint ?? ''}`);
  }
  for (const cls of picked.slice(0, 2)) {
    const explain = must(await api<{ text: string }>('GET', `/api/agent/explain?courseId=${cls.courseId}&studentId=${studentId}`), '解释结果');
    line('—'.repeat(20));
    for (const row of explain.text.split('\n')) line(row);
  }

  step('⑫ 候补竞争与自动提升（有人退课时名额先给合格候补）');
  // 落选者可能不是演示学生本人，这里用管理员视角找一个真实的候补号来演示
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const queueInfo = crowded
    ? await api<{ length: number; myPosition: number | null }>('GET', `/api/waitlist/queue?batchId=${batch.id}&courseId=${crowded.courseId}&studentId=1`)
    : null;
  if (crowded && queueInfo?.ok) {
    line(`「${crowded.courseName}」当前候补队列长度：${queueInfo.data.length}`);
  }

  if (crowded) {
    // 找出这门课当前的候补第一名（管理员视角；演示脚本直接读库以拿到学号）
    const topWaiter = ctxDbRow(
      `SELECT s.student_no AS studentNo FROM waitlist_entries we
       JOIN students s ON s.user_id = we.student_id
       WHERE we.course_id = ? AND we.status IN ('queued', 'suspended')
       ORDER BY CASE we.demand_level WHEN 'D2' THEN 0 WHEN 'D1' THEN 1 ELSE 2 END, we.global_rank, we.random_key
       LIMIT 1`,
      crowded.courseId,
    );
    // 找出这门课当前的一位持有者
    const holder = ctxDbRow(
      `SELECT s.student_no AS studentNo, tc.class_code AS classCode
       FROM enrollments e JOIN students s ON s.user_id = e.student_id
       JOIN teaching_classes tc ON tc.id = e.class_id
       WHERE tc.course_id = ? AND e.status = 'enrolled' LIMIT 1`,
      crowded.courseId,
    );

    if (topWaiter && holder) {
      // 1) 队列里有人时，别的学生不能直接抢这个名额
      const outsiderNo = '20241030';
      await api('POST', '/api/auth/login', { username: outsiderNo, password: '123456' });
      const attempt = await api('POST', '/api/enroll', { classId: crowded.id, idempotencyKey: `demo-outsider-${batch.id}` });
      line(
        attempt.ok
          ? `学生 ${outsiderNo} 直接选上了（该班还有普通名额）`
          : `学生 ${outsiderNo} 直接选课被拒绝：${attempt.error?.code}${
              queueInfo?.ok && queueInfo.data.length > 0
                ? `——该课程队列里还有 ${queueInfo.data.length} 条合格候补，名额必须优先给他们`
                : ''
            }`,
      );
      // 2) 持有者退课 → 触发候补自动提升
      await api('POST', '/api/auth/login', { username: holder.studentNo, password: '123456' });
      const drop = await api('POST', '/api/drop', { classId: crowded.id, idempotencyKey: `demo-drop-${batch.id}` });
      line(`持有名额的学生 ${holder.studentNo}（${holder.classCode}）退课：${drop.ok ? '成功，名额已释放' : drop.error?.message ?? '失败'}`);
      // 3) 候补第一名现在应当已成为“已提升”
      const after = ctxDbRow(
        `SELECT we.status, s.student_no AS studentNo FROM waitlist_entries we
         JOIN students s ON s.user_id = we.student_id
         WHERE we.course_id = ? AND s.student_no = ?`,
        crowded.courseId,
        topWaiter.studentNo,
      );
      line(
        after?.status === 'promoted'
          ? `候补第一名 ${topWaiter.studentNo} 已被自动提升（名额释放后先给合格候补）`
          : `候补第一名 ${topWaiter.studentNo} 当前状态：${after?.status ?? '未知'}`,
      );
    } else {
      line('没有同时找到候补学生与名额持有者，跳过提升演示。');
    }
  }

  // 演示学生自己再看一次候补视图（顺位、暂挂原因、关闭原因）
  await api('POST', '/api/auth/login', { username: studentNo, password: '123456' });
  const waiting = must(await api<{ entries: Array<{ courseName: string; status: string; position: number | null; suspendHint: string | null; closeReason: string | null }> }>(
    'GET',
    `/api/waitlist?batchId=${batch.id}&studentId=${studentId}`,
  ), '读取候补');
  line(`演示学生本人的候补记录：${waiting.entries.length} 条`);
  for (const entry of waiting.entries) {
    line(
      `  候补：${entry.courseName}｜状态 ${entry.status}｜顺位 ${entry.position ?? '—'}` +
        (entry.suspendHint ? `｜${entry.suspendHint}` : '') +
        (entry.closeReason ? `｜关闭原因：${entry.closeReason}` : ''),
    );
  }

  step('⑬ 结束批次');
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const closed = must(await api<{ status: string }>('POST', `/api/admin/batches/${batch.id}/transition`, { status: 'closed' }), '结束批次');
  line(`批次状态：${closed.status}`);

  step('演示完成');
  line('如果上面的每一步都有输出且没有报错，说明完整流程可以跑通。');
  line('管理端页面可以复核：批次控制、资料发布、分配执行明细、异常清单、操作记录。');
}

main().catch((error: unknown) => {
  process.stderr.write(`\n演示中断：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
