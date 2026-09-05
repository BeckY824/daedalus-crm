import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/** E2E 用自己的库，绝不碰开发库与线上库 */
const E2E_DB = path.resolve(__dirname, "prisma/e2e.db");
const PORT = 3100;

/**
 * E2E_PROD=1 时改用生产构建跑（next build + next start），
 * 验的是「和线上同构的产物」而不是 dev server：
 * 生产构建的路由缓存更激进、没有开发覆盖层、AUTH_SECRET 走的是
 * 生产分支（缺失即拒绝启动）。数据仍在独立的 e2e 库上，不碰线上。
 */
const 生产模式 = process.env.E2E_PROD === "1";

export default defineConfig({
  testDir: "./e2e",
  /**
   * AI 验收套件不进默认 e2e：它真的调用中转站（慢、花钱），
   * 且依赖开发库里的真实跟进记录，而这里跑的是每次重建的空 e2e 库。
   * 跑法见 e2e/ai-acceptance.spec.ts 顶部说明。
   */
  testIgnore: "**/ai-acceptance.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  // 冒烟用例共用一个库、按业务链条前后依赖，必须串行
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    // 必须用 localhost 而不是 127.0.0.1：Next 16 的 dev server 会拦截
    // 来自「非同源」的 dev 资源请求，用 IP 访问会导致 JS chunk 全被拒、
    // 页面不水合，表现为点按钮完全没反应（排查了半天才发现在服务端日志里）
    baseURL: `http://localhost:${PORT}`,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: 生产模式
      ? `npx next build && npx next start --port ${PORT}`
      : `npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 生产模式 ? 420_000 : 180_000,
    env: {
      // Next 的 .env 不会覆盖已存在的环境变量，所以这里指的库是准的
      DATABASE_URL: `file:${E2E_DB}`,
      AUTH_SECRET: "e2e-only-secret-not-used-in-production-0123456789",
      // 用 http 访问，cookie 不能带 Secure，否则浏览器直接丢掉、表现为登录不上
      COOKIE_SECURE: "false",
      ...(生产模式 ? { NODE_ENV: "production" } : {}),
    },
  },
});
