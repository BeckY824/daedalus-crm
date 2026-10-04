/**
 * 表单弹框开好以后光标在第一格（2026-10-03 走查：「手动录一位」打开后焦点在右上角的关闭按钮上）。
 * antd 6 开场动画走完会把焦点交给框里第一个能聚焦的东西——关闭按钮；修法见 lib/modal-focus.ts。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据, 造模拟数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await 造模拟数据(p);
  await p.$disconnect();
});

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

/** 焦点在弹框正文里的一个打字格子上（不是关闭按钮、不是框本身） */
async function 光标在第一格(page: Page, 哪个: string) {
  await expect(page.locator(".ant-modal-container").last()).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const a = document.activeElement as HTMLElement | null;
          if (!a?.closest(".ant-modal-body")) return `焦点在 ${a?.className || a?.tagName}`;
          return a.matches("input, textarea") ? "ok" : `焦点在 ${a.tagName}`;
        }),
      { message: `${哪个}：开好以后光标该在第一格` },
    )
    .toBe("ok");
}

test("新建客户 / 商机 / 线索 / 渠道：弹框开好光标就在第一格，直接能打字", async ({ page }) => {
  await 登录(page);
  for (const [路, 名] of [["/customers", "新建客户"], ["/opportunities", "新建商机"], ["/leads", "新建线索"], ["/channels", "新建渠道"]] as const) {
    await page.goto(路);
    await page.locator(".page-head-a button.ant-btn-primary").first().click();
    await 光标在第一格(page, 名);
    await page.keyboard.press("Escape");
    await expect(page.locator(".ant-modal-container")).toHaveCount(0);
  }
});

test("客户记录页：新建任务的弹框开好光标就在第一格", async ({ page }) => {
  await page.setViewportSize({ width: 1960, height: 900 });
  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");
  await page.locator(".ant-table-row .link-strong").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);
  await page.getByRole("button", { name: /新建任务/ }).first().click();
  await 光标在第一格(page, "新建任务");
});

/* J-206 补：文档点名的联系人弹框没覆盖；以及「首项聚焦」撞上就地建渠道——动画那 200ms 里人已经点开的下拉被拽回第一格、当场收起 */
test("联系人页「添加联系人」：开好光标在第一个打字格（第一格是挑客户的下拉，不算）", async ({ page }) => {
  await 登录(page);
  await page.goto("/contacts");
  await page.getByRole("button", { name: /添加联系人/ }).click();
  await 光标在第一格(page, "添加联系人");
});

test("弹框还在开场动画时就点开一个下拉：动画走完不把焦点拽回第一格，下拉还开着", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByRole("button", { name: /新建客户/ }).click();
  const 框 = page.getByRole("dialog", { name: "新建客户" });
  // 不等动画：一出来就点「销售负责人」
  await 框.getByLabel("销售负责人").click();
  const 下拉 = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").filter({ has: page.locator("#salesOwnerId_list") });
  await expect(下拉).toBeVisible();
  await page.waitForTimeout(800); // 开场动画走完、afterOpenChange 已经跑过
  await expect(下拉).toBeVisible();
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("salesOwnerId");
});
