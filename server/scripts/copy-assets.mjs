#!/usr/bin/env node
/**
 * 把 src 下的非 TS 资源（迁移 SQL）复制到 dist，使 `node dist/index.js` 可以独立运行。
 *
 * 背景：`tsc` 只编译 .ts，不会复制 `src/db/migrations/*.sql`；
 * 而 `migrate()` 需要这些 SQL 才能建表/升级结构。
 * `src/db/index.ts` 里做了源码目录兜底，但把 SQL 一起放进 dist 才是完整的构建产物。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const srcDir = path.join(serverRoot, 'src');
const distDir = path.join(serverRoot, 'dist');

if (!fs.existsSync(distDir)) {
  process.stderr.write('未找到 dist/，请先执行 tsc 编译。\n');
  process.exit(1);
}

let copied = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(from);
      continue;
    }
    if (!entry.name.endsWith('.sql')) continue;
    const to = path.join(distDir, path.relative(srcDir, from));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied += 1;
  }
}

walk(srcDir);
process.stdout.write(`已复制 ${copied} 个 SQL 资源到 dist/。\n`);
