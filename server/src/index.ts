/**
 * 服务端入口。
 * 单机单实例：Express + SQLite（better-sqlite3，同步 API），
 * 同步写入配合数据库事务即可保证名额不被超额占用。
 */
import http from 'node:http';
import fs from 'node:fs';
import { config } from './config.js';
import { createApp } from './routes/index.js';
import { getDatabase, migrate } from './db/index.js';
import { registerWaitlistModule } from './modules/waitlist/service.js';
import { purgeExpiredSessions } from './modules/auth/service.js';

export function createServer(): { app: ReturnType<typeof createApp>; server: http.Server } {
  const db = getDatabase();
  const version = migrate(db);
  registerWaitlistModule();
  purgeExpiredSessions(db);

  const app = createApp();

  const server = http.createServer(app);
  // 演示场景下把结构版本打到日志里，便于确认数据库已迁移
  // eslint-disable-next-line no-console
  console.log(`[db] ${config.dbPath}（结构版本 ${version}）`);
  return { app, server };
}

async function main(): Promise<void> {
  if (!fs.existsSync(config.dbPath)) {
    process.stdout.write(
      `提示：未找到数据库文件。请先执行 npm run db:init && npm run db:seed（或 npm run db:reset）生成演示数据。\n`,
    );
  }
  const { server } = createServer();
  server.listen(config.port, config.host, () => {
    process.stdout.write(`选课系统后端已启动：http://${config.host}:${config.port}\n`);
    process.stdout.write(`健康检查：http://${config.host}:${config.port}/api/health\n`);
  });
}

const isDirectRun = process.argv[1] !== undefined && /index\.(ts|js)$/.test(process.argv[1]);
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`启动失败：${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
