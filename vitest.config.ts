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
      /**
       * 时区要和生产一致（Dockerfile 里是 ENV TZ=Asia/Shanghai）。
       *
       * 不钉死的话单测在 CI runner 上跑的是 UTC，而这套系统里一堆日期是按
       * **当地日历天**算的——预计签约存的是当地零点、留痕按本地渲染、
       * 「今天/明天」的判断也是本地。UTC 下这些用例要么假绿，要么像
       * tests/audit.test.ts 那条一样在本机过、一进 CI 就挂。
       * e2e 那个 job 早就显式设了 TZ，单测这边一直漏着。
       */
      TZ: "Asia/Shanghai",
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
