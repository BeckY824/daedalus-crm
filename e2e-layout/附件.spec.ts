/**
 * 商机 / 订单的「附件」区（2026-10-22 D-24）在 Windows 常见宽度下的样子。
 *
 * 数据照真客户（e2e-layout/种子.ts：长英文公司名、一整句英文商机名），再真传一张 3000×1500 的图、一份长名字的 PDF：
 *   - 图片在这台电脑上压到长边 2000（看接口回的宽高），出缩略图，点开看大图
 *   - PDF 写名字和大小
 *   - 1280 / 1366 宽，订单详情和商机编辑框各跑一遍 layout-audit，截图
 *   - 删掉一个，列表里就没了
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { 连库, 我的id, 进门 } from "../e2e-desktop/helpers";
import { 查排版, 说问题 } from "../e2e/layout-audit";
import { 灌真客户 } from "./种子";
import { 关掉弹窗, 切外贸 } from "./外贸模版";

test.describe.configure({ mode: "serial" });
const 出处 = process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, "附件") : null;
const 订单 = "gate-scandi-t0";
const 商机 = "gate-scandi-o1";
const 长文件名 = "SCANDI PAK EUROPE LTD - Specification Sheet for Frozen Chicken Breast BFQ 10kg Box (Rev.3, signed).pdf";

test.beforeAll(async ({ browser }) => {
  const db = 连库();
  try {
    await 灌真客户(db, await 我的id(db));
    // 附件表不建外键（见 migrations/041），上一轮传的不会跟着客户删，自己清
    await db.attachment.deleteMany({ where: { OR: [{ orderId: { startsWith: "gate-" } }, { opportunityId: { startsWith: "gate-" } }] } });
  } finally {
    await db.$disconnect();
  }
  await 切外贸(browser);
});

/** 在页面里画一张 3000×1500 的 PNG（有字有色块，压完看得出是不是那张） */
async function 大图(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 3000; c.height = 1500;
    const g = c.getContext("2d")!;
    g.fillStyle = "#e8f1fb"; g.fillRect(0, 0, 3000, 1500);
    g.fillStyle = "#1677ff"; g.fillRect(200, 200, 1200, 1100);
    g.fillStyle = "#52c41a"; g.beginPath(); g.arc(2200, 750, 500, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#111"; g.font = "bold 160px sans-serif"; g.fillText("BFQ 10kg/Box", 300, 1450);
    return c.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(b64, "base64");
}

async function 传两个(page: Page, 区: ReturnType<Page["locator"]>) {
  const 回 = page.waitForResponse((r) => r.url().includes("/api/attachments?") && r.request().method() === "POST" && r.url().includes("w="));
  await 区.locator('input[type="file"]').setInputFiles([
    { name: "产品图-冷冻鸡胸.png", mimeType: "image/png", buffer: await 大图(page) },
    { name: 长文件名, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n" + "x".repeat(180_000)) },
  ]);
  const 图 = (await (await 回).json()) as { 附件: { width: number; height: number } };
  // 长边压到 2000：3000×1500 → 2000×1000
  expect([图.附件.width, 图.附件.height]).toEqual([2000, 1000]);
  await expect(区.locator(".att-pic")).toHaveCount(1);
  await expect(区.locator(".att-files li")).toHaveCount(1);
  await expect(区.locator(".att-files li")).toContainText("Specification Sheet");
  await expect(区.locator(".att-files li")).toContainText("KB");
}

async function 截(page: Page, 名: string) {
  // 缩略图刚传完还在加载，等它真画出来再截
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".att-pic img")].every((i) => i.complete && i.naturalWidth > 0));
  await page.waitForTimeout(400);
  if (出处) { mkdirSync(出处, { recursive: true }); await page.screenshot({ path: path.join(出处, `${名}.png`) }); }
}

async function 量(page: Page, 名: string) {
  await 截(page, 名);
  const 问题 = await 查排版(page, { 忽略: [".ant-message", ".ant-notification", "nextjs-portal"] });
  expect(说问题(问题), 名).toBe("");
}

for (const 宽 of [1280, 1366]) {
  test(`${宽} 宽 · 订单详情的附件区`, async ({ page }) => {
    await page.setViewportSize({ width: 宽, height: 宽 === 1366 ? 768 : 800 });
    await 进门(page, `/orders/${订单}`);
    await 关掉弹窗(page, 2_000);
    const 区 = page.locator(".att-panel");
    await expect(区).toBeVisible();
    if ((await 区.locator(".att-pic").count()) === 0) await 传两个(page, 区);
    await 区.scrollIntoViewIfNeeded();
    await 量(page, `${宽}-订单详情`);

    // 点缩略图看大图（预览本来就盖住整页，只截图不量）
    await 区.locator(".att-pic img").first().click();
    await expect(page.locator(".ant-image-preview-img")).toBeVisible();
    await 截(page, `${宽}-订单详情-大图`);
    await page.keyboard.press("Escape");
    await expect(page.locator(".ant-image-preview-img")).toBeHidden();
  });

  test(`${宽} 宽 · 商机编辑框的附件区`, async ({ page }) => {
    await page.setViewportSize({ width: 宽, height: 宽 === 1366 ? 768 : 800 });
    await 进门(page, `/opportunities?opportunity=${商机}`);
    await 关掉弹窗(page, 2_000);
    const 框 = page.getByRole("dialog").filter({ has: page.locator(".att-panel") });
    await expect(框).toBeVisible();
    const 区 = 框.locator(".att-panel");
    if ((await 区.locator(".att-pic").count()) === 0) await 传两个(page, 区);
    await 区.scrollIntoViewIfNeeded();
    await 量(page, `${宽}-商机编辑`);
  });
}

test("删一个附件：确认以后列表里就没了，刷新也没了", async ({ page }) => {
  await 进门(page, `/orders/${订单}`);
  await 关掉弹窗(page, 2_000);
  const 区 = page.locator(".att-panel");
  await expect(区.locator(".att-files li")).toHaveCount(1);
  await 区.locator(".att-files li").getByRole("button", { name: /删掉/ }).click();
  await page.locator(".ant-popconfirm").getByRole("button", { name: /删\s*掉/ }).click();
  await expect(区.locator(".att-files li")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".att-panel .att-pic")).toHaveCount(1);
  await expect(page.locator(".att-panel .att-files li")).toHaveCount(0);
});
