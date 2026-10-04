/**
 * 桌面端改叫法：「客户」改成「学员」后左栏、列表页、新建框跟着变；改回去也跟着变。
 *
 * 必须**走界面改回去**，不能事后删 Setting 行：设置走进程内缓存（lib/settings.ts），
 * 从外面改库跑着的服务看不见，后面按「客户」定位的用例会全红（默认套 2026-09-16 栽过）。
 */
import { test, expect, type Page } from "@playwright/test";
import { 进门 } from "./helpers";

test.describe.configure({ mode: "serial" });

async function 改客户名词(page: Page, 名词: string) {
  await page.goto("/settings?tab=business");
  const 面板 = page.getByRole("tabpanel", { name: /^业务配置/ });
  await expect(面板.getByLabel("客户叫什么")).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {});
  await 面板.getByLabel("客户叫什么").fill(名词);
  await 面板.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible();
}

const 侧栏 = (page: Page) => page.getByRole("navigation", { name: "主导航" });

test("「客户」改叫「学员」：左栏、列表标题、新建框都跟着变；改回去全复原", async ({ page }) => {
  await 进门(page);
  try {
    await 改客户名词(page, "学员");

    await page.goto("/customers");
    await expect(侧栏(page).getByRole("link", { name: "学员", exact: true })).toBeVisible();
    await expect(侧栏(page).getByRole("link", { name: "客户", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "学员", exact: true })).toBeVisible();

    await page.getByRole("button", { name: /新建学员/ }).click();
    const 框 = page.getByRole("dialog", { name: "新建学员" });
    await expect(框).toBeVisible();
    // 框里用到名词的地方跟着变（推荐人那一格、备注的提示）。
    // 「客户姓名」「客户决策状态」两个标签是写死的、不跟着变——发现的问题，记在汇报里，这里先不钉
    await expect(框.getByText("已有学员", { exact: true })).toBeVisible();
    await expect(框.getByPlaceholder("学员背景、意向、注意事项…")).toBeVisible();
    await 框.getByRole("button", { name: /取\s*消/ }).click();
  } finally {
    // 不管上面挂在哪一步都改回去（见文件头）
    await 改客户名词(page, "客户");
  }

  await page.goto("/customers");
  await expect(侧栏(page).getByRole("link", { name: "客户", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /新建客户/ })).toBeVisible();
});
