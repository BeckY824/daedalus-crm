/**
 * 设置 → 团队：老板那台的「同事新建时提醒我」（2026-10-19 客户反馈第 1 条，desktop/team-notices.js）。
 *
 * 开关存在壳那边（reminders.json），网页经 window.desktopReminders 读写。这里没有 Electron：用一个假桥代壳，
 * 看三件事——老板那台才出这张卡、默认客户 / 商机开跟进关、拨一下只把那一项交给壳（不带别的键，免得把别的开关冲掉）。
 * 业务员那台不出（09 那组已经是业务员：这里另起一个老板的团队）；壳不认这三项的老版本整张卡不出。
 */
import { test, expect, type Page } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLOUD_URL, DATA_DIR, 云端账号 } from "./env";
import { 设云端团队, 连库, 进门 } from "./helpers";

test.describe.configure({ mode: "serial" });

const 团队 = (我是老板: boolean) => ({
  id: "t_e2e_notice",
  name: "E2E 提醒团队",
  active: true,
  我是建的人: 我是老板,
  成员: [
    { accountId: 云端账号.id, name: 云端账号.name, contact: 云端账号.contact, role: 我是老板 ? "owner" : "member" },
    { accountId: "acc_wang", name: "王磊", contact: "wang@e2e.local", role: 我是老板 ? "member" : "owner" },
  ],
});

/** 假壳：和 desktop/preload-app.js 的 desktopReminders 同形；认不认同事那三项由 新壳 决定 */
async function 装假桥(page: Page, 新壳 = true) {
  await page.addInitScript((新) => {
    const 设置: Record<string, unknown> = { 角标: true, 早报: true, 早报时间: "09:00", 到点: true, ...(新 ? { 同事客户: true, 同事商机: true, 同事跟进: false } : {}) };
    const w = window as unknown as { desktopReminders: unknown; __改过: unknown[] };
    w.__改过 = [];
    w.desktopReminders = {
      设置: async () => ({ ...设置 }),
      改设置: async (部分: Record<string, unknown>) => { w.__改过.push(部分); Object.assign(设置, 部分); return { ...设置 }; },
    };
  }, 新壳);
}

/** 单跑这一组时库是新的，进门先落在选模版页、再弹「已更新到」（01 那组跑过就都没有）：选通用、关掉，再回设置 */
async function 进设置团队(page: Page) {
  await 进门(page, "/settings?tab=team");
  if (await page.getByRole("heading", { name: "你主要做哪一类生意？" }).isVisible()) {
    await page.getByRole("button", { name: /用通用销售开始/ }).click();
    await expect(page).not.toHaveURL(/\/start/);
    await 进门(page, "/settings?tab=team");
  }
  // 新库第一次进主界面弹一次「已更新到」（01 那组验过）：关掉
  const 更新了 = page.getByRole("button", { name: "知道了" });
  if (await 更新了.isVisible().catch(() => false)) await 更新了.click();
}

test.beforeAll(async () => {
  // 进了团队的电脑上「我」是 acct_<云端账号> 这一行（09 那组造过；单跑这一组时自己造）
  const p = 连库();
  try {
    await p.user.upsert({ where: { id: `acct_${云端账号.id}` }, create: { id: `acct_${云端账号.id}`, email: "me@e2e.local", name: 云端账号.name, password: "x", role: "ADMIN", title: "管理员" }, update: { active: true } });
  } finally {
    await p.$disconnect();
  }
  writeFileSync(
    path.join(DATA_DIR, ".team.json"),
    JSON.stringify({ teamId: "t_e2e_notice", teamName: "E2E 提醒团队", joinSecret: "e2e", key: "A".repeat(43), device: "dev_e2e_notice", pulled: 0, ownerAccountId: 云端账号.id }),
    { mode: 0o600 },
  );
});
test.afterAll(async ({ request }) => {
  rmSync(path.join(DATA_DIR, ".team.json"), { force: true });
  await request.delete(`${CLOUD_URL}/__stub/team`).catch(() => {});
});

test("老板那台：卡片在，默认客户、商机开，跟进关；拨一下只交那一项", async ({ page, request }) => {
  await 设云端团队(request, 团队(true));
  await 装假桥(page);
  await 进设置团队(page);
  const 卡 = page.getByTestId("team-notice-card");
  await expect(卡).toBeVisible();
  await expect(卡.getByRole("heading", { name: "同事新建时提醒我" })).toBeVisible();
  await expect(卡.getByRole("switch", { name: "新客户" })).toBeChecked();
  await expect(卡.getByRole("switch", { name: "新商机" })).toBeChecked();
  await expect(卡.getByRole("switch", { name: "新跟进" })).not.toBeChecked();
  await 卡.scrollIntoViewIfNeeded();
  await 卡.screenshot({ path: process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, "01-设置-同事新建时提醒我.png") : test.info().outputPath("card.png") });

  await 卡.getByRole("switch", { name: "新跟进" }).click();
  await expect(卡.getByRole("switch", { name: "新跟进" })).toBeChecked();
  await 卡.getByRole("switch", { name: "新客户" }).click();
  await expect(卡.getByRole("switch", { name: "新客户" })).not.toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { __改过: unknown[] }).__改过)).toEqual([{ 同事跟进: true }, { 同事客户: false }]);
});

test("业务员那台、老版本的壳：都不出这张卡", async ({ page, request }) => {
  await 设云端团队(request, 团队(false));
  await 装假桥(page);
  await 进设置团队(page);
  await expect(page.getByRole("tabpanel", { name: /^团队/ })).toBeVisible();
  await expect(page.getByTestId("team-notice-card")).toHaveCount(0);

  await 设云端团队(request, 团队(true));
  const 老壳 = await page.context().newPage();
  await 装假桥(老壳, false);
  await 进设置团队(老壳);
  await expect(老壳.getByRole("tabpanel", { name: /^团队/ })).toBeVisible();
  await expect(老壳.getByTestId("team-notice-card")).toHaveCount(0);
});
