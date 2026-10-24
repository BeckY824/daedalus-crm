import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { ENT_E2E_DB as E2E_DB } from "./e2e-enterprise/env";

/**
 * 企业版导入的 e2e：CRM_ENTERPRISE=1，自己的库和端口，库里先放好测试机那套（样例的在职账号 + 一家已有客户）。
 *
 *   npm run test:enterprise
 *
 * 不并进默认套件：企业版的种子只建管理员，和默认那套预置的账号不一样；默认那 58 条也不该在企业版开关下跑。
 * E2E_REUSE_BUILD=1 且已有生产构建时直接 next start，不再 build 一遍（CI 里接在默认套件后面，复用它的构建）。
 * 企业版开关是运行时读的（src/lib/enterprise/switch.ts），所以复用不带开关的构建没问题。
 */
const ROOT = __dirname;
const PORT = Number(process.env.ENT_E2E_PORT) || 3130;
const 生产模式 = process.env.E2E_PROD === "1";
// 先建库再起服务（为什么不放 globalSetup 见 e2e-enterprise/prepare.ts 开头）
const 建库 = "npx tsx e2e-enterprise/prepare.ts";
const 复用构建 = 生产模式 && process.env.E2E_REUSE_BUILD === "1" && existsSync(path.resolve(ROOT, ".next/BUILD_ID"));

export default defineConfig({
  testDir: "./e2e-enterprise",
  // 导入 → 再导 → 撤回 是一条链，前后依赖，必须串行
  fullyParallel: false,
  workers: 1,
  // 不重试：库不在两次之间重建，重试会从导了一半的库接着跑，红得更莫名其妙
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
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
    command: 复用构建
      ? `${建库} && npx next start --port ${PORT}`
      : 生产模式
        ? `${建库} && npx next build && npx next start --port ${PORT}`
        : `${建库} && npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 生产模式 && !复用构建 ? 420_000 : 180_000,
    env: {
      DATABASE_URL: `file:${E2E_DB}`,
      CRM_ENTERPRISE: "1",
      AUTH_SECRET: "e2e-only-secret-not-used-in-production-0123456789",
      COOKIE_SECURE: "false",
      TZ: "Asia/Shanghai",
      // 不调模型：认列走内置规则，结果不随模型抖
      LLM_API_KEY: "",
      JEV_API_KEY: "",
      CRM_RESEARCH_CHANNEL: "mock",
      ...(生产模式 ? { NODE_ENV: "production" } : {}),
    },
  },
});
