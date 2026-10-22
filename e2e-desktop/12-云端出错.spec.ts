/**
 * 云端出错时，登录页、找回页不能悄悄少一块（2026-10-21 漏网：0.46.23 国内网慢，登录页没了注册入口；
 * 0.46.24 只修了超时，502 / 503 / 429 照样藏，#71 才修全）。
 *
 * 规矩：只有云端**正常回了、并且明说不收**才藏注册 / 找回。超时、5xx、429、404、回的不是 JSON，一律照常给路走。
 * 每种情况都用假云端的故障开关造（cloud-stub.mjs 的 /__stub/fault、/__stub/extra 的 policy）。
 *
 * 注意：本地服务记着「上次问到」的策略，这套里前面的用例都是正常回的，所以这里量的是「问到过一次、之后出错」。
 * 第一次打开就出错的那种在单测 tests/desktop-session.test.ts 里。
 */
import { test, expect, type Page } from "@playwright/test";
import { CLOUD_URL } from "./env";
import { 没登录云端时 } from "./helpers";
import { 查排版, 说问题 } from "../e2e/layout-audit";

const 设故障 = (page: Page, f: Record<string, string>) => page.request.post(`${CLOUD_URL}/__stub/fault`, { data: f });
const 设策略 = (page: Page, policy: Record<string, boolean> | null) =>
  policy ? page.request.post(`${CLOUD_URL}/__stub/extra`, { data: { policy } }) : page.request.delete(`${CLOUD_URL}/__stub/extra`);

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1024, height: 700 } });

test.afterAll(async ({ request }) => {
  await request.delete(`${CLOUD_URL}/__stub/fault`);
  await request.delete(`${CLOUD_URL}/__stub/extra`);
});

async function 量(page: Page) {
  const 问题 = await 查排版(page);
  expect(问题, 说问题(问题)).toEqual([]);
}

for (const [情况, 说明] of [
  ["502", "发版重启、网关回 502"],
  ["503", "服务暂不可用"],
  ["429", "限流"],
  ["404", "反代或老云端回 404"],
  ["200", "200 但回的是 HTML"],
  ["hang", "一直不回，等到超时"],
] as const) {
  test(`policy ${情况}（${说明}）：登录页有注册入口，找回页有表单`, async ({ page }) => {
    test.setTimeout(60_000);
    await 设故障(page, { "/api/account/policy": 情况 });
    await 没登录云端时(async () => {
      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "登录或注册" })).toBeVisible({ timeout: 15_000 });
      // 等过一会儿再看一次：不能先摆出来、问完了又悄悄藏掉
      await page.waitForTimeout(情况 === "hang" ? 3000 : 1000);
      await expect(page.getByRole("heading", { name: "登录或注册" })).toBeVisible();
      await 量(page);

      await page.goto("/forgot");
      await expect(page.getByRole("heading", { name: "找回密码" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("云端这会儿还没开通自助找回")).toHaveCount(0);
      await expect(page.getByRole("textbox").first()).toBeVisible();
    });
  });
}

test("policy 502、新邮箱点「继续」时注册也 502：说清原因，不悄悄转去输密码", async ({ page }) => {
  await 设故障(page, { "/api/account/policy": "502", "/api/account/signup/start": "502" });
  await 没登录云端时(async () => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "登录或注册" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("textbox").first().fill("new-user-qa@example.com");
    await page.getByRole("button", { name: /继\s*续/ }).click();
    await expect(page.getByText(/502|稍后|连不上/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "登录或注册" })).toBeVisible();
  });
});

test("云端正常回了、明说不收注册也不能找回：这时才只留登录", async ({ page }) => {
  await 设故障(page, {});
  await 设策略(page, { register: false, reset: false, inApp: true });
  await 没登录云端时(async () => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("用你的云端账号登录。")).toBeVisible();
    await page.goto("/forgot");
    await expect(page.getByText("云端这会儿还没开通自助找回")).toBeVisible({ timeout: 15_000 });

    // 云端又开了：下一次打开就回来，不被「上次问到」卡住
    await 设策略(page, null);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "登录或注册" })).toBeVisible({ timeout: 15_000 });
  });
});
