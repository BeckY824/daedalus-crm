import { defineConfig } from "@playwright/test";
import path from "node:path";
import 网页 from "./playwright.config";

/**
 * 网页版 vs 桌面端截图对比（2026-10-24，e2e-parity/）。
 *
 * 企业版的网页和连同一台服务器的 Mac / Windows 桌面端要长得一样。桌面端连服务器时页面就是这台服务器出的，
 * 差别只在壳：UA 带 "Electron/"（(app)/layout.tsx 据此给 shell-desktop），Windows 上 preload 再挂 html.os-win。
 * 所以这里起一份普通（非本地模式）服务器，开企业版开关，用四种浏览器身份各看一遍同一批页面，逐块比像素。
 *
 *   E2E_PORT=3110 npx playwright test -c playwright.parity.config.ts
 *
 * 结果写进 E2E_SHOT_DIR（默认 test-results/parity）：报告.md、报告.json，差了的那块存「网页 / 桌面 / 差」三张图。
 * 用自己的库（prisma/e2e-parity.db），和默认 e2e 同一个目录里跑也不会互相删库
 */
const PORT = Number(process.env.E2E_PORT) || 3110;

export default defineConfig({
  ...网页,
  testDir: "./e2e-parity",
  testIgnore: [],
  globalSetup: "./e2e-parity/global-setup.ts",
  timeout: 20 * 60_000,
  // 关子像素抗锯齿：Linux CI 上 Windows 桌面端那批按钮 / 链接的字是灰度抗锯齿、网页是彩色（LCD）抗锯齿，
  // 同一个字差出 0.5–0.7% 像素（10-25 客户记录页三宽都红）。这是排版合成层的差别，不是界面差别；全用灰度只比长相
  use: { ...网页.use, baseURL: `http://localhost:${PORT}`, launchOptions: { args: ["--disable-lcd-text"] } },
  webServer: {
    ...(网页.webServer as object),
    command: process.env.E2E_PROD === "1" ? `npx next build && npx next start --port ${PORT}` : `npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    env: {
      ...(网页.webServer as { env: Record<string, string> }).env,
      DATABASE_URL: `file:${path.resolve(__dirname, "prisma/e2e-parity.db")}`,
      CRM_ENTERPRISE: "1",
    },
  },
});
