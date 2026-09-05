/**
 * AI 验收套件的配置。
 *
 * 与 playwright.config.ts 的两点关键差异：
 *   - 不配 webServer：复用已经起着的开发服务器，因此跑在**开发库**上，
 *     而不是每次重建的空 e2e 库——AI 功能需要真实的跟进记录才有东西可提炼
 *   - 只匹配 ai-acceptance.spec.ts，这份用例真的会调用中转站（慢、花钱）
 *
 * 跑法：
 *   1. npm run dev -- --port 3100
 *   2. npx playwright test --config playwright.acceptance.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "ai-acceptance.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // 单条用例可能连着做两三次 AI 往返，给足时间
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
