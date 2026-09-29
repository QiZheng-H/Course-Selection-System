/**
 * 一次性维护脚本：把「班级成员」截图里的 52 名学生与 1 位教师导入数据库。
 *
 * 与 db:seed 的区别：本脚本只做增量写入，不清空任何既有数据，可重复执行（按学号去重）。
 * 口令规则：每个学生账号的初始口令 = 自己的学号（username 也是学号）。
 *
 * 用法：npm run import:class -w server
 */
import { getDatabase, openDatabase } from '../src/db/index.js';
import { hashPassword } from '../src/core/password.js';
import { nowIso } from '../src/core/utils.js';

/** 培养方案 A：光电信息与计算机工程学院（截图里可辨认的 41 名中文姓名学生） */
const PROGRAM_A = {
  code: 'CS-2024-OECE',
  name: '光电信息与计算机工程学院（2024 级）',
  grade: '2024',
  major: '计算机科学与技术',
};

/** 培养方案 B：沪江学院（美育中心合署）（截图里 11 名留学生） */
const PROGRAM_B = {
  code: 'HJ-2024',
  name: '沪江学院（美育中心合署）（2024 级）',
  grade: '2024',
  major: null as string | null,
};

const PROGRAM_A_STUDENTS: Array<[studentNo: string, name: string]> = [
  ['2435050907', '张彦君'],
  ['2435051222', '苏昱嘉'],
  ['2435051911', '胡术淇'],
  ['2435052403', '黄琦铮'],
  ['2435052929', '周正杰'],
  ['2435054322', '项伟成'],
  ['2435055208', '陈嘉豪'],
  ['2435055230', '周智轩'],
  ['2435060115', '贾旭'],
  ['2435060118', '李奕斐'],
  ['2435060127', '杨毅诚'],
  ['2435060208', '朱文清'],
  ['2435060230', '张正航'],
  ['2435060403', '贾雨涵'],
  ['2435060409', '柴清会'],
  ['2435060419', '吕文曦'],
  ['2435060506', '孙鹤娉'],
  ['2435060627', '叶锦方'],
  ['2435060806', '谭云轩'],
  ['2435060927', '殷浩然'],
  ['2435061008', '钟瑶萍'],
  ['2435061021', '汪盈宝'],
  ['2435061101', '樊欣灵'],
  ['2435061112', '李成耀'],
  ['2435061209', '鲍志航'],
  ['2435061222', '谈俊哲'],
  ['2435061406', '徐佳莹'],
  ['2435061501', '陈锦霞'],
  ['2435061708', '张钰轩'],
  ['2435061910', '陈越云'],
  ['2435061913', '胡凯文'],
  ['2435061923', '席文易'],
  ['2435062015', '李卓恒'],
  ['2435062115', '连远皓'],
  ['2435062313', '程新楠'],
  ['2435062328', '余东阳'],
  ['2435062329', '张奕凡'],
  ['2435062417', '卢一鸣'],
  ['2435062706', '孙妍姝'],
  ['2435062707', '周雨欣'],
  ['2435062710', '陈晔春'],
];

const PROGRAM_B_STUDENTS: Array<[studentNo: string, name: string]> = [
  ['2412087101', 'ALEXANDROVA ANASTASIA'],
  ['2412087102', 'ALLAKOVA MAHRI'],
  ['2412087103', 'ANNAMYRADOVA LACHYN'],
  ['2412087105', 'IGDIROVA AYGOZEL'],
  ['2412087106', 'SEYITNAZAROVA OGULGURBAN'],
  ['2412087107', 'BASHIMOV SHAMYRAT'],
  ['2412087108', 'GURBANGYLYJOV TAGANGYLYCH'],
  ['2412087109', 'JUMADURDYYEV NAZAR'],
  ['2412087110', 'NURYAGDYYEV TIMUR'],
  ['2412087111', 'SAPARGELDIYEV MUHAMMET'],
  ['2412087112', 'YAZBERDIYEV PENA'],
];

const TEACHER = { name: '李锐', department: '光电信息与计算机工程学院', title: null };

