import { defineConfig } from "@playwright/test";
import 桌面端 from "./playwright.desktop.config";

/**
 * 发版前排版闸门（2026-10-19，e2e-layout/）：和桌面端 e2e 同一套环境（本地模式 + 假云端 + 独立库），只换用例目录。
 * CI 的 E2E 那一步跑它（生产构建）；本机：
 *
 *   E2E_PORT=3520 npx playwright test -c playwright.layout.config.ts
 *
 * 手机伴侣 /m 那一份在默认套里（e2e/team-qa-mobile.spec.ts，360–430 宽）。检查规则见 e2e/layout-audit.ts
 */
export default defineConfig({
  ...桌面端,
  testDir: "./e2e-layout",
  timeout: 10 * 60_000,
});
