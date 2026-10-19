/**
 * 客户详情时间线：长订单号（无空格英文 + 中文混排）+ 大金额不把日期挤出右边（2026-10-19 用户 Mac 截图，0.46.21）。
 *
 * 截图里两处：「其他记录」行头的「订单 xxx」、绿色订单卡，都把右边的日期挤出了卡片。main 上 8a8bd9f / de52983 应已修好；
 * 这里照截图造数据（e2e-layout/种子.ts 灌混排订单），1024 / 1280 / 1366 / 1512 宽 × AI 栏开 / 关，毛玻璃开着，
 * 每屏跑一遍 layout-audit，再专门量时间线每一行的日期右缘不超出这一行
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { 连库, 我的id, 进门 } from "../e2e-desktop/helpers";
import { 查排版, 说问题 } from "../e2e/layout-audit";
import { 灌混排订单, 混排订单号 } from "./种子";
import { 关掉弹窗, 切外贸 } from "./外贸模版";

test.describe.configure({ mode: "serial" });
const 出处 = process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, "时间线订单") : null;

test.beforeAll(async ({ browser }) => {
  const db = 连库();
  try {
    await 灌混排订单(db, await 我的id(db));
  } finally {
    await db.$disconnect();
  }
  await 切外贸(browser);
});

/** 时间线里每一行：日期（.rec-tl-when）右缘不超过这一行的右缘，订单号那段也不超 */
const 量日期 = (page: Page) => page.evaluate(() => {
  const 坏: string[] = [];
  for (const 行 of document.querySelectorAll<HTMLElement>(".rec-tl-item .rec-tl-head")) {
    const 框 = (行.closest(".rec-tl-contract") ?? 行.closest(".rec-tl-body") ?? 行).getBoundingClientRect();
    for (const 段 of 行.querySelectorAll<HTMLElement>(".rec-tl-when, .rec-tl-order, .rec-tl-type")) {
      const r = 段.getBoundingClientRect();
      if (r.width && r.right > 框.right + 0.5) 坏.push(`${段.className}「${段.textContent?.slice(0, 30)}」右缘 ${Math.round(r.right)} > ${Math.round(框.right)}`);
    }
  }
  return 坏;
});

for (const 宽 of [1024, 1280, 1366, 1512]) {
  for (const ai of [false, true]) {
    test(`${宽} 宽 · AI 栏${ai ? "开" : "关"} · 毛玻璃：长订单号 + 大金额不把日期挤出去`, async ({ page }) => {
      await page.setViewportSize({ width: 宽, height: 800 });
      await 进门(page, "/customers/gate-mixorder");
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      await 关掉弹窗(page);
      await page.evaluate(() => document.documentElement.classList.add("glass"));
      const 栏 = page.getByRole("complementary", { name: "AI 面板" });
      if ((await 栏.isVisible().catch(() => false)) !== ai) await page.keyboard.press("Control+j");
      await expect(栏).toBeVisible({ visible: ai });
      await expect(page.locator(".rec-tl-order", { hasText: 混排订单号 }).first()).toBeVisible();
      const 卡 = page.locator(".rec-tl-contract", { hasText: 混排订单号 }).first();
      await expect(卡).toBeVisible();
      await expect(卡).toContainText("123,123,121");
      // 窄屏 + AI 栏开时时间线在首屏下面：滚到订单卡，截图里看得见那两行
      await 卡.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      if (出处) { mkdirSync(出处, { recursive: true }); await page.screenshot({ path: path.join(出处, `${宽}-AI${ai ? "开" : "关"}.png`) }); }
      const 问题 = await 查排版(page, { 忽略: [".ant-message", ".ant-notification", "nextjs-portal"] });
      expect(说问题(问题), `${宽} 宽 · AI 栏${ai ? "开" : "关"}`).toBe("");
      expect(await 量日期(page)).toEqual([]);
    });
  }
}
