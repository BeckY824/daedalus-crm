import { defineConfig } from "@playwright/test";
import 桌面端 from "./playwright.desktop.config";

/**
 * 发版前排版闸门（2026-10-19，e2e-layout/）：和桌面端 e2e 同一套环境（本地模式 + 假云端 + 独立库），只换用例目录。
 * CI 的 E2E 那一步跑它（生产构建）；本机：
 *
 *   E2E_PORT=3520 npx playwright test -c playwright.layout.config.ts
 *
 * 起服务前多写一份长选项（e2e-layout/长选项.ts，10-22 排版普查）：设置有进程内缓存，只能在 prepare.ts 建库之后、next 起来之前写。
 *
 * 手机伴侣 /m 那一份在默认套里（e2e/team-qa-mobile.spec.ts，360–430 宽）。检查规则见 e2e/layout-audit.ts
 */
const [云端桩, 本地服务, ...其余] = [桌面端.webServer].flat().filter((x) => x !== undefined);
const 准备 = "npx tsx e2e-desktop/prepare.ts && ";
if (!本地服务?.command.startsWith(准备)) throw new Error("playwright.desktop.config.ts 的本地服务命令变了，长选项种子挂不上，改这里");

export default defineConfig({
  ...桌面端,
  testDir: "./e2e-layout",
  timeout: 10 * 60_000,
  webServer: [云端桩, { ...本地服务, command: `${准备}npx tsx e2e-layout/长选项.ts && ${本地服务.command.slice(准备.length)}` }, ...其余],
});
