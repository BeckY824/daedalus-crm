/**
 * 网页版的外壳要和桌面端一个样子（2026-10-24，企业版是网页版）：
 *   左栏顶上是同一个搜索框，不再是标志；
 *   产品名改由标签页标题来认——网页的标题跟着当前页（「客户 · Daedalus CRM」），
 *   桌面端窗口标题跟着 document.title，保持产品名不动。
 *
 * 换页必须走客户端导航（点左栏）：Next 的元数据是流式补进 <head> 的，换页后会把标题写回根布局的
 * 「Daedalus CRM」——第一版只在 effect 里设一次，goto 整页加载偶尔是对的，点左栏就被盖回去了。
 */
import { test, expect, type Page } from "@playwright/test";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

async function 登录(page: Page) {
  await page.goto("/login");
  const 提示 = page.locator(".ant-alert");
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(账号.用户名);
    await page.getByPlaceholder("登录密码").fill(账号.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return;
      if (await 提示.isVisible().catch(() => false)) throw new Error("登录失败");
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录没反应");
}

const 左栏 = (page: Page) => page.getByRole("navigation", { name: "主导航" });

test.describe("网页版", () => {
  test("左栏顶上是搜索框，标签页标题跟着当前页走", async ({ page }) => {
    await 登录(page);
    await expect(左栏(page).getByRole("button", { name: /^搜索/ })).toBeVisible();
    await expect(左栏(page).getByRole("link", { name: "Daedalus CRM" })).toHaveCount(0);
    await expect(page).toHaveTitle("首页 · Daedalus CRM");

    await 左栏(page).getByRole("link", { name: /^客户/ }).first().click();
    await page.waitForURL(/\/customers/);
    await expect(page).toHaveTitle("客户 · Daedalus CRM");
    // 多等一会儿：流式元数据晚到时会把标题写回去，要看它是不是又被改回来了
    await page.waitForTimeout(1500);
    await expect(page).toHaveTitle("客户 · Daedalus CRM");

    await 左栏(page).getByRole("link", { name: /^商机/ }).first().click();
    await page.waitForURL(/\/opportunities/);
    await expect(page).toHaveTitle("商机 · Daedalus CRM");
  });

  test("认不出的页不碰标题，留给页面自己", async ({ page }) => {
    await 登录(page);
    await page.goto("/没有这一页");
    await expect(page).toHaveTitle("没有找到这个页面 · Daedalus CRM");
  });
});

test.describe("桌面端", () => {
  test.use({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Electron/38.0.0 Safari/537.36" });

  test("窗口标题保持产品名，左栏顶上同一个搜索框", async ({ page }) => {
    await 登录(page);
    await expect(左栏(page).getByRole("button", { name: /^搜索/ })).toBeVisible();
    await 左栏(page).getByRole("link", { name: /^客户/ }).first().click();
    await page.waitForURL(/\/customers/);
    await page.waitForTimeout(1500);
    await expect(page).toHaveTitle("Daedalus CRM");
  });
});
