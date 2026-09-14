import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // 与 tsconfig 的 paths 对齐，否则源码里的 @/ 引用解析不了
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // 测试跑在独立的 SQLite 文件上，不碰开发库
    env: {
      DATABASE_URL: `file:${path.resolve(__dirname, "prisma/test.db")}`,
      NODE_ENV: "test",
    },
    // 用例之间共享一个数据库，必须串行，否则 beforeEach 的清库会互相打断
    fileParallelism: false,
    sequence: { concurrent: false },
    // 跑测试前先把 schema 推到测试库，套件不依赖任何手工准备
    globalSetup: ["tests/setup-db.ts"],
    testTimeout: 20000,
    /**
     * 钩子超时要单独设：默认才 10 秒，而好几个 beforeAll 要先 build-template.mjs
     * 再 npx prisma migrate diff 生成控制面 DDL。npx 冷启动就能吃掉大半——
     * 本机跑第二遍缓存热了看不出来，CI 每次都是冷的，会天天挂。
     */
    hookTimeout: 60000,
    include: ["tests/**/*.test.ts"],
  },
});
