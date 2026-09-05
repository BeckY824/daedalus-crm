/**
 * 「新建学员」里就地新建外部渠道。
 *
 * 要验的是这一步真的省掉了「先去渠道管理建、再回来重填学员」的来回：
 * 建完要立刻可选中、跟着学员一起存下去，并且在渠道管理里能查到同一条记录。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "crm@2026" };
const 戳 = String(Date.now()).slice(-6);
const 渠道名 = `就地建渠道${戳}`;
const 学员名 = `就地建学员${戳}`;

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

/** antd 关掉的下拉仍留在 DOM 里，选项必须按 listbox 的 id 圈定，否则会点到别的下拉 */
function 下拉选项(page: Page, listId: string) {
  return page
    .locator(".ant-select-dropdown")
    .filter({ has: page.locator(`#${listId}`) })
    .locator(".ant-select-item-option");
}

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

test("新建学员时可以就地建渠道，建完自动选中并同步到渠道管理", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");

  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = page.getByRole("dialog", { name: "新建学员" });
  await 弹窗.getByLabel("客户姓名").fill(学员名);
  await 弹窗.getByLabel("联系电话").fill(`139${戳}00`);
  await 弹窗.getByLabel("销售负责人").click();
  await 下拉选项(page, "salesOwnerId_list").first().click();

  // 切到「外部渠道」，此时库里一条渠道都没有
  await 弹窗.getByText("外部渠道", { exact: true }).click();
  await 弹窗.locator("#channelId").click();
  // 背景表格也是空的，所以空态断言必须限定在这个下拉里
  const 下拉 = page.locator(".ant-select-dropdown").filter({ has: page.locator("#channelId_list") });
  await expect(下拉.locator(".ant-empty-description")).toBeVisible();

  // 下拉里就该有新建入口——没有它，用户只能放弃当前这条记录跑去渠道管理
  const 新建入口 = 下拉.getByRole("button", { name: /新建外部渠道/ });
  await expect(新建入口).toBeVisible();
  await page.screenshot({ path: "test-results/走查/就地建渠道-下拉入口.png" });
  await 新建入口.click();

  const 渠道弹窗 = page.getByRole("dialog", { name: "新建外部渠道" });
  await 渠道弹窗.getByLabel("渠道姓名").fill(渠道名);
  await 渠道弹窗.getByLabel("渠道负责人").click();
  await 下拉选项(page, "quickChannel_channelOwnerId_list").first().click();
  await 渠道弹窗.getByRole("button", { name: /创\s*建/ }).click();

  // 建完必须已经选上，否则等于没省事
  await expect(渠道弹窗).toBeHidden();
  // antd v6 的选中项类名是 ant-select-content-has-value（v5 的 ant-select-selection-item 已不再用）
  await expect(弹窗.locator(".ant-select-content-has-value").filter({ hasText: 渠道名 })).toBeVisible();
  await page.screenshot({ path: "test-results/走查/就地建渠道-建完自动选中.png" });

  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(弹窗).toBeHidden();

  // 学员存下来后，推荐人就是刚建的渠道
  await expect(page.getByRole("cell", { name: 学员名, exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: 渠道名 }).first()).toBeVisible();

  // 同一条渠道要能在渠道管理里查到，不是只存在于这张表单里
  await page.goto("/channels");
  await expect(page.getByRole("cell", { name: 渠道名 })).toBeVisible();
});

test("就地建渠道时重名会被挡住，且弹窗留在原地让人改", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");

  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = page.getByRole("dialog", { name: "新建学员" });
  await 弹窗.getByText("外部渠道", { exact: true }).click();
  await 弹窗.locator("#channelId").click();
  await page.getByRole("button", { name: /新建外部渠道/ }).click();

  const 渠道弹窗 = page.getByRole("dialog", { name: "新建外部渠道" });
  await 渠道弹窗.getByLabel("渠道姓名").fill(渠道名); // 上一条用例已经建过
  await 渠道弹窗.getByLabel("渠道负责人").click();
  await 下拉选项(page, "quickChannel_channelOwnerId_list").first().click();
  await 渠道弹窗.getByRole("button", { name: /创\s*建/ }).click();

  await expect(page.getByText(`渠道「${渠道名}」已存在`)).toBeVisible();
  // 关掉就等于让用户重填一遍，必须留在原地
  await expect(渠道弹窗).toBeVisible();
});
