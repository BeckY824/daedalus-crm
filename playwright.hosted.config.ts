import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * 托管版的 e2e，与单租户那套完全隔离：另一个端口、另一套库、另一个 globalSetup。
 *
 *   npm run test:hosted
 *
 * 分开跑而不是并进默认套件，理由有两个：默认那 58 条验的是自部署行为，
 * 不该被 MULTI_TENANT 影响；而托管版要从「一个空系统」开始注册，
 * 和那边预置好账号的前提正相反。
 */
const ROOT = __dirname;
const PORT = 3400;
const HOSTED_DIR = path.resolve(ROOT, "prisma/e2e-hosted");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/hosted.spec.ts",
  globalSetup: "./e2e/hosted-setup.ts",
  // 用例按「注册 → 用 → 到期」的链条前后依赖，必须串行
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      MULTI_TENANT: "1",
      CONTROL_DATABASE_URL: `file:${path.join(HOSTED_DIR, "control.db")}`,
      WORKSPACE_DIR: path.join(HOSTED_DIR, "ws"),
      // 托管版里谁都不该碰默认库，给个一定不存在的路径，碰了就会炸出来
      DATABASE_URL: `file:${path.join(HOSTED_DIR, "never-used.db")}`,
      AUTH_SECRET: "e2e-hosted-secret-not-used-in-production-0123",
      ADMIN_TOKEN: "e2e-admin-token",
      // 网页版那个唯一的共享工作区，见 e2e/hosted-setup.ts
      SHARED_WORKSPACE: "shared",
      COOKIE_SECURE: "false",
      /**
       * 给一个假 key、指向本机一个没人监听的端口：
       *   - llmEnabled() 为真，首页才渲染对话面（否则走无 AI 的 Board，连输入框都没有）
       *   - 每次提问在连模型那步立刻 ECONNREFUSED，一分钱不花
       *   - 试用额度是在发起调用**之前**扣的，所以第 9 条能真验「5 次后被拦」
       */
      LLM_API_KEY: "e2e-fake-key",
      LLM_BASE_URL: "http://127.0.0.1:9",
      LLM_MODEL: "e2e-fake-model",
    },
  },
});
