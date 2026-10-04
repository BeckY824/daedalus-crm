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

/*
  编辑框里的两格联动（2026-10-04 回归核对 J-087 / J-095）。规则本身有单测（opp-stage、saveOpportunity 落库），
  这里钉的是表单：人在框里改了以后，存进去的就是框里看见的那个。
*/
async function 打开编辑(page: Page, 商机名: string) {
  await page.goto(`/opportunities?keyword=${encodeURIComponent(商机名)}`);
  const 框 = page.getByRole("dialog", { name: "编辑商机" });
  await expect(async () => {
    if (!(await 框.isVisible())) await page.getByRole("button", { name: `编辑 ${商机名}` }).click();
    await expect(框).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return 框;
}
async function 下拉选(page: Page, 格: ReturnType<Page["getByLabel"]>, 项: string) {
  await 格.click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", { hasText: 项 }).first().click();
}
const 概率 = (框: ReturnType<Page["getByRole"]>) => 框.locator(".ant-slider-handle");

test("J-087 编辑框：已赢单的商机改成「已丢单」→ 阶段退一档、存进去就是丢单，刷新还是丢单", async ({ page }) => {
  const { 客户id, 商机id } = await 造一单("黄了的单", "黄了的年框", 40000);
  const p = 连库();
  await p.opportunity.update({ where: { id: 商机id }, data: { stage: "赢单成交", status: "WON", probability: 100 } });
  await p.$disconnect();
  await 登录(page);
  const 框 = await 打开编辑(page, "黄了的年框");
  await 下拉选(page, 框.getByLabel("状态"), "已丢单");
  // 当场看得见会存成什么：阶段不能还挂在赢单成交
  await expect(框.getByLabel("阶段").locator("..").locator("..")).toContainText("谈判审核");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  await expect.poll(async () => (await 查(商机id, 客户id)).o.status).toBe("LOST");
  expect((await 查(商机id, 客户id)).o.stage).toBe("谈判审核");
  // 重新打开还是丢单，不是「已保存」了却没改
  const 再 = await 打开编辑(page, "黄了的年框");
  await expect(再.getByLabel("状态").locator("..").locator("..")).toContainText("已丢单");
});

test("J-095 编辑框换阶段：手填的 75% 不被阶段默认值冲掉；没动过的跟着新阶段走", async ({ page }) => {
  const 手填 = await 造一单("手填概率", "手填七五", 20000);
  const 默认 = await 造一单("默认概率", "默认六十", 20000);
  const p = 连库();
  await p.opportunity.update({ where: { id: 手填.商机id }, data: { probability: 75 } });
  await p.$disconnect();
  await 登录(page);

  let 框 = await 打开编辑(page, "手填七五");
  await expect(概率(框)).toHaveAttribute("aria-valuenow", "75");
  await 下拉选(page, 框.getByLabel("阶段"), "谈判审核");
  await expect(概率(框)).toHaveAttribute("aria-valuenow", "75");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  await expect.poll(async () => (await 查(手填.商机id, 手填.客户id)).o.stage).toBe("谈判审核");
  expect((await 查(手填.商机id, 手填.客户id)).o.probability).toBe(75);

  // 60 是「方案报价」的默认值 = 人没动过：换到「需求确认」跟着变 40
  框 = await 打开编辑(page, "默认六十");
  await 下拉选(page, 框.getByLabel("阶段"), "需求确认");
  await expect(概率(框)).toHaveAttribute("aria-valuenow", "40");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  await expect.poll(async () => (await 查(默认.商机id, 默认.客户id)).o.probability).toBe(40);
});

/* J-211：商机页的总额原来把已赢单、已丢单的也加进去，「进行中」的数是虚的 */
test("商机列表的汇总药丸：没筛状态时只算进行中的，赢单和丢单不进总额", async ({ page }) => {
  const 戳 = String(Date.now()).slice(-6);
  const p = 连库();
  const 张三 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
  const c = await p.customer.create({ data: { name: `汇总${戳}`, phone: `137${戳}11`, salesOwnerId: 张三.id } });
  for (const [名, 金额, 状态] of [["进行中单", 1000, "OPEN"], ["赢下单", 50000, "WON"], ["丢掉单", 90000, "LOST"]] as const)
    await p.opportunity.create({ data: { name: `汇总${戳}${名}`, customerId: c.id, ownerId: 张三.id, amount: 金额, stage: 状态 === "OPEN" ? "方案报价" : 状态 === "WON" ? "赢单成交" : "谈判审核", status: 状态, probability: 50 } });
  await p.$disconnect();

  await 登录(page);
  await page.goto(`/opportunities?keyword=${encodeURIComponent(`汇总${戳}`)}`);
  const 药丸 = page.locator(".list-sum");
  await expect(药丸).toContainText("进行中 1 单");
  await expect(药丸).toContainText("1,000");
  await expect(药丸).not.toContainText("51,000");
  await expect(药丸).not.toContainText("141,000");
  // 筛了「已赢单」就是那一类的合计
  await page.goto(`/opportunities?keyword=${encodeURIComponent(`汇总${戳}`)}&status=WON`);
  await expect(药丸).toContainText("已赢单 1 单");
  await expect(药丸).toContainText("50,000");
});
