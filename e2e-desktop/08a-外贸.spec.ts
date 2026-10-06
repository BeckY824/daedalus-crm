/**
 * 桌面端个人版 · 外贸一圈（2026-10-06 测试分期 C.1）。
 *
 * 默认套的 e2e/trade-order.spec.ts 是网页模式、数据直接写库；这里在桌面本地模式下**全走界面**：
 *   切外贸 → 新建客户（电话空着只填 WhatsApp，国家 / 邮箱 / 来源）→ 新建商机（摆询盘时间、不摆概率）
 *   → 转为订单 → 客户页订单区、WhatsApp 链接 → 跟进挂订单 → 订单一览 → 导出 xlsx 两张表
 *   → 切回通用（没有订单入口、客户还在）→ 再切外贸（订单还在）
 *
 * 文件名排在 09 前面：09 把本机改成团队里的业务员，这一圈要的是一个人用的管理员。
 * 模版必须**走界面**切回去（设置有进程内缓存，见 04 的文件头），不管挂在哪一步都切回通用。
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { 读xlsx } from "../src/lib/import/xlsx";
import { 成表 } from "../src/lib/import/parse";
import { 订单, 订单节点 } from "../src/lib/features";
import { 盯控制台, 进门 } from "./helpers";

test.describe.configure({ mode: "serial" });
test.skip(!订单, "订单这一版不上");

const 戳 = String(Date.now()).slice(-5);
const 客户名 = `Ahmed桌面${戳}`;
const 商机名 = `P4 户外屏询盘${戳}`;
const 单号 = `PI-DESK-${戳}`;
const 跟进 = `工厂说 11 月 3 日出货${戳}`;
const WhatsApp = `+971 50 76${戳}`;
const wa数字 = `9715076${戳}`;

const 侧栏 = (page: Page) => page.getByRole("navigation", { name: "主导航" });

async function 套预设(page: Page, 名: "外贸出口" | "通用销售") {
  await page.goto("/settings?tab=business");
  const 面板 = page.getByRole("tabpanel", { name: /^业务配置/ });
  await expect(面板).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {});
  await 面板.getByRole("button", { name: 名, exact: true }).click();
  await 面板.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await 进门(page);
    await 套预设(page, "通用销售");
  } finally {
    await page.close();
  }
});

test("切外贸：左栏有订单；新建客户只填 WhatsApp 也能存，国家 / 邮箱 / 来源落进档案", async ({ page }) => {
  const 问题 = 盯控制台(page);
  await 进门(page);
  await 套预设(page, "外贸出口");

  await page.goto("/customers");
  await expect(侧栏(page).getByRole("link", { name: "订单", exact: true })).toBeVisible();
  await expect(侧栏(page).getByRole("link", { name: "渠道", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /新建客户/ }).click();
  const 框 = page.getByRole("dialog", { name: "新建客户" });
  await 框.getByLabel("客户姓名").fill(客户名);
  // 电话空着：外贸下没有电话可以只填 WhatsApp，就用它认人
  await expect(框.getByText("没有电话可以只填 WhatsApp 或邮箱，就用它认人")).toBeVisible();
  await 框.getByLabel("WhatsApp").fill(WhatsApp);
  await 框.getByLabel("国家").fill("阿联酋");
  await 框.getByLabel("邮箱").fill(`ahmed${戳}@gulfled.ae`);
  await 框.getByLabel("来源").fill("展会");
  await 框.getByLabel("公司").fill("Gulf LED Trading");
  // 外贸不摆推荐人、预计签约
  await expect(框.getByText("推荐人", { exact: true })).toHaveCount(0);
  await expect(框.getByText("预计签约时间", { exact: true })).toHaveCount(0);
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  await expect(page.locator("main").getByRole("link", { name: 客户名 })).toBeVisible();
  expect(问题, 问题.join("\n")).toEqual([]);
});

test("只有邮箱的客户也能建（按邮箱认人）；同邮箱换大小写再建被挡；三样都空说至少填一个", async ({ page }) => {
  const 问题 = 盯控制台(page);
  await 进门(page);
  await page.goto("/customers");
  const 名 = `Anna邮箱${戳}`;
  const 邮箱 = `anna${戳}@brightsigns.de`;

  await page.getByRole("button", { name: /新建客户/ }).click();
  let 框 = page.getByRole("dialog", { name: "新建客户" });
  await 框.getByLabel("客户姓名").fill(`空的${戳}`);
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框.getByText("电话、WhatsApp、邮箱至少填一个")).toBeVisible();
  await 框.getByLabel("客户姓名").fill(名);
  await 框.getByLabel("邮箱").fill(邮箱);
  await 框.getByLabel("国家").fill("德国");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  await expect(page.locator("main").getByRole("link", { name: 名 })).toBeVisible();

  await page.getByRole("button", { name: /新建客户/ }).click();
  框 = page.getByRole("dialog", { name: "新建客户" });
  await 框.getByLabel("客户姓名").fill(`Anna 再一次${戳}`);
  await 框.getByLabel("邮箱").fill(邮箱.toUpperCase());
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText(new RegExp(`已存在（${名}）`))).toBeVisible();
  await expect(框).toBeVisible();
  await 框.getByRole("button", { name: /取\s*消/ }).click();
  expect(问题, 问题.join("\n")).toEqual([]);
});

test("新建商机摆询盘时间、不摆概率；转为订单 → 商机标「已转订单」", async ({ page }) => {
  const 问题 = 盯控制台(page);
  await 进门(page, "/opportunities");
  await expect(page.locator(".ant-table-thead")).not.toContainText("概率");
  await page.getByRole("button", { name: /新建商机/ }).first().click();
  const 框 = page.getByRole("dialog", { name: "新建商机" });
  await 框.getByLabel("商机名称").fill(商机名);
  await 框.getByLabel("所属客户").click();
  await 框.getByLabel("所属客户").fill(客户名);
  await page.locator(".ant-select-item-option", { hasText: 客户名 }).click();
  await expect(框.getByLabel("询盘时间")).toBeVisible();
  await expect(框.getByText("成交概率")).toHaveCount(0);
  await 框.getByLabel("商机金额").fill("42000");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  const 行 = page.locator(".ant-table-row", { hasText: 商机名 });
  await expect(行).toContainText("42,000");

  await page.getByRole("button", { name: `${商机名} 的更多操作` }).click();
  await page.getByRole("menuitem", { name: "转为订单" }).click();
  const 单框 = page.getByRole("dialog", { name: "转为订单" });
  await expect(单框.getByLabel("订单金额")).toHaveValue("42,000");
  await 单框.getByLabel("订单号 / PI 号").fill(单号);
  await 单框.getByLabel("付款方式").fill("T/T 30/70");
  await 单框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText(new RegExp(`订单 ${单号} 已建好`))).toBeVisible();
  await expect(行).toContainText("已转订单");
  expect(问题, 问题.join("\n")).toEqual([]);
});

test("客户页：订单区、WhatsApp 链接、已下单；跟进挂到订单上，订单页看得到", async ({ page }) => {
  const 问题 = 盯控制台(page);
  await 进门(page, "/customers");
  await page.locator("main").getByRole("link", { name: 客户名 }).click();
  await page.waitForURL(/\/customers\/[^/?]+/);
  await page.waitForLoadState("networkidle").catch(() => {});
  const 档案 = page.locator(".rec-rail.rec-card");
  await expect(档案.locator(".rec-sec-t", { hasText: "订单" })).toBeVisible();
  await expect(档案).toContainText(单号);
  await expect(档案).toContainText("阿联酋");
  await expect(page.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute("href", `https://wa.me/${wa数字}`);
  await expect(page.locator(".rec-tags")).toContainText("已下单");

  await page.getByPlaceholder(/记一笔/).first().fill(跟进);
  await page.getByRole("button", { name: "直接记" }).click();
  const 条 = page.locator(".rec-tl-item", { hasText: 跟进 });
  await expect(条).toBeVisible();
  await 条.hover();
  await 条.getByRole("button", { name: /编辑/ }).click();
  const 跟进框 = page.getByRole("dialog");
  await 跟进框.getByLabel("关联商机 / 订单").click();
  await page.locator(".ant-select-item-option", { hasText: `订单 ${单号}` }).click();
  await 跟进框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(条.locator(".rec-tl-order")).toHaveText(`订单 ${单号}`);

  await page.locator(".rec-tl-order", { hasText: 单号 }).click();
  await page.waitForURL(/\/orders\/[^/?]+$/);
  await expect(page.locator(".ord-notes").first()).toContainText(跟进);

  await page.goto("/orders");
  const 单行 = page.locator(".ant-table-row", { hasText: 单号 });
  await expect(单行).toContainText(客户名);
  await expect(单行).toContainText("US$ 42,000");
  if (!订单节点) await expect(单行).toContainText("T/T 30/70");
  expect(问题, 问题.join("\n")).toEqual([]);
});

test("导出 xlsx：客户表带国家 / WhatsApp / 邮箱 / 来源，第二张表有挂在订单上的那条跟进", async ({ page }) => {
  await 进门(page, "/customers");
  await page.waitForLoadState("networkidle").catch(() => {});
  const [下载] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /导\s*出/ }).click()]);
  const 文件 = readFileSync((await 下载.path())!);
  const { 表头, 数据 } = 成表(读xlsx(文件));
  for (const 列 of ["国家", "WhatsApp", "邮箱", "来源"]) expect(表头, `客户表缺「${列}」列`).toContain(列);
  const 那行 = 数据.find((r) => r.includes(客户名));
  expect(那行, `导出里没有「${客户名}」`).toBeTruthy();
  expect(那行![表头.indexOf("国家")]).toBe("阿联酋");
  expect(那行![表头.indexOf("WhatsApp")]).toBe(WhatsApp);
  expect(那行![表头.indexOf("来源")]).toBe("展会");
  const 跟进表 = strFromU8(unzipSync(new Uint8Array(文件))["xl/worksheets/sheet2.xml"]);
  expect(跟进表, "第二张表里没有那条跟进").toContain(跟进);
});

test("切回通用：没有订单入口，客户和跟进都在；再切外贸，订单原样还在", async ({ page }) => {
  const 问题 = 盯控制台(page);
  await 进门(page);
  await 套预设(page, "通用销售");
  await page.goto("/customers");
  await expect(侧栏(page).getByRole("link", { name: "订单", exact: true })).toHaveCount(0);
  await page.locator("main").getByRole("link", { name: 客户名 }).click();
  await page.waitForURL(/\/customers\/[^/?]+/);
  await expect(page.locator("main")).toContainText(跟进);
  // 状态叫法跟着换回来：外贸的「已下单」不能留在通用里（F.2 走查抓到：套预设是合并，预设里没有的那几条留着外贸的）
  await expect(page.locator(".rec-tags")).toContainText("已签约");
  await expect(page.locator(".rec-tags")).not.toContainText("已下单");

  await 套预设(page, "外贸出口");
  await page.goto("/orders");
  await expect(page.locator(".ant-table-row", { hasText: 单号 })).toContainText(客户名);
  expect(问题, 问题.join("\n")).toEqual([]);
});
