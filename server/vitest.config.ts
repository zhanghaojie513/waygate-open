import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    // 单线程：本项目测试都是纯函数级、毫秒量级，并行无收益；
    // 且并行 worker 会在某些沙箱文件系统代理下触发 EPERM（见 pitfalls.jsonl）。
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
  },
});
