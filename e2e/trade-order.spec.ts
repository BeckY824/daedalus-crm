/**
 * 外贸客户的建议（2026-10-05，并进 0.46.15）：切到外贸模版之后——
 *   左栏：商机和跟进中间有「订单」，没有渠道、联系人
 *   商机：不摆概率、加权预测，摆询盘时间；「转为订单」打开订单框（金额币种从商机带），存下来商机标「已转订单」
 *   客户页：「签约」那一节叫「订单」，一行是订单号 · 金额、确认日 · 付款方式 · 供应商；不摆推荐关系、预计签约；
 *           档案里有国家 / WhatsApp / 邮箱，WhatsApp 一点开 wa.me
 *   跟进：「关联商机 / 订单」选上订单号，订单页列着这条
 *   订单一览：客户、订单号、付款方式、供应商、订单确认时间
 *
 * 模版从「设置 → 业务配置」界面切（设置有进程内缓存，直接改库服务端看不到），结束切回通用销售、删掉那一行。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";
import { 订单, 订单节点 } from "../src/lib/features";

test.skip(!订单, "订单这一版不上");

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 客户名 = "外贸建议测试客户";
const 商机名 = "Chicken breast IQF 10kg";

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
    await db.supplier.deleteMany({ where: { name: "临沂测试食品厂" } });
    const owner = await db.user.findFirstOrThrow({ where: { active: true } });
    const c = await db.customer.create({ data: { name: 客户名, phone: "998901230021", salesOwnerId: owner.id, channelOwnerId: owner.id } });
    await db.customerExtra.create({ data: { customerId: c.id, country: "乌兹别克斯坦", whatsapp: "+998 90 123 0021", email: "buyer@tb.uz" } });
    const o = await db.opportunity.create({ data: { name: 商机名, customerId: c.id, amount: 28000, stage: "方案报价", status: "OPEN", probability: 60, ownerId: owner.id } });
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
    await db.supplier.deleteMany({ where: { name: "临沂测试食品厂" } });
    await db.setting.deleteMany({ where: { key: "business" } });
    await db.$disconnect();
  }
});

test("外贸：转为订单 → 客户页订单区 → 跟进挂订单 → 订单一览", async ({ page }) => {
  const 问题: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") 问题.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => 问题.push(`[pageerror] ${e.message.slice(0, 200)}`));
  await 登录(page);
  await 套预设(page, "外贸出口");

  // 左栏：有订单，没有渠道、联系人
  await page.goto("/opportunities");
  const 左栏 = page.locator("nav, aside").first();
  await expect(左栏.getByRole("link", { name: "订单" })).toBeVisible();
  await expect(左栏.getByRole("link", { name: "渠道" })).toHaveCount(0);
  await expect(左栏.getByRole("link", { name: "联系人" })).toHaveCount(0);

  // 商机：不摆概率、加权预测；摆询盘时间
  await expect(page.locator(".ant-table-thead")).not.toContainText("概率");
  await expect(page.locator(".ant-table-thead")).toContainText("询盘时间");
  await expect(page.locator(".list-sum")).not.toContainText("加权预测");

  // 转为订单：订单框，金额带过来，填订单号、付款方式、新供应商
  await page.getByRole("button", { name: `${商机名} 的更多操作` }).click();
  await page.getByRole("menuitem", { name: "转为订单" }).click();
  const 框 = page.getByRole("dialog", { name: "转为订单" });
  await expect(框.getByLabel("订单金额")).toHaveValue("28,000");
  await 框.getByLabel("订单号 / PI 号").fill("PI-E2E-01");
  await 框.getByLabel("付款方式").fill("T/T 30/70");
  await 框.getByLabel("供应商").fill("临沂测试食品厂");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText(/订单 PI-E2E-01 已建好/)).toBeVisible();
  await expect(page.locator(".ant-table-row", { hasText: 商机名 })).toContainText("已转订单");

  // 客户页：订单区、档案里的外贸几格；没有推荐关系、预计签约
  await page.locator(".ant-table-row", { hasText: 商机名 }).getByRole("link", { name: 客户名 }).click();
  await page.waitForURL(/\/customers\/[^/?]+/);
  const 档案 = page.locator(".rec-rail.rec-card");
  await expect(档案.locator(".rec-sec-t", { hasText: "订单" })).toBeVisible();
  await expect(档案).toContainText("PI-E2E-01");
  await expect(档案).toContainText("T/T 30/70 · 临沂测试食品厂");
  await expect(档案).toContainText("乌兹别克斯坦");
  await expect(档案).not.toContainText("推荐关系");
  await expect(档案).not.toContainText("预计签约");
  await expect(page.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute("href", "https://wa.me/998901230021");
  await expect(page.locator(".rec-tags")).toContainText("已下单");

  // 记跟进挂到订单上
  await page.getByPlaceholder(/记一笔/).first().fill("工厂说 10 月 25 日货好");
  await page.getByRole("button", { name: "直接记" }).click();
  await expect(page.locator(".rec-tl-item", { hasText: "工厂说 10 月 25 日货好" })).toBeVisible();
  await page.locator(".rec-tl-item", { hasText: "工厂说 10 月 25 日货好" }).hover();
  await page.locator(".rec-tl-item", { hasText: "工厂说 10 月 25 日货好" }).getByRole("button", { name: /编辑/ }).click();
  const 跟进框 = page.getByRole("dialog");
  await 跟进框.getByLabel("关联商机 / 订单").click();
  await page.locator(".ant-select-item-option", { hasText: "订单 PI-E2E-01" }).click();
  await 跟进框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.locator(".rec-tl-item", { hasText: "工厂说 10 月 25 日货好" }).locator(".rec-tl-order")).toHaveText("订单 PI-E2E-01");

  // 订单页：信息 + 挂着的跟进；再记一笔
  await page.locator(".rec-tl-order", { hasText: "PI-E2E-01" }).click();
  await page.waitForURL(/\/orders\/[^/?]+$/);
  await expect(page.locator(".ord-notes").first()).toContainText("工厂说 10 月 25 日货好");
  // 节点开着时订单页是节点那一套（e2e/order-nodes.spec.ts 走它），挂在整单上的跟进在「整单的记录」里——上面那句已经验过
  if (!订单节点) {
    await page.getByLabel("在这张订单上记一笔").fill("订舱了，船期 11/2");
    await page.getByRole("button", { name: /记\s*下/ }).click();
    await expect(page.locator(".ord-notes")).toContainText("订舱了，船期 11/2");
  }

  // 订单一览：客户要的几列（节点版一览里这三列收在「列」里）
  await page.goto("/orders");
  const 头 = page.locator(".ant-table-thead");
  for (const 列 of 订单节点 ? ["订单号", "客户"] : ["订单号", "客户", "付款方式", "供应商", "订单确认时间"]) await expect(头).toContainText(列);
  const 行 = page.locator(".ant-table-row", { hasText: "PI-E2E-01" });
  await expect(行).toContainText(客户名);
  await expect(行).toContainText("US$ 28,000");
  if (!订单节点) await expect(行).toContainText("临沂测试食品厂");
  expect(问题, 问题.join("\n")).toEqual([]);
});
