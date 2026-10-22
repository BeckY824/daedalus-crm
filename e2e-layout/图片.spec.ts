/**
 * 商机 / 订单的「图片」区（2026-10-22 D-24）在 Windows 常见宽度下的样子。
 *
 * 数据用 e2e-layout/种子.ts（长英文公司名、一整句英文商机名），再真传一张 3000×1500 的 PNG、一张 800×600 的 JPEG：
 *   - 图片在这台电脑上压到长边 2000（看接口回的宽高），出缩略图，点开看大图
 *   - 1280 / 1366 宽，订单详情和商机编辑框各跑一遍 layout-audit，截图
 *   - 选 PDF 当场说「不是图片」，一张也不多
 *   - 删掉一张，列表里就没了
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { 连库, 我的id, 进门 } from "../e2e-desktop/helpers";
import { 查排版, 说问题 } from "../e2e/layout-audit";
import { 灌真客户 } from "./种子";
import { 关掉弹窗, 切外贸 } from "./外贸模版";

test.describe.configure({ mode: "serial" });
const 出处 = process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, "图片") : null;
const 订单 = "gate-scandi-t0";
const 商机 = "gate-scandi-o1";

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

/** 在页面里画一张图（有字有色块，压完看得出是不是那张）：默认 3000×1500 的 PNG */
async function 画图(page: Page, 宽 = 3000, 高 = 1500, 类型 = "image/png"): Promise<Buffer> {
  const b64 = await page.evaluate(([宽, 高, 类型]) => {
    const c = document.createElement("canvas");
    c.width = 宽; c.height = 高;
    const g = c.getContext("2d")!;
    g.scale(宽 / 3000, 高 / 1500);
    g.fillStyle = "#e8f1fb"; g.fillRect(0, 0, 3000, 1500);
    g.fillStyle = "#1677ff"; g.fillRect(200, 200, 1200, 1100);
    g.fillStyle = "#52c41a"; g.beginPath(); g.arc(2200, 750, 500, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#111"; g.font = "bold 160px sans-serif"; g.fillText("BFQ 10kg/Box", 300, 1450);
    return c.toDataURL(类型).split(",")[1];
  }, [宽, 高, 类型] as const);
  return Buffer.from(b64, "base64");
}

async function 传两张(page: Page, 区: ReturnType<Page["locator"]>) {
  const 回 = page.waitForResponse((r) => r.url().includes("/api/attachments?") && r.request().method() === "POST" && r.url().includes("w=2000"));
  await 区.locator('input[type="file"]').setInputFiles([
    { name: "产品图-正面 Front View 3000x1500.png", mimeType: "image/png", buffer: await 画图(page) },
    { name: "包装箱-侧面.jpg", mimeType: "image/jpeg", buffer: await 画图(page, 800, 600, "image/jpeg") },
  ]);
  const 图 = (await (await 回).json()) as { 附件: { width: number; height: number } };
  // 长边压到 2000：3000×1500 → 2000×1000
  expect([图.附件.width, 图.附件.height]).toEqual([2000, 1000]);
  await expect(区.locator(".att-pic")).toHaveCount(2);
  await expect(区.locator(".att-files li")).toHaveCount(0);
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
  test(`${宽} 宽 · 订单详情的图片区`, async ({ page }) => {
    await page.setViewportSize({ width: 宽, height: 宽 === 1366 ? 768 : 800 });
    await 进门(page, `/orders/${订单}`);
    await 关掉弹窗(page, 2_000);
    const 区 = page.locator(".att-panel");
    await expect(区).toBeVisible();
    if ((await 区.locator(".att-pic").count()) === 0) await 传两张(page, 区);
    await 区.scrollIntoViewIfNeeded();
    await 量(page, `${宽}-订单详情`);

    // 点缩略图看大图（预览本来就盖住整页，只截图不量）
    await 区.locator(".att-pic img").first().click();
    await expect(page.locator(".ant-image-preview-img")).toBeVisible();
    await 截(page, `${宽}-订单详情-大图`);
    await page.keyboard.press("Escape");
    await expect(page.locator(".ant-image-preview-img")).toBeHidden();
  });

  test(`${宽} 宽 · 商机编辑框的图片区`, async ({ page }) => {
    await page.setViewportSize({ width: 宽, height: 宽 === 1366 ? 768 : 800 });
    await 进门(page, `/opportunities?opportunity=${商机}`);
    await 关掉弹窗(page, 2_000);
    const 框 = page.getByRole("dialog").filter({ has: page.locator(".att-panel") });
    await expect(框).toBeVisible();
    const 区 = 框.locator(".att-panel");
    if ((await 区.locator(".att-pic").count()) === 0) await 传两张(page, 区);
    await 区.scrollIntoViewIfNeeded();
    await 量(page, `${宽}-商机编辑`);
  });
}

test("选了 PDF：当场说不是图片，一张也不多传", async ({ page }) => {
  await 进门(page, `/orders/${订单}`);
  await 关掉弹窗(page, 2_000);
  const 区 = page.locator(".att-panel");
  await expect(区.locator(".att-pic")).toHaveCount(2);
  const 选 = 区.locator('input[type="file"]');
  // 选文件框本身只列图片
  await expect(选).toHaveAttribute("accept", /image\/png/);
  let 发了 = 0;
  page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/attachments")) 发了++; });
  await 选.setInputFiles([{ name: "规格书.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n" + "x".repeat(20_000)) }]);
  await expect(page.locator(".ant-message")).toContainText("不是图片");
  await expect(区.locator(".att-pic")).toHaveCount(2);
  expect(发了).toBe(0);
});

test("删一张图片：确认以后列表里就没了，刷新也没了", async ({ page }) => {
  await 进门(page, `/orders/${订单}`);
  await 关掉弹窗(page, 2_000);
  const 区 = page.locator(".att-panel");
  await expect(区.locator(".att-pic")).toHaveCount(2);
  await 区.locator(".att-pic").filter({ hasText: "包装箱" }).getByRole("button", { name: /删掉/ }).click();
  await page.locator(".ant-popconfirm").getByRole("button", { name: /删\s*掉/ }).click();
  await expect(区.locator(".att-pic")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".att-panel .att-pic")).toHaveCount(1);
  await expect(page.locator(".att-panel .att-pic")).toContainText("产品图-正面");
});
