#!/usr/bin/env node
/**
 * 数据库命令行工具：
 *   npm run db:init    创建结构（可重复执行，已存在的迁移会跳过）
 *   npm run db:seed    在空库中写入演示数据
 *   npm run db:reset   删除数据库文件后重新建库并写入演示数据
 *   npm run db:status  查看当前结构与数据量
 */
import fs from 'node:fs';
import { config } from '../config.js';
import { closeDatabase, currentVersion, getDatabase, migrate, openDatabase } from './index.js';
import { seedDatabase } from './seed.js';

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  if (command === 'reset') {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = `${config.dbPath}${suffix}`;
      if (fs.existsSync(file)) fs.rmSync(file);
    }
    log(`已删除旧数据库：${config.dbPath}`);
  }

  const db = openDatabase();

  if (command === 'init') {
    const version = migrate(db);
    log(`结构已就绪，当前结构版本：${version}`);
  } else if (command === 'seed' || command === 'reset') {
    const summary = seedDatabase(db);
    log('演示数据写入完成：');
    log(`  培养方案：${summary.programName}（${summary.programCode}），官方课程 ${summary.officialCourses} 门`);
    log(`  学生 ${summary.students} 人，课程 ${summary.courses} 门，教学班 ${summary.classes} 个`);
    log(`  真实班级名单 ${summary.rosterStudents} 人（is_demo=0，初始口令 = 本人学号）与 1 位教师`);
    log(`  修读记录 ${summary.records} 条，专业课预分配 ${summary.preallocations} 条`);
    log(`  演示学期：${summary.term}（学生当前教学阶段三/1）`);
    log(`  演示选课批次 #${summary.batchId}（状态：正式受理，可直接提交志愿）`);
    log('  管理员：admin / admin123；演示学生：20241001-20241100 / 123456');
    log('  名单学生：2435050907-2435062710、2412087101-2412087112 / 口令为本人学号');
    log('  说明：课程来自上海理工大学 2024 级计算机科学与技术专业官方培养计划；');
    log('        教师、教学班时间与容量、学生账号与修读记录均为演示模拟配置（库内有 is_demo 标记）。');
    log('        来源网址与页码见 docs/培养方案来源核对.md。');
  } else if (command === 'status') {
    const version = currentVersion(db);
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users)            AS users,
           (SELECT COUNT(*) FROM students)         AS students,
           (SELECT COUNT(*) FROM courses)          AS courses,
           (SELECT COUNT(*) FROM teaching_classes) AS classes,
           (SELECT COUNT(*) FROM student_course_records) AS records,
           (SELECT COUNT(*) FROM selection_batches) AS batches,
           (SELECT COUNT(*) FROM enrollments WHERE status = 'enrolled') AS enrollments`,
      )
      .get() as Record<string, number>;
    log(`数据库文件：${config.dbPath}`);
    log(`结构版本：${version}`);
    for (const [key, value] of Object.entries(counts)) {
      log(`  ${key}: ${value}`);
    }
  } else {
    log(`未知命令：${command}`);
    process.exitCode = 1;
  }
  db.close();
  getDatabase;
}

main().catch((error: unknown) => {
  process.stderr.write(`执行失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
