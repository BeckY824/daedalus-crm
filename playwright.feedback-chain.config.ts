import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import path from "node:path";
import { ADMIN_TOKEN } from "./e2e-feedback-chain/env";

/**
 * 应用内反馈回复的整条链（2026-10-19）：桌面端写反馈 → 运营台在应用里回复 → 桌面端左栏红点 + 左下角提示 →
 * 打开「我的反馈」看到回复 → 接着说 → 运营台看到一整串。
 *
 * 和别的桌面端套件不同，这里的「云端」不是假云端桩，是真的托管版（MULTI_TENANT=1）：反馈落库、运营台、
 * /api/feedback/mine 的令牌校验全是真代码。两个 next dev 在同一份代码里同时起，云端那个换了构建目录（next.config.ts 的 distDir 那段）。
 *
 *   CHAIN_PORT=3480 npx playwright test -c playwright.feedback-chain.config.ts
 *   E2E_SHOT_DIR=… 时每一步截一张
 *
 * 本地服务用的是桌面端 e2e 那一套库和数据目录（e2e-desktop/prepare.ts），别和 playwright.desktop / layout 同时跑。
 * 只用本机造的测试账号，不碰正式服。
 */
const PORT = Number(process.env.CHAIN_PORT) || 3480;
// 桌面端 e2e 的常量（云端地址 = 本地端口 + 1）跟着 E2E_PORT 走：先定下来再读它们
process.env.E2E_PORT = String(PORT);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const 桌面端 = require("./playwright.desktop.config").default as PlaywrightTestConfig;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CLOUD_PORT } = require("./e2e-desktop/env") as typeof import("./e2e-desktop/env");

const ROOT = __dirname;
const DIR = path.resolve(ROOT, "prisma/e2e-feedback-chain");

type 一个服务 = Extract<NonNullable<PlaywrightTestConfig["webServer"]>, unknown[]>[number];
/** 桌面端 e2e 的第二个 webServer：prepare.ts 建库写 .cloud.json，再起本地模式的 next dev（CRM_CLOUD_URL 指向上面这个云端） */
const 本地服务 = (桌面端.webServer as 一个服务[])[1];

export default defineConfig({
  ...桌面端,
  testDir: "./e2e-feedback-chain",
  timeout: 5 * 60_000,
  webServer: [
    {
      command: `npx tsx e2e-feedback-chain/prepare-cloud.ts && npx next dev --port ${CLOUD_PORT}`,
      url: `http://127.0.0.1:${CLOUD_PORT}/login`,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: "pipe",
      env: {
        NEXT_DIST_DIR: ".next-chain-cloud",
        NEXT_TSCONFIG_PATH: "prisma/e2e-feedback-chain/tsconfig.json",
        MULTI_TENANT: "1",
        CONTROL_DATABASE_URL: `file:${path.join(DIR, "control.db")}`,
        WORKSPACE_DIR: path.join(DIR, "ws"),
        DATABASE_URL: `file:${path.join(DIR, "never-used.db")}`,
        AUTH_SECRET: "e2e-hosted-secret-not-used-in-production-0123",
        ADMIN_TOKEN,
        COOKIE_SECURE: "false",
        SIGNUP_VERIFY: "0",
        // 没配 SMTP：运营台「同时发邮件」应当置灰并说原因；不发任何邮件
        SMTP_HOST: "",
        // 假 key + 没人监听的端口：误调到模型也是立刻 ECONNREFUSED，一分钱不花
        LLM_API_KEY: "e2e-fake-key",
        LLM_BASE_URL: "http://127.0.0.1:9",
        LLM_MODEL: "e2e-fake-model",
        JEV_API_KEY: "",
        TZ: "Asia/Shanghai",
      },
    },
    本地服务,
  ],
});
