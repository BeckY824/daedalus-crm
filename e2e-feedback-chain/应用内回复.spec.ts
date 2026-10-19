/**
 * 应用内反馈回复整条链（playwright.feedback-chain.config.ts）：
 *   桌面端写反馈 → 运营台在应用里回复（没配 SMTP：「同时发邮件」置灰、说原因）→ 壳那一轮问到 → 左栏红点 + 左下角提示 →
 *   点「查看」进「我的反馈」看到回复、红点掉 → 接着说 → 运营台看到一整串、那条重新算没处理
 *
 * 桌面端（本地服务）在 baseURL；运营台在真云端（托管版）上，用 localhost 访问（Next 16 dev 拦 127.0.0.1 的 JS chunk）。
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { 进门 } from "../e2e-desktop/helpers";
import { CLOUD_PORT, DESKTOP_TOKEN } from "../e2e-desktop/env";
import { ADMIN_TOKEN } from "./env";

test.describe.configure({ mode: "serial" });

const 运营台 = `http://localhost:${CLOUD_PORT}`;
const 出处 = process.env.E2E_SHOT_DIR ?? null;
const 原话 = `导出 CSV 时阿拉伯文客户名变成了问号（e2e ${Date.now()}）`;
const 我们回 = "谢谢！是编码的问题，下一版导出会带 BOM，Excel 打开就不乱码了。\n详细说明：https://example.com/help/export-csv-utf8-bom";
const 接着 = "好的，那现在有没有办法先绕过去？";

async function 截(page: Page, 名: string) {
  if (!出处) return;
  mkdirSync(出处, { recursive: true });
  await page.screenshot({ path: path.join(出处, `${名}.png`) });
}

test("运营台回复 → 桌面端红点 + 提示 → 看到回复 → 接着说 → 运营台看到一整串", async ({ page, browser, request }) => {
  test.setTimeout(5 * 60_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  // 1. 桌面端写一条反馈（本地服务带设备令牌转给云端）
  await 进门(page, "/customers");
  // 新库第一次进来先选生意类型
  const 选类型 = page.getByRole("heading", { name: "你主要做哪一类生意？" });
  if (await 选类型.waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false)) {
    await page.getByRole("button", { name: /用通用销售开始/ }).click();
    await expect(page).not.toHaveURL(/\/start/);
  }
  const 弹窗更新 = page.getByRole("dialog", { name: /已更新到/ });
  if (await 弹窗更新.waitFor({ state: "visible", timeout: 4_000 }).then(() => true, () => false)) {
    await 弹窗更新.getByRole("button", { name: /知\s*道\s*了/ }).click();
  }
  await page.getByRole("button", { name: /^反馈：/ }).click({ timeout: 60_000 });
  const 写 = page.getByRole("dialog").filter({ has: page.getByPlaceholder(/说说哪儿不好用/) });
  await 写.getByPlaceholder(/说说哪儿不好用/).fill(原话);
  await 写.getByRole("button", { name: /^发\s*送$/ }).click();
  await expect(page.getByText(/收到了，谢谢/)).toBeVisible();
  await expect(page.getByTestId("feedback-dot")).toHaveCount(0);

  // 2. 运营台：原话在，回复默认进应用；没配 SMTP，「同时发邮件」置灰并说原因
  const 运营 = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await 运营.goto(`${运营台}/admin/feedback?token=${ADMIN_TOKEN}`);
  const 这条 = 运营.locator(".opx-fb").filter({ hasText: 原话 });
  await expect(这条).toBeVisible({ timeout: 60_000 });
  await 这条.getByRole("button", { name: /^回\s*复$/ }).click();
  await expect(这条.getByRole("checkbox", { name: /同时发邮件/ })).toBeDisabled();
  await expect(这条.getByText(/SMTP/)).toBeVisible();
  await 这条.getByRole("textbox", { name: "回复内容" }).fill(我们回);
  await 截(运营, "运营台-写回复");
  await 这条.getByRole("button", { name: /^发\s*送$/ }).click();
  await expect(运营.getByText("已发到对方应用里")).toBeVisible();
  // 回过就算处理过了：从「没处理」里走掉，去「全部」里看
  await 运营.getByText(/^全部/).click();
  await expect(这条.getByText("只在应用里")).toBeVisible();

  // 3. 壳那一轮（desktop/feedback-replies.js 每 5 分钟问一次）：问到一条没看过的回复，就是系统通知那一句
  const 壳问 = await request.get("/api/desktop/feedback", { headers: { "x-desktop-token": DESKTOP_TOKEN } });
  expect(壳问.ok()).toBe(true);
  const 壳 = (await 壳问.json()) as { 可用: boolean; 未读: { feedbackId: string; 回复: string }[] };
  expect(壳.可用).toBe(true);
  expect(壳.未读).toHaveLength(1);
  expect(壳.未读[0].回复).toBe(我们回);

  // 4. 窗口收到「变了」之后重新取：左栏红点 + 左下角提示
  await page.reload();
  await expect(page.getByTestId("feedback-dot")).toBeVisible();
  const 提示 = page.getByTestId("feedback-toast");
  await expect(提示).toBeVisible();
  await expect(提示).toContainText("我们回复了你的反馈");
  await expect(提示).toContainText("谢谢！是编码的问题");
  await 截(page, "桌面端-红点和提示");

  // 5. 点「查看」：到那一串，看得到回复（标 Daedalus 团队、链接可点），红点掉了
  await 提示.getByRole("button", { name: "查看" }).click();
  await expect(page).toHaveURL(/\/feedback\?id=/);
  const 对话 = page.getByRole("region", { name: "对话" });
  await expect(对话.getByText("Daedalus 团队")).toBeVisible();
  await expect(对话.getByRole("link", { name: "https://example.com/help/export-csv-utf8-bom" })).toHaveAttribute("target", "_blank");
  await expect(page.getByTestId("feedback-dot")).toHaveCount(0);
  await expect(提示).toHaveCount(0);
  await 截(page, "桌面端-我的反馈");

  // 6. 接着说
  await 对话.getByRole("textbox", { name: "接着说" }).fill(接着);
  await 对话.getByRole("button", { name: /^发\s*送$/ }).click();
  await expect(对话.locator(".mfb-msg.me").filter({ hasText: 接着 })).toBeVisible();
  await expect(对话.getByText("发送中…")).toHaveCount(0);
  await expect(对话.getByText("没发出去")).toHaveCount(0);
  await expect(对话.getByRole("textbox", { name: "接着说" })).toHaveValue("");
  await 截(page, "桌面端-接着说");

  // 7. 运营台：一整串（原话 → 我们回复 → 对方接着说），这条重新算没处理
  // 接着说把它顶回了「没处理」（默认那一格）
  await 运营.reload();
  const 串 = 运营.locator(".opx-fb").filter({ hasText: 原话 });
  await expect(串.locator(".opx-fb-thread")).toContainText("我们回复");
  await expect(串.locator(".opx-fb-user")).toContainText(接着);
  await expect(串).toHaveClass(/opx-fb-todo/);
  await 截(运营, "运营台-一整串");
  await 运营.close();
});

test("令牌不对：云端 401，什么都不给", async ({ request }) => {
  const r = await request.get(`${运营台}/api/feedback/mine`, { headers: { Authorization: "Bearer dk_e2e_wrong" } });
  expect(r.status()).toBe(401);
});
