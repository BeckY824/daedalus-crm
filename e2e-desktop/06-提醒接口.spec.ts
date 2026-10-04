/**
 * /api/desktop/reminders：壳每分钟问一次，Dock 上的数、早报、到点提醒都从这儿来。
 *
 *   - 只认壳的令牌（x-desktop-token），不认会话 cookie
 *   - 口径 = 「跟进计划」页的「我的」：逾期 = 今天零点之前没做的，今天 = 今天之内没做的；Dock 上的数 = 两者之和
 *   - 定了钟点的（不是零点）、往后 24 小时之内的进「定时」，壳到点发通知
 *   - 没登录云端账号时什么都不报（不能替别人说话）
 *
 * 计划直接写库：这里测的是接口的口径，不是排计划的界面。接口每次现查库，不经设置缓存，写库它看得见。
 */
import { test, expect } from "@playwright/test";
import { 我的id, 没登录云端时, 连库, 进门, 问提醒 } from "./helpers";

test.describe.configure({ mode: "serial" });

type 摘要 = { 逾期: number; 今天: number; 定时: { 标题: string; 客户: string }[]; 最久: { 客户: string; 天: number } | null };

test("没令牌、令牌不对一律 403；会话 cookie 也不算数", async ({ page }) => {
  expect((await 问提醒(page, null)).status()).toBe(403);
  expect((await 问提醒(page, "e2e-desktop-token-WRONG-WRONG-WRONG")).status()).toBe(403);
  // 已登录的页面（带着会话 cookie）照样问不到：这条路只属于壳
  await 进门(page);
  expect((await page.request.get("/api/desktop/reminders")).status()).toBe(403);
});

test("建一条逾期计划、一条今天稍后定了钟点的计划：逾期 +1、今天 +1，定时里有它，左栏「跟进」的数跟着变", async ({ page }) => {
  const 之前 = (await (await 问提醒(page)).json()) as 摘要;
  expect(之前).toMatchObject({ 逾期: expect.any(Number), 今天: expect.any(Number), 定时: expect.any(Array) });

  const p = 连库();
  try {
    const 我 = await 我的id(p);
    const c = await p.customer.create({ data: { name: "提醒客户", phone: "13700007777", salesOwnerId: 我 } });
    const 前天 = new Date(Date.now() - 2 * 86_400_000);
    前天.setHours(10, 0, 0, 0);
    await p.followPlan.create({ data: { customerId: c.id, ownerId: 我, subject: "回访报价", plannedAt: 前天 } });
    // 今天稍后、定了钟点：离现在 1 分钟；接近午夜时往前挪，保证还在「今天」里（定时只看往后 24 小时 + 回看 10 分钟）
    const 稍后 = new Date(Date.now() + 60_000);
    const 明天零点 = new Date(new Date().setHours(24, 0, 0, 0));
    const 计划时间 = 稍后 < 明天零点 ? 稍后 : new Date(Date.now() - 60_000);
    if (计划时间.getHours() === 0 && 计划时间.getMinutes() === 0) 计划时间.setMinutes(1);
    await p.followPlan.create({ data: { customerId: c.id, ownerId: 我, subject: "三点回电", plannedAt: 计划时间 } });
  } finally {
    await p.$disconnect();
  }

  const 之后 = (await (await 问提醒(page)).json()) as 摘要;
  expect(之后.逾期).toBe(之前.逾期 + 1);
  expect(之后.今天).toBe(之前.今天 + 1);
  expect(之后.定时.map((x) => x.标题)).toContain("三点回电");
  expect(之后.最久).toMatchObject({ 客户: "提醒客户" });

  // 左栏「跟进」上的数和 Dock 是同一个（逾期 + 今天）
  await 进门(page);
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: /跟进/ })).toContainText(String(之后.逾期 + 之后.今天));
});

test("没登录云端账号时什么都不报：Dock 上不挂上一个人的数", async ({ page }) => {
  await 没登录云端时(async () => {
    const r = await 问提醒(page);
    expect(r.status()).toBe(200);
    expect(await r.json()).toMatchObject({ 逾期: 0, 今天: 0, 定时: [], 最久: null });
  });
  // 放回去又有了
  expect(((await (await 问提醒(page)).json()) as 摘要).逾期).toBeGreaterThan(0);
});
