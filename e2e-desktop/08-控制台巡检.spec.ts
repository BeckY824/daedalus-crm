/**
 * 桌面端的控制台巡检：主要几页 console 无 error / warning（照 e2e/console-audit.spec.ts，但有 expect）。
 *
 * 桌面端和网页版画的不是一个样：首页是对话那一版、左栏多了更新记录、客户入口是 /customers/recent、
 * 设置多了桌面端和团队两栏、壳的桥不在——这些只有本地模式下才走得到，默认那条巡检看不见。
 * 前面几组用例已经造了客户、跟进、计划，各页都是有数据的样子。
 */
import { test, expect } from "@playwright/test";
import { 盯控制台, 连库, 进门 } from "./helpers";

const 页面: [string, string][] = [
  ["首页", "/dashboard"],
  ["最近的客户", "/customers/recent"],
  ["客户", "/customers"],
  ["线索", "/leads"],
  ["联系人", "/contacts"],
  ["渠道", "/channels"],
  ["商机", "/opportunities"],
  ["商机看板", "/opportunities/pipeline"],
  ["跟进记录", "/follow-ups"],
  ["跟进计划", "/follow-ups/plans"],
  ["数据", "/overview"],
  ["设置 · 个人资料", "/settings?tab=profile"],
  ["设置 · AI 接入", "/settings?tab=ai"],
  ["设置 · 桌面端", "/settings?tab=desktop"],
  ["设置 · 团队", "/settings?tab=team"],
];

test("控制台巡检：主要几页和客户记录页 console 无 error / warning", async ({ page }) => {
  const p = 连库();
  const 一位 = await p.customer.findFirstOrThrow({ where: { followUps: { some: {} } }, select: { id: true } });
  await p.$disconnect();

  const 问题 = 盯控制台(page);
  /** 每页的问题最后一起断言：一页挂了也把后面几页巡完，一次看全 */
  const 全部: string[] = [];
  await 进门(page);

  for (const [名, 路径] of [...页面, ["客户记录页", `/customers/${一位.id}`] as [string, string]]) {
    问题.length = 0;
    await page.goto(路径);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(800);
    // 落到登录页 / 404 也算问题：巡的是「这一页在桌面端能打开」
    if (/\/login/.test(page.url())) 问题.push(`被送回了登录页：${page.url()}`);
    全部.push(...问题.map((q) => `${名}：${q}`));
  }

  expect(全部, "控制台有报错或警告").toEqual([]);
});
