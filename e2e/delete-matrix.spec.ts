/**
 * 删除矩阵（上线前第 2 期 2a）的界面那一半：每一种删法至少一条，走真确认框，看它说清会一起删什么、用工作区叫法。
 * 数据层每一格怎么变在 tests/delete-matrix.test.ts；删单个客户、联系人只移出 / 彻底删除 / 挂到别人
 * 已在 e2e/delete-customer.spec.ts、e2e/contact-detach.spec.ts，这里补其余几行。
 *
 * 每条用例自己造数据（不靠别的 spec 留下的）。改了叫法的那条在 finally 里改回「客户」，afterAll 再删一次兜底。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";

const 管理员 = { 用户名: "admin", 密码: "admin123" };

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
      /* dev 模式没水合时第一下会落空，再试 */
    }
  }
  throw new Error("登录失败");
}

async function 改客户名词(page: Page, 名词: string) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "业务配置" }).click();
  const 面板 = page.getByRole("tabpanel", { name: "业务配置" });
  await 面板.getByLabel("客户叫什么").fill(名词);
  await 面板.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
}

/** 就地确认（InlineConfirm）：点平时那颗键 → 那一行变成问句 + 「删除」 */
function 就地确认(page: Page) {
  return page.locator(".inlc-ask");
}

const 戳 = String(Date.now()).slice(-5);
let 我 = "";

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.importBatch.deleteMany();
  我 = (await p.user.findFirstOrThrow({ where: { email: 管理员.用户名 } })).id;
  await p.$disconnect();
});

test.afterAll(async () => {
  const p = 连库();
  await p.setting.deleteMany({ where: { key: "business" } });
  await 清空业务数据(p);
  await p.importBatch.deleteMany();
  await p.$disconnect();
});

test("删客户（批量 3 位）+ 撤销导入批次：叫「学员」时确认框写学员、列全一起删的；联系人进未归属", async ({ page }) => {
  const p = 连库();
  const 名 = ["批删甲", "批删乙", "批删丙"].map((n) => `${n}${戳}`);
  for (const [i, n] of 名.entries()) {
    const c = await p.customer.create({ data: { name: n, phone: `1381${戳}${i}`.slice(0, 11), salesOwnerId: 我 } });
    await p.followUp.create({ data: { customerId: c.id, ownerId: 我, type: "PHONE", title: "", content: "聊了", status: "已完成", occurredAt: new Date() } });
    if (i < 2) await p.contact.create({ data: { customerId: c.id, name: `${n}的联系人`, phone: `1391${戳}${i}`.slice(0, 11) } });
  }
  await p.customer.create({ data: { name: `不删的${戳}`, phone: `1382${戳}0`.slice(0, 11), salesOwnerId: 我 } });
  // 一批导入（两位新建），等下在设置页撤
  const 导 = [`导入甲${戳}`, `导入乙${戳}`];
  const 批 = await p.importBatch.create({ data: { userId: 我, userName: "管理员", fileName: `名单${戳}.csv`, created: 2 } });
  for (const [i, n] of 导.entries()) {
    const c = await p.customer.create({ data: { name: n, phone: `1383${戳}${i}`.slice(0, 11), salesOwnerId: 我 } });
    await p.importRow.create({ data: { batchId: 批.id, customerId: c.id, kind: "create", writtenAt: c.updatedAt } });
  }
  await p.$disconnect();

  await 登录(page);
  await 改客户名词(page, "学员");
  try {
    await page.goto("/customers");
    for (const n of 名) await page.locator("tr.ant-table-row", { hasText: n }).getByRole("checkbox").check();
    await page.getByRole("button", { name: /^delete 删\s*除$|^删\s*除$/ }).click();

    const 框 = page.getByRole("dialog");
    await expect(框).toContainText(`确认删除 ${名.join("、")} 这 3 位学员？`);
    await expect(框).toContainText("会一起删掉：3 条跟进记录");
    await expect(框).toContainText("2 位联系人不删，留在联系人页，写「未归属」");
    await expect(框).toContainText("删除后不能恢复");
    await expect(框).not.toContainText("客户");
    await 框.getByRole("button", { name: /删\s*除/ }).click();
    await expect(page.locator(".ant-message")).toContainText("已删除 3 位学员，2 位联系人留在联系人页");
    for (const n of 名) await expect(page.locator("tr.ant-table-row", { hasText: n })).toHaveCount(0);
    await expect(page.locator("tr.ant-table-row", { hasText: `不删的${戳}` })).toHaveCount(1);

    await page.goto("/contacts");
    await expect(page.locator("tr.ant-table-row", { hasText: `${名[0]}的联系人` })).toContainText("未归属");
    await expect(page.locator("tr.ant-table-row", { hasText: `${名[1]}的联系人` })).toContainText("未归属");

    // 撤销导入批次：确认说清删几位、用学员这个叫法
    await page.goto("/settings");
    await page.getByText("导入记录", { exact: true }).click();
    await expect(page.getByText(`名单${戳}.csv`)).toBeVisible();
    await page.getByRole("button", { name: /撤\s*销/ }).first().click();
    const 气泡 = page.locator(".ant-popover:not(.ant-popover-hidden)");
    await expect(气泡).toContainText("会删掉这一批新建的 2 位学员");
    await 气泡.getByRole("button", { name: /撤\s*销/ }).click();
    await expect(page.getByRole("dialog", { name: "已撤销这一批" })).toContainText("删掉 2 条", { timeout: 20_000 });
    await page.goto("/customers");
    for (const n of 导) await expect(page.locator("tr.ant-table-row", { hasText: n })).toHaveCount(0);
  } finally {
    await 改客户名词(page, "客户");
  }
});

