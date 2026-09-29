import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 每个测试文件使用独立的 SQLite 文件，可以并行；这里仍串行以保证日志清晰
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
