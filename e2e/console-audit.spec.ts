/**
 * 控制台巡检：遍历所有页面，任何 error / warning 都算失败。
 *
 * 2026-10-04 之前这一条**一个 expect 都没有**，只把问题 console.log 出来，永远不会红（排查 J2 顺带发现）；
 * 客户详情也因为默认库是空的一直跳过。现在：攒下全部问题最后断言为空；自己建一位带跟进 / 商机 / 联系人的客户，用完清掉。
 *
 * 拦的是"页面看着正常、控制台在报警"这类问题——它们不会让用例挂掉，
 * 却会在开发模式下堆成 Next 左下角那个红色 issue 数，也预示着真实的
 * 渲染或用法缺陷（本项目就出现过 antd v6 的 Alert/Space 弃用属性）。
 */
import { test, expect } from "@playwright/test";
import { 订单, 供应商页 } from "../src/lib/features";
import { 连库, 清空业务数据 } from "./mock-data";

let 巡检客户 = "";
test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  const 我 = await p.user.findFirstOrThrow({ where: { email: "admin" } });
  const c = await p.customer.create({ data: { name: "巡检客户", phone: "13833330001", salesOwnerId: 我.id } });
  巡检客户 = c.id;
  await p.contact.create({ data: { customerId: c.id, name: "巡检联系人", phone: "13933330001", isPrimary: true } });
  await p.followUp.create({ data: { customerId: c.id, ownerId: 我.id, type: "CALL", title: "电话", content: "聊了", status: "已完成", occurredAt: new Date() } });
  await p.opportunity.create({ data: { customerId: c.id, ownerId: 我.id, name: "巡检商机", amount: 1000, stage: "初步接洽" } });
  await p.$disconnect();
});
test.afterAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

const 页面 = [
  ["首页", "/dashboard"],
  ["数据看板", "/overview"],
  ["线索", "/leads"],
  ["客户", "/customers"],
  ["渠道", "/channels"],
  ["联系人", "/contacts"],
  ["商机列表", "/opportunities"],
  // J-219：带 ?new=1 一进来就开新建框，首次加载出过水合报错
  ["商机列表（直接开新建框）", "/opportunities?new=1"],
  ["商机看板", "/opportunities/pipeline"],
  // 外贸模版的两页（2026-10-03）：空着也不许报警。0.46.15 这一版不上（lib/features.ts），关着时页面是 404，不巡
  ...(订单 ? [["订单", "/orders"]] : []),
  ...(供应商页 ? [["供应商", "/suppliers"]] : []),
  ["跟进记录", "/follow-ups"],
  ["跟进计划", "/follow-ups/plans"],
  ["数据复盘", "/reports"],
  ["设置管理", "/settings"],
];

test("控制台巡检", async ({ page }) => {
  const 问题: string[] = [];
  /** 每页的问题，最后一起断言：一页挂了也要把后面几页巡完，一次看全 */
  const 全部: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") 问题.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => 问题.push(`[pageerror] ${e.message.slice(0, 200)}`));

  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill("admin");
  await page.getByPlaceholder("登录密码").fill("admin123");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL("**/dashboard");

  for (const [名, 路径] of 页面) {
    问题.length = 0;
    await page.goto(路径);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(800);
    // J-194：一页只许一个 <main>（新壳和页面各包一层时读屏认不出正文）
    const 正文数 = await page.locator("main").count();
    if (正文数 !== 1) 问题.push(`[结构] 这一页有 ${正文数} 个 <main>`);
    console.log(问题.length === 0 ? `✓ ${名}` : `✗ ${名}\n    ${问题.join("\n    ")}`);
    全部.push(...问题.map((q) => `${名}：${q}`));
  }

  // 客户详情页单独走一遍：组件最多的一页
  问题.length = 0;
  await page.goto(`/customers/${巡检客户}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);
  // 记录页没有页签；点一下状态标签把下拉也渲染一遍。
  // 标签行 2026-09-17 起在页头名字底下（.rec-tags），不在左边那张档案卡里
  await page.locator(".rec-tags .ant-tag").first().click();
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
  const 详情正文数 = await page.locator("main").count();
  if (详情正文数 !== 1) 问题.push(`[结构] 这一页有 ${详情正文数} 个 <main>`);
  console.log(问题.length === 0 ? "✓ 客户详情（含状态下拉）" : `✗ 客户详情\n    ${问题.join("\n    ")}`);
  全部.push(...问题.map((q) => `客户详情：${q}`));

  expect(全部, "控制台有报错或警告").toEqual([]);
});