test("删商机：确认框说关联几条跟进、是赢单的；删了点撤销回来", async ({ page }) => {
  const p = 连库();
  const c = await p.customer.create({ data: { name: `商机客户${戳}`, phone: `1384${戳}0`.slice(0, 11), salesOwnerId: 我 } });
  const o = await p.opportunity.create({ data: { customerId: c.id, ownerId: 我, name: `年框${戳}`, amount: 50000, stage: "赢单成交", status: "WON", probability: 100 } });
  await p.followUp.create({ data: { customerId: c.id, ownerId: 我, opportunityId: o.id, type: "PHONE", title: "", content: "谈年框", status: "已完成", occurredAt: new Date() } });
  await p.$disconnect();

  await 登录(page);
  await page.goto("/opportunities");
  await page.getByRole("button", { name: `删除 年框${戳}` }).click();
  const 框 = page.getByRole("dialog");
  await expect(框).toContainText(`删除商机「年框${戳}」？`);
  await expect(框).toContainText("有 1 条跟进记录关联着它");
  await expect(框).toContainText("已经赢单的商机");
  await 框.getByRole("button", { name: /删\s*除/ }).click();
  const 提示 = page.locator(".ant-message", { hasText: `已删除「年框${戳}」` });
  await expect(提示).toBeVisible();
  await expect(page.locator("tr.ant-table-row", { hasText: `年框${戳}` })).toHaveCount(0);
  await 提示.getByRole("button", { name: /撤\s*销/ }).click();
  await expect(page.locator(".ant-message")).toContainText(`「年框${戳}」回来了`);
  await expect(page.locator("tr.ant-table-row", { hasText: `年框${戳}` })).toHaveCount(1);
});

test("删跟进（顺带建了待办的提醒）：就地确认说「连同它的待办」；删了待办也没了，点撤销都回来", async ({ page }) => {
  const p = 连库();
  const c = await p.customer.create({ data: { name: `跟进客户${戳}`, phone: `1385${戳}0`.slice(0, 11), salesOwnerId: 我 } });
  const 到点 = new Date(Date.now() + 2 * 86400000);
  await p.followUp.create({ data: { customerId: c.id, ownerId: 我, type: "REMIND", title: "", content: `周五回电${戳}`, status: "待处理", occurredAt: new Date(), dueAt: 到点 } });
  await p.task.create({ data: { customerId: c.id, ownerId: 我, title: `周五回电${戳}`, dueAt: 到点 } });
  await p.$disconnect();

  await 登录(page);
  await page.goto(`/customers/${c.id}`);
  const 那条 = page.locator(".rec-tl-item", { hasText: `周五回电${戳}` });
  const 待办 = page.locator(".rec-task", { hasText: `周五回电${戳}` });
  await expect(待办).toHaveCount(1);
  await 那条.hover();
  await 那条.getByRole("button", { name: "删除跟进" }).click();
  await expect(就地确认(page)).toContainText("连同它的待办一起删？");
  await 就地确认(page).getByRole("button", { name: "删除" }).click();
  const 提示 = page.locator(".ant-message", { hasText: "已删除这条跟进" });
  await expect(提示).toBeVisible();
  await expect(那条).toHaveCount(0);
  await expect(待办).toHaveCount(0);
  await 提示.getByRole("button", { name: /撤\s*销/ }).click();
  await expect(page.locator(".ant-message")).toContainText("这条跟进回来了");
  await expect(那条).toHaveCount(1);
  await expect(待办).toHaveCount(1);
});

