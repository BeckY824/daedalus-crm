/**
 * 「AI 不自动跑」（拍过板：开户只送 30 次、不再补）在桌面端：AI 是登录云端账号带来的，
 * 走云端的模型网关（这里是假云端）。打开记录页、打开 AI 抽屉，/api/ai/stream 一次都不许被叫，
 * 云端网关也一次都不许被叫；人点了「生成简报」才叫——反过来证明两只耳朵都是好的。
 */
import { test, expect } from "@playwright/test";
import { 云端统计, 我的id, 连库, 进门 } from "./helpers";

const 网关 = "/api/gateway/v1/chat/completions";

let 客户id = "";
test.beforeAll(async () => {
  const p = 连库();
  try {
    const 我 = await 我的id(p);
    const c = await p.customer.create({ data: { name: "不自动跑", phone: "13900008888", salesOwnerId: 我 } });
    客户id = c.id;
    // 有跟进记录才有简报区（没有记录时那一块根本不画，就测不出它跑没跑）
    await p.followUp.create({ data: { customerId: c.id, ownerId: 我, type: "CALL", title: "电话", content: "聊了预算", status: "已完成", occurredAt: new Date() } });
  } finally {
    await p.$disconnect();
  }
});

test("打开客户记录页、打开 AI 抽屉都不自动跑：本地和云端网关一次都没被叫，点了才叫", async ({ page }) => {
  const 叫了: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/ai/stream")) 叫了.push(r.url());
  });
  const 网关之前 = (await 云端统计(page))[网关] ?? 0;

  await 进门(page, `/customers/${客户id}`);
  await expect(page.getByRole("heading", { name: "不自动跑" })).toBeVisible();
  await page.waitForTimeout(4000);
  expect(叫了).toEqual([]);

  // 桌面端默认窗口 1440 宽：简报区收在页头「AI」按钮打开的抽屉里。打开抽屉也不许自己跑
  const 抽屉键 = page.getByRole("button", { name: /^thunderbolt AI$/ });
  if (await 抽屉键.isVisible()) await 抽屉键.click();
  const 生成 = page.getByRole("button", { name: /生成简报/ });
  await expect(生成).toBeVisible();
  await page.waitForTimeout(3000);
  expect(叫了).toEqual([]);
  expect((await 云端统计(page))[网关] ?? 0).toBe(网关之前);

  // 人点了才叫：本地生成接口、云端网关各叫到
  await 生成.click();
  await expect.poll(() => 叫了.length).toBeGreaterThan(0);
  await expect.poll(async () => (await 云端统计(page))[网关] ?? 0).toBeGreaterThan(网关之前);
});
