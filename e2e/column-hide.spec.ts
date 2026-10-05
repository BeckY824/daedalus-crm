/**
 * 上线前第 2 期 2b · 列设置隐藏列：只是这台机器上表格少显示一列，**别的一概照常**——
 * 按那一列筛得出、导出照样带那一列、记录页照样写着。数据层的「删选项 / 改叫法 / 清空」在 tests/field-config.test.ts。
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { 连库, 清空业务数据 } from "./mock-data";
import { 成表 } from "../src/lib/import/parse";
import { 读xlsx } from "../src/lib/import/xlsx";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 戳 = String(Date.now()).slice(-5);

async function 登录(page: Page) {
  for (let i = 0; i < 3; i++) {
    await page.goto("/login");
    await page.getByPlaceholder("用户名").fill(管理员.用户名);
    await page.getByPlaceholder("登录密码").fill(管理员.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    try {
      await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
      return;
    } catch {
      /* 没水合时第一下会落空，再试 */
    }
  }
  throw new Error("登录失败");
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

let 甲 = "";
test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  const 我 = (await p.user.findFirstOrThrow({ where: { email: 管理员.用户名 } })).id;
  甲 = (await p.customer.create({ data: { name: `隐列甲${戳}`, phone: `1381${戳}01`.slice(0, 11), followStatus: "意向较高", grade: "高管", salesOwnerId: 我 } })).id;
  await p.customer.create({ data: { name: `隐列乙${戳}`, phone: `1381${戳}02`.slice(0, 11), followStatus: "跟进中", grade: "技术", salesOwnerId: 我 } });
  await p.$disconnect();
});
test.afterAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

test("隐藏「跟进状态」列（「职位」默认就藏着）：按跟进状态照样筛得出、导出照样带这两列、记录页照样写着", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");
  const 表头 = page.locator(".ant-table-thead th");
  await expect(表头.filter({ hasText: "跟进状态" })).toHaveCount(1);
  await expect(表头.filter({ hasText: "职位" })).toHaveCount(0);

  // 列设置里把「跟进状态」勾掉
  await page.getByRole("button", { name: "选择要显示的列" }).click();
  const 菜单 = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
  await 菜单.getByText("跟进状态", { exact: true }).click();
  await page.getByRole("button", { name: "选择要显示的列" }).click();
  await expect(菜单).toBeHidden();
  await expect(表头.filter({ hasText: "跟进状态" })).toHaveCount(0);

  // 筛选：列藏了，筛选栏那一格照样在、照样生效
  await page.locator(".ant-select", { hasText: "全部跟进状态" }).click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText("意向较高", { exact: true }).click();
  await expect(page).toHaveURL(/followStatus=/);
  await expect(page.locator("tr.ant-table-row")).toHaveCount(1);
  await expect(page.locator("tr.ant-table-row", { hasText: `隐列甲${戳}` })).toHaveCount(1);

  // 导出：按当前筛选导，藏起来的两列照样在文件里
  const [下载] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /导\s*出/ }).click()]);
  // 导出是 xlsx（2026-10-05）：读第一张表，和导入读法一样
  const { 表头: 头, 数据 } = 成表(读xlsx(readFileSync((await 下载.path())!)));
  expect(头).toContain("跟进状态");
  expect(头).toContain("职位");
  expect(数据).toHaveLength(1);
  const 那行 = 数据[0];
  expect([那行[头.indexOf("跟进状态")], 那行[头.indexOf("职位")]]).toEqual(["意向较高", "高管"]);

  // 记录页：和列设置无关，照样写着
  await page.goto(`/customers/${甲}`);
  await expect(page.getByText("意向较高").first()).toBeVisible();
  await expect(page.getByText("高管").first()).toBeVisible();

  // 复原列设置（存在这台机器的浏览器里，别影响后面的用例）
  await page.goto("/customers");
  await page.getByRole("button", { name: "选择要显示的列" }).click();
  await page.locator(".ant-dropdown:not(.ant-dropdown-hidden)").getByText("跟进状态", { exact: true }).click();
  await page.getByRole("button", { name: "选择要显示的列" }).click();
  await expect(表头.filter({ hasText: "跟进状态" })).toHaveCount(1);
});