test("删签约：确认框说清金额、会退回哪个赢单商机、状态退到哪一档；删完提示退回了几个商机", async ({ page }) => {
  const p = 连库();
  const c = await p.customer.create({ data: { name: `签约客户${戳}`, phone: `1386${戳}0`.slice(0, 11), salesOwnerId: 我, followStatus: "已签约" } });
  const o = await p.opportunity.create({ data: { customerId: c.id, ownerId: 我, name: `试单${戳}`, amount: 8800, stage: "赢单成交", status: "WON", probability: 100 } });
  const k = await p.contract.create({ data: { customerId: c.id, amount: 8800, signedAt: new Date() } });
  await p.contractWin.create({ data: { opportunityId: o.id, contractId: k.id, prevStage: "需求确认", prevProbability: 40 } });
  await p.$disconnect();

  await 登录(page);
  await page.goto(`/customers/${c.id}`);
  await page.getByRole("button", { name: "删除这笔签约" }).click({ force: true });
  const 框 = page.getByRole("dialog");
  await expect(框).toContainText("删除这条签约记录？");
  await expect(框).toContainText("8,800");
  await expect(框).toContainText(`一起标成赢单的商机「试单${戳}」会退回进行中`);
  await expect(框).toContainText("跟进状态退回到");
  await 框.getByRole("button", { name: /删\s*除/ }).click();
  await expect(page.locator(".ant-message")).toContainText("1 个商机退回进行中");

  const q = 连库();
  expect(await q.contract.count({ where: { customerId: c.id } })).toBe(0);
  expect((await q.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("OPEN");
  await q.$disconnect();
});

test("删待办 / 删计划（计划页）：就地确认，删了那一行就没了", async ({ page }) => {
  const p = 连库();
  const c = await p.customer.create({ data: { name: `计划客户${戳}`, phone: `1387${戳}0`.slice(0, 11), salesOwnerId: 我 } });
  await p.followPlan.create({ data: { customerId: c.id, ownerId: 我, subject: `回访${戳}`, plannedAt: new Date(Date.now() - 86400000), method: "电话沟通" } });
  await p.task.create({ data: { customerId: c.id, ownerId: 我, title: `发资料${戳}`, dueAt: new Date(Date.now() - 86400000) } });
  await p.$disconnect();

  await 登录(page);
  await page.goto("/follow-ups/plans");
  for (const [标题, 提示] of [[`回访${戳}`, "计划已删除"], [`发资料${戳}`, "待办已删除"]] as const) {
    await expect(page.getByText(标题, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: `删除 ${标题}` }).click({ force: true });
    await expect(就地确认(page)).toContainText("删除这条？");
    await 就地确认(page).getByRole("button", { name: "删除" }).click();
    await expect(page.locator(".ant-message")).toContainText(提示);
    await expect(page.getByText(标题, { exact: true })).toHaveCount(0);
  }
});

test("删渠道 / 删线索：有客户挂着的渠道拦下说清；没转化的线索删掉；已转化的线索没有删除钮，只给「查看客户」", async ({ page }) => {
  const p = 连库();
  const 有人 = await p.channel.create({ data: { name: `有人渠道${戳}`, channelOwnerId: 我 } });
  await p.channel.create({ data: { name: `空渠道${戳}`, channelOwnerId: 我 } });
  const c = await p.customer.create({ data: { name: `渠道客户${戳}`, phone: `1388${戳}0`.slice(0, 11), salesOwnerId: 我, channelId: 有人.id, attributionChannelId: 有人.id } });
  await p.lead.create({ data: { name: `转过的线索${戳}`, phone: `1371${戳}0`.slice(0, 11), ownerId: 我, status: "已转化", customerId: c.id, convertedAt: new Date() } });
  await p.lead.create({ data: { name: `没转的线索${戳}`, phone: `1371${戳}1`.slice(0, 11), ownerId: 我, status: "待跟进" } });
  await p.$disconnect();

  await 登录(page);
  await page.goto("/channels");
  await page.getByRole("button", { name: `删除 有人渠道${戳}` }).click();
  await expect(page.getByRole("dialog")).toContainText(`删除渠道「有人渠道${戳}」？`);
  await page.getByRole("dialog").getByRole("button", { name: /删\s*除/ }).click();
  await expect(page.locator(".ant-message")).toContainText("名下已有 1 名客户，不能删除");
  await expect(page.locator("tr.ant-table-row", { hasText: `有人渠道${戳}` })).toHaveCount(1);
  await page.getByRole("button", { name: `删除 空渠道${戳}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: /删\s*除/ }).click();
  await expect(page.locator("tr.ant-table-row", { hasText: `空渠道${戳}` })).toHaveCount(0);

  await page.goto("/leads");
  const 转过的 = page.locator("tr.ant-table-row", { hasText: `转过的线索${戳}` });
  await expect(转过的.getByRole("link", { name: /查看客户/ })).toBeVisible();
  await expect(转过的.getByRole("button", { name: `删除 转过的线索${戳}` })).toHaveCount(0);
  await page.getByRole("button", { name: `删除 没转的线索${戳}` }).click();
  const 框 = page.getByRole("dialog");
  await expect(框).toContainText(`删除线索「没转的线索${戳}」？`);
  await 框.getByRole("button", { name: /删\s*除/ }).click();
  await expect(page.locator(".ant-message")).toContainText("已删除");
  await expect(page.locator("tr.ant-table-row", { hasText: `没转的线索${戳}` })).toHaveCount(0);
  await page.goto("/customers");
  await expect(page.locator("tr.ant-table-row", { hasText: `渠道客户${戳}` })).toHaveCount(1);
});
