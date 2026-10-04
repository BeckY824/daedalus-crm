/**
 * 列表页和没配 AI 的首页（2026-10-04 回归核对 J1 / 上线前第 1 期）。
 *
 * 每一条都是出过的问题，代码早修了、界面上一直没有用例：
 *   J-002 从「本月新增 / 渠道直接带来 / 这一批」进客户列表，翻页、搜索后子集丢了；导出也要按这个子集
 *   J-013 筛出 0 条画成空库引导（「新建第一位」），筛选栏和重置都没了
 *   J-020 批量改状态的提示条「撤销」：两位各回各的原状态
 *   J-026 新建线索默认来源「官网注册」——忘了改就悄悄进了「按来源」统计
 *   J-126 配了 AI 的首页问完一句：欢迎区收起后问答贴着输入框往上长，中间不空一大片
 *   J-124 / J-125 / J-121 / J-111 没配 AI 的首页：页头写「首页」不和「数据」重名；本月签约 0 写 ¥0；
 *         业绩排行金额带 ¥ 且写清口径；上月没有新增时不写「持平」
 *
 * 数据都在用例里自己造（直接写库），不依赖别的 spec 留下的东西。
 * 默认 e2e 库里没配 AI（配过的 spec 自己会拆掉），首页走的就是数据看板那一支。
 */
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";
import { 装个假模型, 拆掉假模型 } from "./fake-llm";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

async function 登录(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill(账号.用户名);
  await page.getByPlaceholder("登录密码").fill(账号.密码);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

let 张三 = "";
let 李四 = "";
let 渠道id = "";
let 批次id = "";
const 一年前 = new Date(Date.now() - 365 * 86400_000);

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.importBatch.deleteMany();
  张三 = (await p.user.findFirstOrThrow({ where: { email: "zhangsan" } })).id;
  李四 = (await p.user.findFirstOrThrow({ where: { email: "lisi" } })).id;
  // 本月新增 22 位 + 一年前的老客 22 位：本月那个子集第 2 页正好 2 位
  for (let i = 0; i < 22; i++) {
    // 建档时间错开 1 秒：同一毫秒建出来的并列排序不固定，第 2 页是哪两位会变（整套跑时撞过）
    await p.customer.create({ data: { name: `本月新${String(i).padStart(2, "0")}`, phone: `1371000${String(i).padStart(4, "0")}`, salesOwnerId: 张三, createdAt: new Date(Date.now() - (22 - i) * 1000) } });
    await p.customer.create({ data: { name: `老客${String(i).padStart(2, "0")}`, phone: `1372000${String(i).padStart(4, "0")}`, salesOwnerId: 张三, createdAt: 一年前 } });
  }
  // 渠道直接带来的 21 位（老客里挑，也是一年前建的）
  const 渠道 = await p.channel.create({ data: { name: "协会王主任", channelOwnerId: 张三 } });
  渠道id = 渠道.id;
  const 老客们 = await p.customer.findMany({ where: { name: { startsWith: "老客" } }, orderBy: { name: "asc" } });
  for (const c of 老客们.slice(0, 21)) await p.customer.update({ where: { id: c.id }, data: { channelId: 渠道.id } });
  // 一批导入动过的 21 位
  const 批 = await p.importBatch.create({ data: { userId: 张三, userName: "张三", fileName: "子集.csv", created: 21 } });
  批次id = 批.id;
  const 本月们 = await p.customer.findMany({ where: { name: { startsWith: "本月新" } }, orderBy: { name: "asc" } });
  for (const c of 本月们.slice(0, 21)) await p.importRow.create({ data: { batchId: 批.id, customerId: c.id, kind: "create" } });
  await p.$disconnect();
});

test.afterAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.importBatch.deleteMany();
  await p.$disconnect();
});

/** 当前这一屏表格里的客户名 */
async function 这一屏(page: Page) {
  await expect(page.locator(".ant-table-row").first()).toBeVisible();
  return page.locator(".ant-table-row td a").allInnerTexts();
}

async function 翻到第二页(page: Page) {
  await page.locator(".ant-pagination-item-2").click();
  await page.waitForURL(/page=2/);
}

test("J-002 本月新增：翻到第 2 页、再搜一下，子集都还在（地址留着条件、行全是本月的）", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers?createdWithin=本月");
  await expect(page.getByText("只看本月新增")).toBeVisible();
  await 翻到第二页(page);
  expect(decodeURIComponent(page.url())).toContain("createdWithin=本月");
  await expect(page.getByText("只看本月新增")).toBeVisible();
  await expect.poll(() => 这一屏(page)).toEqual(["本月新01", "本月新00"]);

  await page.getByPlaceholder(/姓名 \/ 电话/).fill("新1");
  await page.getByPlaceholder(/姓名 \/ 电话/).press("Enter");
  await page.waitForURL(/keyword=/);
  expect(decodeURIComponent(page.url())).toContain("createdWithin=本月");
  const 名 = await 这一屏(page);
  expect(名.length).toBe(10);
  expect(名.every((n) => n.startsWith("本月新1"))).toBe(true);
});

