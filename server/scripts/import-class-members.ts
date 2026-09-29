/**
 * 维护脚本：把班级名单（见 src/db/class-roster.ts）写进**已有**数据库。
 *
 * 什么时候需要它：
 *   - 数据库是班级名单加入种子数据**之前**建的，想在不重建库的前提下补上这 52 个账号；
 *   - 全新环境不需要它 —— `npm run db:reset` 已经会写入名单（种子数据的一部分）。
 *
 * 特性：只做增量写入，不清空既有数据；按学号去重，可安全重复执行。
 * 口令规则：每个学生账号的初始口令 = 自己的学号。
 *
 * 用法：npm run import:class -w server
 */
import { getDatabase, openDatabase } from '../src/db/index.js';
import { CLASS_ROSTER_STUDENTS, CLASS_ROSTER_TEACHER } from '../src/db/class-roster.js';
import { hashPassword } from '../src/core/password.js';
import { nowIso } from '../src/core/utils.js';

function main(): void {
  const db = openDatabase();
  const now = nowIso();
  let created = 0;
  const skipped: Array<{ studentNo: string; name: string; reason: string }> = [];

  db.transaction(() => {
    // 教师：同名同学院已存在则复用，避免重复
    const existingTeacher = db
      .prepare('SELECT id FROM teachers WHERE name = ? AND department = ?')
      .get(CLASS_ROSTER_TEACHER.name, CLASS_ROSTER_TEACHER.department) as { id: number } | undefined;
    if (existingTeacher) {
      process.stdout.write(`教师已存在，复用 id=${existingTeacher.id}：${CLASS_ROSTER_TEACHER.name}\n`);
    } else {
      const info = db
        .prepare('INSERT INTO teachers (name, department, title, is_demo) VALUES (?, ?, ?, 0)')
        .run(CLASS_ROSTER_TEACHER.name, CLASS_ROSTER_TEACHER.department, CLASS_ROSTER_TEACHER.title);
      process.stdout.write(`教师已写入 id=${Number(info.lastInsertRowid)}：${CLASS_ROSTER_TEACHER.name}\n`);
    }

    const insertUser = db.prepare(
      `INSERT INTO users (username, password_hash, display_name, role, status, created_at)
       VALUES (?, ?, ?, 'student', 'active', ?)`,
    );
    const insertStudent = db.prepare(
      `INSERT INTO students (user_id, student_no, name, grade, major, program_id, admitted_year, expected_graduate_at, created_at, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );

    for (const student of CLASS_ROSTER_STUDENTS) {
      const dupUser = db.prepare('SELECT id FROM users WHERE username = ?').get(student.studentNo) as
        | { id: number }
        | undefined;
      if (dupUser) {
        skipped.push({ studentNo: student.studentNo, name: student.name, reason: '账号已存在，未覆盖' });
        continue;
      }
      const program = db.prepare('SELECT id, grade, major FROM programs WHERE code = ?').get(student.programCode) as
        | { id: number; grade: string | null; major: string | null }
        | undefined;
      if (!program) {
        skipped.push({ studentNo: student.studentNo, name: student.name, reason: `培养方案 ${student.programCode} 不存在` });
        continue;
      }

      const info = insertUser.run(student.studentNo, hashPassword(student.studentNo), student.name, now);
      const userId = Number(info.lastInsertRowid);
      const admittedYear = Number.parseInt(program.grade ?? '2024', 10);
      insertStudent.run(
        userId,
        student.studentNo,
        student.name,
        program.grade,
        program.major,
        program.id,
        Number.isFinite(admittedYear) ? admittedYear : null,
        Number.isFinite(admittedYear) ? `${admittedYear + 4}-07-01` : null,
        now,
      );
      created += 1;
    }
  })();

  process.stdout.write(`\n学生账号：新增 ${created}，跳过 ${skipped.length}\n`);
  for (const s of skipped) process.stdout.write(`  跳过 ${s.studentNo} ${s.name}（${s.reason}）\n`);

  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM students) AS students,
              (SELECT COUNT(*) FROM teachers) AS teachers`,
    )
    .get() as Record<string, number>;
  process.stdout.write(`当前总量：${JSON.stringify(totals)}\n`);

  db.close();
  getDatabase;
}

main();