function ensureProgram(db: ReturnType<typeof openDatabase>, p: { code: string; name: string; grade: string; major: string | null }): number {
  const found = db.prepare('SELECT id FROM programs WHERE code = ?').get(p.code) as { id: number } | undefined;
  if (found) return found.id;
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO programs (code, name, grade, major, total_credits, version, published_at, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'v1', ?, 'published', ?)`,
    )
    .run(p.code, p.name, p.grade, p.major, now, now);
  return Number(info.lastInsertRowid);
}

function main(): void {
  const db = openDatabase();
  const now = nowIso();
  let created = 0;
  let restored = 0;
  const skipped: Array<{ studentNo: string; name: string; reason: string }> = [];

  db.transaction(() => {
    const programA = ensureProgram(db, PROGRAM_A);
    const programB = ensureProgram(db, PROGRAM_B);

    // 教师：同名同学院已存在则复用
    const existingTeacher = db
      .prepare('SELECT id FROM teachers WHERE name = ? AND department = ?')
      .get(TEACHER.name, TEACHER.department) as { id: number } | undefined;
    if (existingTeacher) {
      process.stdout.write(`教师已存在，复用 id=${existingTeacher.id}：${TEACHER.name}\n`);
    } else {
      const info = db
        .prepare('INSERT INTO teachers (name, department, title) VALUES (?, ?, ?)')
        .run(TEACHER.name, TEACHER.department, TEACHER.title);
      process.stdout.write(`教师已写入 id=${Number(info.lastInsertRowid)}：${TEACHER.name} / ${TEACHER.department}\n`);
    }

    const rows = [
      ...PROGRAM_A_STUDENTS.map(([studentNo, name]) => ({ studentNo, name, major: PROGRAM_A.major, programId: programA })),
      ...PROGRAM_B_STUDENTS.map(([studentNo, name]) => ({ studentNo, name, major: PROGRAM_B.major, programId: programB })),
    ];

    for (const row of rows) {
      const dupUser = db.prepare('SELECT id FROM users WHERE username = ?').get(row.studentNo) as { id: number } | undefined;
      if (dupUser) {
        skipped.push({ studentNo: row.studentNo, name: row.name, reason: '用户名/学号已存在，未覆盖' });
        continue;
      }
      const dupNo = db.prepare('SELECT user_id FROM students WHERE student_no = ?').get(row.studentNo) as
        | { user_id: number }
        | undefined;
      if (dupNo) {
        // 学号已登记但没有登录账号：补一个账号，口令仍为学号
        const info = db
          .prepare(
            `INSERT INTO users (username, password_hash, display_name, role, status, created_at)
             VALUES (?, ?, ?, 'student', 'active', ?)`,
          )
          .run(row.studentNo, hashPassword(row.studentNo), row.name, now);
        db.prepare('UPDATE students SET user_id = ? WHERE student_no = ?').run(Number(info.lastInsertRowid), row.studentNo);
        restored += 1;
        continue;
      }

      const info = db
        .prepare(
          `INSERT INTO users (username, password_hash, display_name, role, status, created_at)
           VALUES (?, ?, ?, 'student', 'active', ?)`,
        )
        .run(row.studentNo, hashPassword(row.studentNo), row.name, now);
      const userId = Number(info.lastInsertRowid);

      db.prepare(
        `INSERT INTO students (user_id, student_no, name, grade, major, program_id, admitted_year, expected_graduate_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 2024, '2028-07-01', ?)`,
      ).run(userId, row.studentNo, row.name, PROGRAM_A.grade, row.major, row.programId, now);
      created += 1;
    }
  })();

  process.stdout.write(`\n学生账号：新增 ${created}，补建 ${restored}，跳过 ${skipped.length}\n`);
  for (const s of skipped) process.stdout.write(`  跳过 ${s.studentNo} ${s.name}（${s.reason}）\n`);

  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM students) AS students,
              (SELECT COUNT(*) FROM teachers) AS teachers,
              (SELECT COUNT(*) FROM programs) AS programs`,
    )
    .get() as Record<string, number>;
  process.stdout.write(`当前总量：${JSON.stringify(totals)}\n`);

  db.close();
  getDatabase;
}

main();