test("J-002 渠道直接带来的、刚导入的这一批：翻页后子集都还在", async ({ page }) => {
  await 登录(page);
  await page.goto(`/customers?directOf=${渠道id}`);
  await expect(page.getByText(/只看「协会王主任」直接带来的 · 21 位/)).toBeVisible();
  await 翻到第二页(page);
  expect(page.url()).toContain(`directOf=${渠道id}`);
  await expect.poll(async () => (await 这一屏(page)).length).toBe(1);
  expect((await 这一屏(page))[0]).toMatch(/^老客/);

  await page.goto(`/customers?batch=${批次id}`);
  await expect(page.getByText(/只看刚导入的这一批 · 21 位/)).toBeVisible();
  await 翻到第二页(page);
  expect(page.url()).toContain(`batch=${批次id}`);
  await expect.poll(async () => (await 这一屏(page)).length).toBe(1);
  expect((await 这一屏(page))[0]).toMatch(/^本月新/);
});

test("导出按当前的子集和筛选：本月新增里导出的是这 22 位全部，不是当前一页、也没有老客", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers?createdWithin=本月");
  await expect(page.getByText("只看本月新增")).toBeVisible();
  const [下载] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /导\s*出/ }).click()]);
  const 文本 = readFileSync(await 下载.path(), "utf8").replace(/^﻿/, "");
  const 行 = 文本.trim().split(/\r?\n/).slice(1);
  expect(行.length).toBe(22);
  expect(行.filter((l) => !l.startsWith("\"本月新")), "导出里混进了子集以外的人").toEqual([]);
  await expect(page.locator(".ant-message")).toContainText("导出了 22 条");
});

test("J-013 有数据的库里搜一个不存在的词：写「没有符合条件的」，不画「新建第一位」，筛选栏还在", async ({ page }) => {
  await 登录(page);
  for (const [路, 主] of [["/customers", "新建第一位客户"], ["/leads", "新建第一条线索"]] as const) {
    if (路 === "/leads") {
      const p = 连库();
      await p.lead.create({ data: { name: "有一条线索", ownerId: 张三 } });
      await p.$disconnect();
    }
    await page.goto(`${路}?keyword=${encodeURIComponent("根本没有这个人")}`);
    await expect(page.getByText(/没有符合条件的/)).toBeVisible();
    await expect(page.getByRole("button", { name: 主 })).toHaveCount(0);
    await expect(page.getByPlaceholder(/姓名|名称|搜索/).first()).toHaveValue("根本没有这个人");
  }
});

test("J-020 批量改状态：提示条点「撤销」，两位各回各的原状态", async ({ page }) => {
  const p = 连库();
  const 甲 = await p.customer.create({ data: { name: "批改甲", phone: "13730000001", salesOwnerId: 张三, followStatus: "待跟进" } });
  const 乙 = await p.customer.create({ data: { name: "批改乙", phone: "13730000002", salesOwnerId: 张三, followStatus: "跟进中" } });
  // [甲, 乙] 的状态
  const 状态 = async () => Promise.all([甲.id, 乙.id].map(async (id) => (await p.customer.findUniqueOrThrow({ where: { id } })).followStatus));
  try {
    await 登录(page);
    await page.goto(`/customers?keyword=${encodeURIComponent("批改")}`);
    await expect.poll(() => 这一屏(page)).toHaveLength(2);
    await page.locator(".ant-table-thead").getByRole("checkbox").check();
    await page.getByRole("button", { name: /批量状态/ }).click();
    const 下拉 = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
    await 下拉.waitFor({ state: "visible" });
    // 下拉还在弹出的动画里时点下去会落空：等它停稳
    await page.waitForTimeout(300);
    await 下拉.getByRole("menuitem", { name: "意向较高" }).click();
    await expect(page.locator(".ant-message")).toContainText("已改为「意向较高」");
    await expect.poll(状态).toEqual(["意向较高", "意向较高"]);
    await page.locator(".ant-message").getByRole("button", { name: /撤\s*销/ }).click();
    await expect(page.locator(".ant-message")).toContainText("已撤销");
    // 甲回待跟进、乙回跟进中——不是两位都回成同一个
    await expect.poll(状态).toEqual(["待跟进", "跟进中"]);
  } finally {
    await p.$disconnect();
  }
});

