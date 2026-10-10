/**
 * 桌面端最常走的一条：建一位客户 → 记一笔跟进 → 首页的数跟着变。
 *
 * 桌面端登录过云端就有 AI，首页是对话那一版（HomeChat）：信号一行（逾期跟进 / 意向较高 / 本月签约）
 * 和开场那句「上次跟的是谁」。这些数必须是这一刻真查出来的——建完客户回首页就该变。
 */
import { test, expect, type Page } from "@playwright/test";
import { 进门 } from "./helpers";

test.describe.configure({ mode: "serial" });

const 戳 = String(Date.now()).slice(-5);
const 客户名 = `桌面王${戳}`;
const 手机号 = `1370${戳}00`.slice(0, 11);

const 信号 = (page: Page, 口径: string) => page.locator(".signal", { hasText: 口径 }).locator(".signal-v b");

test("空库首页是「开始」卡；新建一位意向较高的客户后，首页「意向较高」变成 1", async ({ page }) => {
  await 进门(page);
  await expect(page.getByRole("heading", { name: "欢迎使用 Daedalus CRM" })).toBeVisible();

  await page.goto("/customers");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByRole("button", { name: /新建客户/ }).click();
  const 框 = page.getByRole("dialog", { name: "新建客户" });
  await 框.getByLabel("客户姓名").fill(客户名);
  await 框.getByLabel("联系电话").fill(手机号);
  await 框.getByLabel("跟进状态").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText("意向较高", { exact: true }).click();
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  await expect(page.locator("main").getByRole("link", { name: 客户名 })).toBeVisible();

  await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "首页", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  // 有了业务数据，「开始」卡让位给问候 + 信号
  await expect(page.getByRole("heading", { name: "欢迎使用 Daedalus CRM" })).toHaveCount(0);
  await expect(信号(page, "意向较高")).toHaveText("1");
  await expect(信号(page, "逾期跟进")).toHaveText("0");
});

test("在记录页记一笔跟进：时间线上看得见，首页开场说「上次跟的是」他", async ({ page }) => {
  await 进门(page, "/customers");
  await page.locator("main").getByRole("link", { name: 客户名 }).click();
  await expect(page.getByRole("heading", { name: 客户名 })).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {});

  await page.getByRole("button", { name: /记录跟进/ }).first().click();
  const 框 = page.getByRole("dialog");
  await 框.getByLabel("标题").fill("桌面端首次电话");
  await 框.getByLabel("沟通内容").fill("聊了预算和交付周期");
  await 框.getByRole("button", { name: /保\s*存|确\s*定/ }).click();
  await expect(page.locator("main").getByText("聊了预算和交付周期")).toBeVisible();
  // 刷新后还在 = 真落了库
  await page.reload();
  await expect(page.locator("main").getByText("聊了预算和交付周期")).toBeVisible();

  await page.goto("/dashboard");
  await expect(page.getByRole("main").locator(".cli-welcome-s")).toContainText(`上次跟的是${客户名}`);
});

/*
  2026-10-04 回归核对 J-208：左栏顶上的搜索框原来一律写着「⌘K」，可首页的 ⌘K 是「回问答框」、记录页是「换一位」——
  标签说的和按下去的不是一回事。改成页内占着 ⌘K 时不写它；点搜索框本身永远是跳转单
*/
test("左栏搜索框：首页、记录页不写 ⌘K（那儿的 ⌘K 另有用处），列表页写；点它都是跳转单", async ({ page }) => {
  const 搜索 = page.getByRole("navigation", { name: "主导航" }).locator(".rail-search");

  await 进门(page, "/customers");
  await expect(搜索).toBeVisible();
  await expect(搜索.locator("kbd")).toHaveCount(1);

  await page.locator("main").getByRole("link", { name: 客户名 }).click();
  await expect(page.getByRole("heading", { name: 客户名 })).toBeVisible();
  await expect(搜索.locator("kbd")).toHaveCount(0);

  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.locator(".cli-input textarea").first()).toBeVisible();
  await expect(搜索.locator("kbd")).toHaveCount(0);
  await 搜索.click();
  await expect(page.locator(".cmdk")).toBeVisible();
});
