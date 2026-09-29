#!/usr/bin/env node
/**
 * 并行运行多个 npm 脚本，并保证 Ctrl+C 时一起退出。
 *
 * 为什么不直接用 `npm run a & npm run b`：
 *   shell 的 `&` 在 Ctrl+C 时通常只结束前台进程，tsc / vite / node 会变成孤儿进程继续占用端口。
 * 这里给每个子进程建独立进程组（detached），退出时对**整个进程组**发信号，
 * 保证监听进程被真正清理掉。
 *
 * 用法（在仓库根目录）：
 *   node scripts/watch.mjs "npm run build:watch -w web"
 *   node scripts/watch.mjs "npm run build:watch -w server" "npm run build:watch -w web"
 */
import { spawn } from 'node:child_process';

const tasks = process.argv.slice(2).filter((item) => item.trim() !== '');
if (tasks.length === 0) {
  process.stderr.write('用法: node scripts/watch.mjs "<命令1>" ["<命令2>" ...]\n');
  process.exit(1);
}

const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m'];
const RESET = '\x1b[0m';

function prefixStream(stream, tag, out) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) out.write(`${tag} ${line}\n`);
  });
  stream.on('end', () => {
    if (buffer) out.write(`${tag} ${buffer}\n`);
  });
}

const children = tasks.map((task, index) => {
  // 用 shell 执行，兼容带引号/重定向的写法；detached 让它成为独立进程组组长
  const child = spawn(task, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const label = task.replace(/^npm run\s+/, '').replace(/\s+-w\s+/g, '@');
  const tag = `${COLORS[index % COLORS.length]}[${label}]${RESET}`;
  prefixStream(child.stdout, tag, process.stdout);
  prefixStream(child.stderr, tag, process.stderr);
  child.on('error', (error) => {
    process.stderr.write(`${tag} 启动失败：${error.message}\n`);
  });
  return { task, child, tag };
});

let exiting = false;

function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const { child } of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    try {
      // 负号 = 对整个进程组发信号，连带结束 tsc / vite / node 子进程
      process.kill(-child.pid, 'SIGINT');
    } catch {
      /* 进程可能已经退出 */
    }
  }
  setTimeout(() => {
    for (const { child } of children) {
      if (child.pid === undefined || child.exitCode !== null) continue;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
    process.exit(code);
  }, 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const { child, tag } of children) {
  child.on('exit', (code, signal) => {
    if (exiting) return;
    // 监听模式下一个进程意外退出（例如编译报错退出、端口被占用）时，带出原因并结束其它进程
    process.stderr.write(`${tag} 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}），正在停止其它进程…\n`);
    shutdown(code === 0 ? 1 : (code ?? 1));
  });
}

process.stdout.write(`${COLORS[0]}并行启动 ${children.length} 个任务，Ctrl+C 结束全部${RESET}\n`);