test("J-026 新建线索不选来源：存成「其他」，不是「官网注册」", async ({ page }) => {
  await 登录(page);
  await page.goto("/leads");
  const 框 = page.getByRole("dialog", { name: "新建线索" });
  await expect(async () => {
    if (!(await 框.isVisible())) await page.getByRole("button", { name: /新建线索/ }).first().click();
    await expect(框).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  // 来源那一格打开时就是空的，没有预填
  await expect(框.getByLabel("线索来源")).toHaveValue("");
  await 框.getByLabel("线索名称").fill("不选来源的线索");
  await 框.getByRole("button", { name: /确\s*定|保\s*存/ }).click();
  await expect(框).toBeHidden();
  const p = 连库();
  try {
    await expect.poll(async () => (await p.lead.findFirst({ where: { name: "不选来源的线索" } }))?.source).toBe("其他");
  } finally {
    await p.$disconnect();
  }
});

test("没配 AI 的首页：页头「首页」不和「数据」重名；本月签约 0 写 ¥0；排行金额带 ¥ 写清口径；上月没新增不写「持平」（J-124 / J-125 / J-121 / J-111）", async ({ page }) => {
  // 两位销售各赢一单（排行 > 1 人才画榜）；这个月没有签约
  const p = 连库();
  try {
    const c = await p.customer.findFirstOrThrow({ where: { name: "本月新00" } });
    await p.opportunity.create({ data: { name: "张三的单", customerId: c.id, ownerId: 张三, amount: 120000, stage: "赢单成交", status: "WON", probability: 100 } });
    await p.opportunity.create({ data: { name: "李四的单", customerId: c.id, ownerId: 李四, amount: 50000, stage: "赢单成交", status: "WON", probability: 100 } });
    await p.contract.deleteMany();
  } finally {
    await p.$disconnect();
  }
  await 登录(page);
  await page.goto("/dashboard");
  // J-124：页头是「首页」；侧栏「数据」那一页叫「数据」——两条入口落到两个不同名的页
  await expect(page.locator(".page-head h1")).toHaveText("首页");
  // J-125：本月签约 0 → ¥0，不是「—」
  const 签约卡 = page.locator(".stat-card", { hasText: "本月签约" });
  await expect(签约卡).toContainText(/¥\s?0(?![\d,])/);
  await expect(签约卡).not.toContainText("—");
  // J-121：排行每行金额带 ¥，口径写出来
  const 榜 = page.locator(".ant-card", { hasText: "销售团队业绩排行" });
  await expect(榜).toContainText(/¥\s?120,000/);
  await expect(榜).toContainText(/¥\s?50,000/);
  await expect(榜).toContainText("不限时间");
  // J-111：上月 0 位新增 → 「上月没有新增」，不写「持平」
  const 新增卡 = page.locator(".ant-card", { hasText: "新增客户（本月）" });
  await expect(新增卡).toContainText("上月没有新增");
  await expect(新增卡).not.toContainText("持平");

  // 侧栏两条入口：「首页」→ /dashboard、「数据」→ /overview，两页页头不同名
  const 导航 = page.getByRole("navigation", { name: "主导航" });
  await expect(导航.getByRole("link", { name: "首页", exact: true })).toHaveAttribute("href", "/dashboard");
  await expect(导航.getByRole("link", { name: "数据", exact: true })).toHaveAttribute("href", "/overview");
  await page.goto("/overview");
  await expect(page.locator(".page-head h1")).toHaveText("数据");
  await expect(page.locator(".stat-card", { hasText: "本月签约" })).toContainText(/¥\s?0(?![\d,])/);
});

/*
  J-126：首页问完一句，欢迎区收起、答案在流，原来答案顶在页面上沿、输入框沉在最下面，中间空一大片（0.36.5 / 0.37.0 修：
  .cli-log 贴着输入框往上长）。装一个打不通的假模型——答案是一句出错的话，排版和真答案是同一个壳。
  量盒子：最后一轮的下沿到输入框上沿之间不该有大块空白
*/
test.describe("配了 AI 的首页", () => {
  test.beforeAll(async ({ browser }) => 装个假模型(browser));
  test.afterAll(async ({ browser }) => 拆掉假模型(browser));

  test("J-126 问完一句：问答贴着输入框，中间不空一大片", async ({ page }) => {
    await 登录(page);
    await page.goto("/dashboard");
    const 框 = page.locator(".cli-composer textarea").first();
    await expect(框).toBeVisible();
    await 框.fill("这个月签了多少");
    await 框.press("Enter");
    const 一轮 = page.locator(".cli-turn").last();
    await expect(一轮).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".cli-welcome")).toHaveCount(0);
    // 等这一轮落定（打不通的模型会很快回一句出错）
    await page.waitForTimeout(1500);
    const 轮 = (await 一轮.boundingBox())!;
    const 输入 = (await page.locator(".cli-composer").boundingBox())!;
    expect(输入.y - (轮.y + 轮.height), "最后一轮和输入框之间空了一大片").toBeLessThan(80);
  });
});
