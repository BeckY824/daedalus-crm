/**
 * 扫名片（手机伴侣 /m，2026-10-19）：真在浏览器里跑 PP-OCRv6 tiny，认 e2e/fixtures/cards 下的样例名片（编的演示数据，
 * 来自 05-反馈与复盘/名片识别-实测-20261019/样例名片；客户给的真名片不进仓库）。
 *
 *   - 主入口：客户页相机图标 → 拍完直接是填好的新建表单；存完「再扫一张」，来源带到下一张
 *   - 次入口：「+」手填了名字再「拍名片自动填」，填过的不被覆盖
 *   - 韩文名片：自动换韩文识别（按需下载语言包）
 *   - 360 / 375 宽，表单每一屏跑 layout-audit；照片不发到任何接口
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { 查排版, 说问题 } from "./layout-audit";
import { 灌手机, 外贸来源 } from "./mobile-seed";

const 卡 = (n: string) => path.join(__dirname, "fixtures/cards", n);
const 出处 = (名: string) => (process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, 名) : test.info().outputPath(名));

test.use({
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});
// 第一次要载模型（几 MB）+ 认图，CI 机器慢
test.setTimeout(180_000);

async function 拍(page: Page, 点: () => Promise<void>, 文件: string) {
  const [选] = await Promise.all([page.waitForEvent("filechooser"), 点()]);
  await 选.setFiles(卡(文件));
}

async function 量(page: Page, 名: string) {
  await page.waitForTimeout(450);
  const 问题 = await 查排版(page, { 范围: ".m-sheet", 忽略: [".m-toast"] });
  if (问题.length || process.env.E2E_SHOT_DIR) await page.screenshot({ path: 出处(`${名}.png`) });
  expect(说问题(问题), 名).toBe("");
}

/** 照片不上传：扫名片期间没有带大块数据的请求（同步、问同事只发文字） */
function 盯上传(page: Page) {
  const 大的: string[] = [];
  page.on("request", (r) => { const n = r.postDataBuffer()?.length ?? 0; if (n > 20_000) 大的.push(`${r.method()} ${r.url()} ${n}B`); });
  return 大的;
}

const 外贸 = { template: "trade", currency: "USD", customer: "客户", sources: 外贸来源 };

for (const 宽 of [360, 375]) {
  test(`手机 ${宽} 宽：扫名片 → 填好的表单 → 存 → 再扫一张（来源带上）`, async ({ page }) => {
    await page.setViewportSize({ width: 宽, height: 667 });
    const 大的 = 盯上传(page);
    await 灌手机(page, { 业务: 外贸 });
    await page.getByRole("button", { name: "客户" }).last().click();
    await 拍(page, () => page.getByTestId("m-scan-card").click(), "02-en-uk.jpg");
    const 表 = page.getByTestId("m-new-customer-sheet");
    await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 120_000 });
    // 外贸：名字格放公司，人名 + 职位进备注
    await expect(表.getByLabel("名字")).toHaveValue("Harbourline Lighting Ltd");
    await expect(表.getByLabel("电话")).toHaveValue("+447700900123");
    await expect(表.getByLabel("邮箱")).toHaveValue("oliver.bennett@harbourline.co.uk");
    await expect(表.getByLabel("国家")).toHaveValue("英国");
    await expect(表.getByLabel("备注")).toHaveValue(/联系人：Oliver Bennett（Purchasing Manager）/);
    await 量(page, `扫名片-${宽}-填好的表单`);

    await 表.getByLabel("来源").fill("2026 迪拜展");
    await 表.getByRole("button", { name: "保存" }).last().click();
    const 好 = page.getByTestId("m-scan-saved");
    await expect(好).toContainText("已存好「Harbourline Lighting Ltd」");
    await 量(page, `扫名片-${宽}-存好了`);

    await 拍(page, () => 好.getByTestId("m-scan-again").click(), "08-en-uae-whatsapp.jpg");
    await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 120_000 });
    await expect(表.getByLabel("名字")).toHaveValue("Al Faris General Trading LLC");
    await expect(表.getByLabel("来源")).toHaveValue("2026 迪拜展");
    await expect(表.getByLabel("WhatsApp")).not.toHaveValue("");
    await 量(page, `扫名片-${宽}-再扫一张`);
    expect(大的, "照片不该发出去").toEqual([]);
  });
}

test("次入口：先手填了名字再「拍名片自动填」，填过的不被覆盖、只补空格", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await 灌手机(page, { 业务: 外贸 });
  await page.getByRole("button", { name: "客户" }).last().click();
  await page.getByTestId("m-new-customer").click();
  const 表 = page.getByTestId("m-new-customer-sheet");
  await 表.getByLabel("名字").fill("王总（展会上认识的）");
  await 拍(page, () => 表.getByTestId("m-scan-fill").click(), "01-cn-classic.jpg");
  await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 120_000 });
  await expect(表.getByLabel("名字")).toHaveValue("王总（展会上认识的）");
  await expect(表.getByLabel("电话")).toHaveValue("+8613800138001");
  await expect(表.getByLabel("微信")).toHaveValue("wanglei_led");
  await expect(表.getByLabel("国家")).toHaveValue("中国");
  await 量(page, "扫名片-375-次入口");
});

test("韩文名片：中英认不好，自动下韩文识别再认", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await 灌手机(page, { 业务: 外贸 });
  await page.getByRole("button", { name: "客户" }).last().click();
  await 拍(page, () => page.getByTestId("m-scan-card").click(), "m01-kr-local.jpg");
  const 表 = page.getByTestId("m-new-customer-sheet");
  await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 150_000 });
  await expect(表.getByRole("button", { name: "自动·韩" })).toBeVisible();
  await expect(表.getByLabel("名字")).toHaveValue(/한빛수산/);
  await expect(表.getByLabel("国家")).toHaveValue("韩国");
  await 量(page, "扫名片-375-韩文自动");
});
