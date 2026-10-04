/**
 * 商机赢单要问登记签约（2026-10-04 J-090）。
 *
 * 原来管道里把卡片拖进「赢单成交」，卡片直接消失（管道只取进行中的商机）、也不问登记签约；
 * 列表页阶段下拉选「赢单成交」同样一声不吭——签约漏记，数据页业绩少算。
 * 现在：拖进赢单 → 弹「登记签约」，金额带商机金额；取消也算赢单、卡片留在赢单列。
 * 列表页下拉选赢单 → 就地问一句（和「更多 → 标记赢单」同一个问话）。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

async function 登录(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill(账号.用户名);
  await page.getByPlaceholder("登录密码").fill(账号.密码);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

/** 每条用例一位客户一个商机，互不牵连 */
async function 造一单(客户名: string, 商机名: string, 金额: number) {
  const p = 连库();
  const 张三 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
  const c = await p.customer.create({ data: { name: 客户名, phone: `139${String(Date.now()).slice(-8)}`, salesOwnerId: 张三.id } });
  const o = await p.opportunity.create({ data: { name: 商机名, customerId: c.id, ownerId: 张三.id, amount: 金额, stage: "方案报价", probability: 60 } });
  await p.$disconnect();
  return { 客户id: c.id, 商机id: o.id };
}

async function 查(商机id: string, 客户id: string) {
  const p = 连库();
  const o = await p.opportunity.findUniqueOrThrow({ where: { id: 商机id } });
  const 签约 = await p.contract.findMany({ where: { customerId: 客户id } });
  await p.$disconnect();
  return { o, 签约 };
}

async function 赢单关联(商机id: string) {
  const p = 连库();
  const w = await p.contractWin.findUnique({ where: { opportunityId: 商机id } });
  await p.$disconnect();
  return w;
}

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

test.afterAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

const 赢单列 = (page: Page) => page.locator(".pipe-col", { has: page.locator(".pipe-h", { hasText: "赢单成交" }) });
const 卡 = (page: Page, 名: string) => page.locator(".pipe-card", { hasText: 名 });

test("管道：拖进赢单成交 → 弹「登记签约」、金额带商机金额；点取消 → 卡片留在赢单列，库里是赢单、没登记签约", async ({ page }) => {
  const { 客户id, 商机id } = await 造一单("赢单甲", "甲的年框", 86000);
  await 登录(page);
  await page.goto("/opportunities/pipeline");
  await 卡(page, "甲的年框").dragTo(赢单列(page));

  const 框 = page.getByRole("dialog", { name: "登记签约" });
  await expect(框).toBeVisible();
  await expect(框.getByRole("spinbutton", { name: "签约金额" })).toHaveValue("86,000");
  // 弹框开着的时候卡片已经在赢单列，不是凭空消失
  await expect(赢单列(page).locator(".pipe-card", { hasText: "甲的年框" })).toBeVisible();

  await 框.getByRole("button", { name: /取\s*消/ }).click();
  await expect(框).toBeHidden();
  await expect(赢单列(page).locator(".pipe-card", { hasText: "甲的年框" })).toBeVisible();
  await expect.poll(async () => (await 查(商机id, 客户id)).o.status).toBe("WON");
  expect((await 查(商机id, 客户id)).签约).toHaveLength(0);

  // 刷新之后还在赢单列（原来管道只取进行中的，赢了就看不见）
  await page.reload();
  await expect(赢单列(page).locator(".pipe-card", { hasText: "甲的年框" })).toBeVisible();
});

test("管道：拖进赢单成交 → 登记签约点保存 → 签约记上、金额是商机金额，卡片在赢单列", async ({ page }) => {
  const { 客户id, 商机id } = await 造一单("赢单乙", "乙的试单", 12000);
  await 登录(page);
  await page.goto("/opportunities/pipeline");
  await 卡(page, "乙的试单").dragTo(赢单列(page));

  const 框 = page.getByRole("dialog", { name: "登记签约" });
  await expect(框.getByRole("spinbutton", { name: "签约金额" })).toHaveValue("12,000");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  await expect(page.locator(".ant-message")).toContainText("签约已记录");
  await expect(赢单列(page).locator(".pipe-card", { hasText: "乙的试单" })).toBeVisible();

  await expect.poll(async () => (await 查(商机id, 客户id)).签约.length).toBe(1);
  const { o, 签约 } = await 查(商机id, 客户id);
  expect(o.status).toBe("WON");
  expect(签约[0].amount).toBe(12000);
  // 签约和赢单连着记（L-007）：之后删这笔签约，商机能退回方案报价
  expect(await 赢单关联(商机id)).toMatchObject({ contractId: 签约[0].id, prevStage: "方案报价", prevProbability: 60 });
});

test("列表：阶段下拉选赢单成交 → 先问要不要登记签约，不直接改；点取消还是进行中", async ({ page }) => {
  const { 客户id, 商机id } = await 造一单("赢单丙", "丙的追加", 5000);
  await 登录(page);
  await page.goto("/opportunities");
  const 行 = page.locator("tr.ant-table-row", { hasText: "丙的追加" });
  await 行.locator(".ant-select").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: "赢单成交" }).click();

  const 问 = page.locator(".won-ask");
  await expect(问).toBeVisible();
  await expect(问).toContainText("顺手给 赢单丙 登记一笔签约");
  await expect(问.getByRole("spinbutton", { name: "签约金额" })).toHaveValue("5,000");
  expect((await 查(商机id, 客户id)).o.status, "问话还没答，不该已经改成赢单").toBe("OPEN");

  await 问.getByRole("button", { name: /取\s*消/ }).click();
  await expect(问).toBeHidden();
  expect((await 查(商机id, 客户id)).o.status).toBe("OPEN");
});

test("列表：阶段下拉选赢单成交 → 「赢单并登记签约」→ 商机赢单、签约记上，两者连着记", async ({ page }) => {
  const { 客户id, 商机id } = await 造一单("赢单丁", "丁的大单", 30000);
  await 登录(page);
  await page.goto("/opportunities");
  const 行 = page.locator("tr.ant-table-row", { hasText: "丁的大单" });
  await 行.locator(".ant-select").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: "赢单成交" }).click();
  await page.locator(".won-ask").getByRole("button", { name: "赢单并登记签约" }).click();
  await expect(page.locator(".ant-message")).toContainText(/签约 .*30,000 已登记/);

  await expect.poll(async () => (await 查(商机id, 客户id)).o.status).toBe("WON");
  const { 签约 } = await 查(商机id, 客户id);
  expect(签约.map((x) => x.amount)).toEqual([30000]);
  expect(await 赢单关联(商机id)).toMatchObject({ contractId: 签约[0].id, prevStage: "方案报价" });
});
