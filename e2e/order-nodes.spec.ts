/**
 * 外贸订单（2026-10-03 外贸第 3a 块）：切到外贸模版 → 商机「转为订单」（订单 = 一笔签约，2026-10-05）→ 订单页走节点、记一笔、勾单据、填尾款 →
 * 订单一览里看得到当前节点。
 *
 * 模版要从「设置 → 业务配置」界面切：设置有进程内缓存，直接改库服务端看不到。
 * 结束时界面上切回「通用销售」（= 默认配置），再删掉那一行，库回到和原来一样；客户删掉，商机订单级联删。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";
import { 订单节点 } from "../src/lib/features";

// 订单的 12 个节点这一版不上（lib/features.ts 订单节点）：开关打开时这份用例照常跑（2026-10-06 临时打开实跑过一遍）
test.skip(!订单节点, "订单的 12 个节点这一版不上（轻量订单见 e2e/trade-order.spec.ts）");

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 客户名 = "订单测试客户";
const 商机名 = "订单测试询盘";

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
    const owner = await db.user.findFirstOrThrow({ where: { active: true } });
    const c = await db.customer.create({ data: { name: 客户名, phone: "13755550021", salesOwnerId: owner.id, channelOwnerId: owner.id } });
    const o = await db.opportunity.create({ data: { name: 商机名, customerId: c.id, amount: 7100, stage: "谈判审核", status: "OPEN", probability: 80, ownerId: owner.id } });
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
    await db.setting.deleteMany({ where: { key: "business" } });
    await db.$disconnect();
  }
});

test("外贸订单：转为订单 → 走节点、记一笔、勾单据、填尾款 → 一览里看得到", async ({ page }) => {
  // 全程控制台不许有 error / warning（订单页、比价抽屉、供应商页这些组件 console-audit 走不到）
  const 问题: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") 问题.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => 问题.push(`[pageerror] ${e.message.slice(0, 200)}`));
  await 登录(page);
  await 套预设(page, "外贸出口");

  // 外贸模版左栏才有「订单」
  await page.goto("/opportunities");
  await expect(page.locator("nav, aside").getByRole("link", { name: "订单" }).first()).toBeVisible();

  // 外贸模版下阶段换外贸叫法：谈判审核 → 寄样（存的值不变）
  await expect(page.locator(".ant-table-row", { hasText: 商机名 })).toContainText("寄样");

  // 1. 外贸下「转为订单」：订单框（金额带商机的），填订单号保存；订单 = 一笔签约（2026-10-05）
  await page.getByRole("button", { name: `${商机名} 的更多操作` }).click();
  await page.getByRole("menuitem", { name: "转为订单" }).click();
  const 框 = page.getByRole("dialog", { name: "转为订单" });
  await 框.getByLabel("订单号 / PI 号").fill("PI-NODES-1");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText(/订单 PI-NODES-1 已建好/)).toBeVisible();
  await page.goto("/orders");
  await page.getByRole("link", { name: "PI-NODES-1" }).click();
  await page.waitForURL(/\/orders\/[^/?]+$/);

  // 2. 订单页：前四步已完成，当前是第 5 步「收定金」
  await expect(page.getByRole("heading", { level: 1 })).toContainText("订单 ");
  await expect(page.locator(".ord-sum")).toContainText("5. 收定金");
  await expect(page.getByRole("button", { name: /第 5 步 收定金/ })).toHaveAttribute("aria-pressed", "true");

  // 3. 第 5 步标完成 → 当前变成第 6 步
  await page.locator(".ord-node").getByText("已完成", { exact: true }).click();
  await expect(page.locator(".ord-sum")).toContainText("6. 下单给工厂");

  // 4. 第 7 步记一笔
  await page.getByRole("button", { name: /第 7 步 生产跟进/ }).click();
  await page.getByLabel("在这一步记一笔").fill("工厂说 10-25 货好");
  await page.getByRole("button", { name: "记一笔" }).click();
  await expect(page.locator(".ord-notes")).toContainText("工厂说 10-25 货好");

  // 5. 单据：定金水单 → 已收
  const 水单 = page.locator(".ord-doc", { hasText: "定金水单" });
  await 水单.getByText("已收", { exact: true }).click();
  await expect(水单).toHaveClass(/ok/);

  // 6. 尾款实收填满 → 未收「收齐了」
  await page.getByLabel("尾款实收").fill("7100");
  await page.locator(".ord-money").first().getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.locator(".ord-sum")).toContainText("收齐了");

  // 7. 一览：这一单在，当前节点第 6 步
  await page.goto("/orders");
  const 行 = page.locator(".ant-table-row", { hasText: 客户名 });
  await expect(行).toContainText("6. 下单给工厂");
  await expect(行).toContainText("US$ 7,100");
  expect(问题, 问题.join("\n")).toEqual([]);
});
