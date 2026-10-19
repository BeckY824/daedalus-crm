import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * 运营台排版压测（2026-10-19 团队版主动排查）。托管版（MULTI_TENANT=1）才有运营台，环境变量照抄 playwright.hosted.config.ts，
 * 但端口、库、globalSetup 都是自己的：
 *
 *   TEAM_QA_OPS_PORT=3460 TEAM_QA_REPORT=1 E2E_SHOT_DIR=... npx playwright test --config playwright.team-qa-ops.config.ts
 *
 * globalSetup 建空库之后直接用 Prisma 灌长数据（e2e/team-qa-ops-setup.ts）。
 * 不起邮件桩：这一套只看页面，不发回复。
 *
 * Next 16 的 next dev 在同一个目录里只许起一个（.next/dev/lock）。同一份代码里别的套件正开着 dev 时，
 * 这里每 10 秒重试一次，等它放手（最多等 webServer 超时那么久）。
 */
const ROOT = __dirname;
const PORT = Number(process.env.TEAM_QA_OPS_PORT) || 3460;
const DIR = path.resolve(ROOT, "prisma/e2e-team-qa-ops");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/team-qa-ops.spec.ts",
  globalSetup: "./e2e/team-qa-ops-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "off",
    actionTimeout: 20_000,
    navigationTimeout: 180_000,
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [{
    command: `for i in $(seq 1 90); do npx next dev --port ${PORT} && exit 0; echo "[team-qa-ops] next dev 起不来（多半是别的套件占着 .next/dev/lock），10 秒后重试 $i"; sleep 10; done; exit 1`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 20 * 60_000,
    stdout: "pipe",
    env: {
      MULTI_TENANT: "1",
      CONTROL_DATABASE_URL: `file:${path.join(DIR, "control.db")}`,
      WORKSPACE_DIR: path.join(DIR, "ws"),
      DATABASE_URL: `file:${path.join(DIR, "never-used.db")}`,
      AUTH_SECRET: "e2e-hosted-secret-not-used-in-production-0123",
      ADMIN_TOKEN: "e2e-admin-token",
      SHARED_WORKSPACE: "shared",
      COOKIE_SECURE: "false",
      // 运营账号默认算测试账号：用户列表上会有一个「测试 · 运营」
      OPS_ACCOUNTS: "ops-team-qa@e2e.local",
      // 配了单价，「模型用量」那一格才显示钱（只是算数，不调模型）
      LLM_PRICE_IN: "2",
      LLM_PRICE_OUT: "8",
      SIGNUP_VERIFY: "0",
      // 假 key + 没人监听的端口：哪怕有什么误调到模型，也是立刻 ECONNREFUSED，一分钱不花
      LLM_API_KEY: "e2e-fake-key",
      LLM_BASE_URL: "http://127.0.0.1:9",
      LLM_MODEL: "e2e-fake-model",
      JEV_API_KEY: "",
    },
  }],
});
