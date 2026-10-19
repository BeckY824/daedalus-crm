/**
 * 排版闸门几组共用：关掉「已更新到」弹窗、切到外贸模版（订单、供应商、客户档案那几格）。
 * 走界面切：设置有进程内缓存，直接改库不生效
 */
import { expect, type Browser, type Page } from "@playwright/test";
import { 进门 } from "../e2e-desktop/helpers";

export async function 关掉弹窗(page: Page, 等 = 0) {
  const 弹窗 = page.getByRole("dialog", { name: /已更新到/ });
  if (await 弹窗.waitFor({ state: "visible", timeout: 等 || 1 }).then(() => true, () => false)) {
    await 弹窗.getByRole("button", { name: /知\s*道\s*了/ }).click();
    await expect(弹窗).toBeHidden();
  }
}

export async function 切外贸(browser: Browser) {
  const page = await browser.newPage();
  try {
    await 进门(page, "/settings?tab=business");
    if (await page.getByRole("heading", { name: "你主要做哪一类生意？" }).isVisible().catch(() => false)) {
      await page.getByRole("button", { name: /用外贸出口开始/ }).click();
      await expect(page).not.toHaveURL(/\/start/);
      await 关掉弹窗(page, 4_000);
    } else {
      await 关掉弹窗(page, 4_000);
      const 面板 = page.getByRole("tabpanel", { name: /^业务配置/ });
      await expect(面板).toBeVisible();
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      await 面板.getByRole("button", { name: "外贸出口", exact: true }).click();
      const 存 = 面板.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ });
      if (await 存.isVisible().catch(() => false)) {
        await 存.click();
        await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
      }
    }
  } finally {
    await page.close();
  }
}
