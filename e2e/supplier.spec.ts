/**
 * 供应商比价（2026-10-03 外贸第 3c 块）：外贸模版下商机行「供应商比价」→ 一家一行记价 →
 * 选用要写理由、最低价标出来 → 供应商页里看得到这家和它的比价记录。
 *
 * 模版从「设置 → 业务配置」界面切（设置有进程内缓存），结束时切回「通用销售」再删掉那一行；造的客户、供应商删掉。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 客户名 = "比价测试客户";
const 商机名 = "比价测试询盘";
const 供应商们 = ["比价测试甲厂", "比价测试乙厂"];

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
      /* dev 模式下第一次点击可能落空，再试 */
    }
  }
  throw new Error("登录失败");
}

async function 套预设(page: Page, 名: string) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "业务配置" }).click();
  const 面板 = page.getByRole("tabpanel", { name: "业务配置" });
  await 面板.getByRole("button", { name: 名, exact: true }).click();
  await 面板.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async () => {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: 客户名 } });
    await db.supplier.deleteMany({ where: { name: { in: 供应商们 } } });
    const owner = await db.user.findFirstOrThrow({ where: { active: true } });
    const c = await db.customer.create({ data: { name: 客户名, phone: "13755550031", salesOwnerId: owner.id, channelOwnerId: owner.id } });
    const o = await db.opportunity.create({ data: { name: 商机名, customerId: c.id, amount: 7100, stage: "方案报价", status: "OPEN", probability: 50, ownerId: owner.id } });
    await db.opportunityMoney.create({ data: { opportunityId: o.id, currency: "USD" } });
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await 登录(page);
    await 套预设(page, "通用销售");
  } finally {
    await page.close();
    const db = 连库();
    await db.customer.deleteMany({ where: { name: 客户名 } });
    await db.supplier.deleteMany({ where: { name: { in: 供应商们 } } });
    await db.setting.deleteMany({ where: { key: "business" } });
    await db.$disconnect();
  }
});

async function 加一家(page: Page, 名: string, 价: string, 结论?: string, 理由?: string) {
  await page.getByRole("button", { name: "加一家报价" }).click();
  const 框 = page.getByRole("dialog", { name: "加一家报价" });
  await 框.getByLabel("供应商").fill(名);
  await 框.getByLabel("产品").fill("LED 面板灯");
  await 框.getByLabel("出厂单价").fill(价);
  if (结论) await 框.getByText(结论, { exact: true }).click();
  if (理由) await 框.getByLabel("理由").fill(理由);
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  return 框;
}

test("供应商比价：一家一行、选用要理由、最低价标出来、供应商页看得到", async ({ page }) => {
  // 全程控制台不许有 error / warning（订单页、比价抽屉、供应商页这些组件 console-audit 走不到）
  const 问题: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") 问题.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => 问题.push(`[pageerror] ${e.message.slice(0, 200)}`));
  await 登录(page);
  await 套预设(page, "外贸出口");

  await page.goto("/opportunities");
  await page.getByRole("button", { name: `${商机名} 的更多操作` }).click();
  await page.getByRole("menuitem", { name: "供应商比价" }).click();
  const 抽屉 = page.getByRole("dialog", { name: `供应商比价 · ${商机名}` });
  await expect(抽屉).toContainText(`供应商比价 · ${商机名}`);

  // 第一家：只填价
  const 框1 = await 加一家(page, 供应商们[0], "21.3");
  await expect(框1).toBeHidden();
  await expect(抽屉).toContainText("只问了 1 家");

  // 第二家：选用但没写理由 → 拦；写了再存
  const 框2 = await 加一家(page, 供应商们[1], "19.8", "选用");
  await expect(框2).toContainText("「选用」要写一句理由");
  await 框2.getByLabel("理由").fill("价低、交期 25 天");
  await 框2.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框2).toBeHidden();

  await expect(抽屉).not.toContainText("只问了");
  const 乙 = 抽屉.locator(".ant-table-row", { hasText: 供应商们[1] });
  await expect(乙).toContainText("最低");
  await expect(乙).toContainText("价低、交期 25 天");
  await expect(乙).toHaveClass(/cmp-low/);

  // 建议报价：填汇率和毛利率，按出厂价算
  await 抽屉.getByLabel("汇率").fill("7.1");
  await 抽屉.getByLabel("目标毛利率").fill("25");
  await expect(抽屉.locator(".ant-table-row", { hasText: 供应商们[0] })).toContainText("US$ 4");

  // 供应商页
  await page.goto("/suppliers");
  await expect(page.locator(".ant-table-row", { hasText: 供应商们[1] })).toContainText("选用 1");
  await page.locator(".ant-table-row", { hasText: 供应商们[1] }).getByRole("link", { name: 供应商们[1] }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(供应商们[1]);
  await expect(page.locator(".ant-card", { hasText: "历次比价" })).toContainText(商机名);
  expect(问题, 问题.join("\n")).toEqual([]);
});
