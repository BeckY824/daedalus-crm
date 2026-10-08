import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, CLOUD_PORT, CLOUD_URL, DATA_DIR, DB, DESKTOP_TOKEN, PORT } from "./e2e-desktop/env";
const 生产模式 = process.env.E2E_PROD === "1";

/**
 * 桌面端本地模式的 e2e（上线前测试第 3 期 3.1）：
 *
 *   npm run test:desktop                 # 默认 3300 端口，云端桩 3301
 *   E2E_PORT=3500 npm run test:desktop   # 和别的工作树错开
 *
 * 默认套（playwright.config.ts）全是网页模式。DESKTOP_LOCAL=1 才有的东西——令牌自动登录、
 * 云端账号那扇门、团队两档权限的 Prisma 限定、壳每分钟问的提醒接口、更新记录——原来只有单测，
 * 而用户主要用桌面端。这一套用真的 next dev 起本地模式，壳不在（没有 Electron），壳做的两件事由用例代办：
 * 带着 DESKTOP_TOKEN 敲 /api/desktop/session、带着 x-desktop-token 问 /api/desktop/reminders。
 *
 * 和默认套完全隔离：另一个端口、另一个库（prisma/e2e-desktop.db）、另一个数据目录（prisma/e2e-desktop-data）。
 */
export default defineConfig({
  testDir: "./e2e-desktop",
  // 用例共用一个库、按「进门 → 建客户 → 删客户 → 改叫法 …」前后依赖，必须串行
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    // 同默认套：必须 localhost，用 127.0.0.1 访问 Next 16 dev 会拦掉 JS chunk、页面不水合
    baseURL: BASE_URL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        /*
          (app)/layout.tsx 按 UA 里的「Electron/」认桌面端：认出来才画更新记录、检查更新那一行，
          客户入口才指 /customers/recent。不带它测的就是「浏览器里打开本地服务」那条路，和用户手上的不是一个样。
          壳的桥（window.desktopShell 等）照样不在——那正好验「桥不在时不报错」
        */
        userAgent: `${devices["Desktop Chrome"].userAgent} Electron/38.2.0`,
        // 桌面端默认窗口（desktop/main.js），不到 1600：AI 面板默认收着
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: [
    {
      // 假云端先起：本地服务的登录页、设置页、AI、团队同步都要问它
      command: `node e2e-desktop/cloud-stub.mjs`,
      url: `${CLOUD_URL}/__stub/health`,
      reuseExistingServer: false,
      timeout: 15_000,
      env: { CLOUD_PORT: String(CLOUD_PORT) },
    },
    {
      // 先建库、写好数据目录再起 next dev（为什么不放 globalSetup 见 prepare.ts 开头）
      command: `npx tsx e2e-desktop/prepare.ts && ${生产模式 ? `npx next build && npx next start --port ${PORT}` : `npx next dev --port ${PORT}`}`,
      /*
        不能像默认套那样等 /login：本地模式下登录过云端的 /login 会 307 去自动登录，Playwright 判就绪时跟着跳，
        cookie 又不带着走，于是 /login → session → /start → /login 原地打转，等满超时。
        这个接口不走 proxy、不跳转，不带令牌回 403（算就绪）；没开 DESKTOP_LOCAL 时回 404（不算）——环境没配对就别开跑
      */
      url: `${BASE_URL}/api/desktop/reminders`,
      reuseExistingServer: false,
      timeout: 生产模式 ? 420_000 : 240_000,
      env: {
        DATABASE_URL: `file:${DB}`,
        ...(生产模式 ? { NODE_ENV: "production" } : {}),
        CRM_DATA_DIR: DATA_DIR,
        DESKTOP_LOCAL: "1",
        DESKTOP_TOKEN,
        CRM_CLOUD_URL: CLOUD_URL,
        AUTH_SECRET: "e2e-desktop-secret-not-used-in-production-0123",
        // http://localhost 下必须关，否则会话 cookie 被浏览器丢掉，表现为自动登录完又回到登录页
        COOKIE_SECURE: "false",
        // 本地模式是单租户（desktop/local-server.js 同样清掉它）
        MULTI_TENANT: "",
        // AI 只许走云端桩：本机 .env 里的 Key 一律盖掉，导入的「自动判断」也不调
        LLM_API_KEY: "",
        JEV_API_KEY: "",
      },
    },
  ],
});
