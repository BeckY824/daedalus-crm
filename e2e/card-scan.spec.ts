/**
 * 扫名片（手机伴侣 /m，2026-10-19）：真在浏览器里跑 PP-OCRv6 tiny，认 e2e/fixtures/cards 下的样例名片（编的演示数据，
 * 来自 05-反馈与复盘/名片识别-实测-20261019/样例名片；客户给的真名片不进仓库）。
 *
 *   - 主入口：客户页相机图标 → 拍完直接是填好的新建表单；存完「再扫一张」，来源带到下一张
 *   - 次入口：「+」手填了名字再「拍名片自动填」，填过的不被覆盖
 *   - 韩文名片：自动换韩文识别（按需下载语言包）
 *   - 360 / 375 宽，表单每一屏跑 layout-audit；照片不发到任何接口
 *   - 2026-10-20「点了没反应」：相机没打开时给提示 +「从相册选」；「从相册选」不带 capture、走同一条识别；
 *     第一次下识别文件时说清楚大小；/m 的 Permissions-Policy 放开相机
 *   - 2026-10-20「识别模型没下载下来」（伦敦，服务器在香港）：/ocr/ 给预压缩的 br、带长度；下载有百分比；
 *     断了自动重试；一直下不来给「再试一次」，接着下能认；页面在后台时断了说「下载被中断，保持在这个页面再点一次」
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

async function 拍(page: Page, 点: () => Promise<void>, 文件: string, 相机 = true) {
  const [选] = await Promise.all([page.waitForEvent("filechooser"), 点()]);
  // 拍照带 capture（手机上直接进后置相机），从相册选不带
  expect(await 选.element().getAttribute("capture")).toBe(相机 ? "environment" : null);
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

test("从相册选：不带 capture，走同一条识别；第一次说清楚要下多大、有百分比", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const 大的 = 盯上传(page);
  await 灌手机(page, { 业务: 外贸 });
  await page.getByRole("button", { name: "客户" }).last().click();
  await page.getByTestId("m-new-customer").click();
  const 表 = page.getByTestId("m-new-customer-sheet");
  await expect(表.getByTestId("m-scan-fill-album")).toBeVisible();
  await 量(page, "扫名片-375-表单顶上两个按钮");
  await 拍(page, () => 表.getByTestId("m-scan-fill-album").click(), "02-en-uk.jpg", false);
  // 中英一套预压缩后约 11–12MB（2026-10-20 前是现压 gzip 约 18MB、说的 40MB 是没压的大小）
  await expect(表.getByTestId("m-scan-busy")).toContainText(/第一次要下载约 1[0-3]MB 识别文件，连 Wi-Fi 更快，下过一次之后没网也能认/);
  await expect(表.getByTestId("m-scan-progress")).toBeVisible();
  await 量(page, "扫名片-375-第一次下载");
  await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 120_000 });
  await expect(表.getByLabel("名字")).toHaveValue("Harbourline Lighting Ltd");
  await expect(表.getByLabel("邮箱")).toHaveValue("oliver.bennett@harbourline.co.uk");

  // 下过一次：再认就不说「第一次」了（换语言重认这一张）
  await 表.getByRole("button", { name: "中英" }).click();
  await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => localStorage.getItem("m-ocr-v1-ready"))).toBe("1");
  expect(大的, "照片不该发出去").toEqual([]);
});

test("老内核不认 imageOrientation: \"from-image\"（夸克 10.19 = Chrome 100，直接报错）：退回 <img> 读图，照样认", async ({ page }) => {
  await page.addInitScript(() => {
    const 原 = window.createImageBitmap.bind(window);
    // 学老内核：带 imageOrientation: "from-image" 就报和夸克一样的错
    window.createImageBitmap = ((src: ImageBitmapSource, ...rest: unknown[]) => {
      const 设 = rest.find((x) => x && typeof x === "object") as ImageBitmapOptions | undefined;
      if (设?.imageOrientation === "from-image") {
        return Promise.reject(new TypeError("Failed to read the 'imageOrientation' property from 'ImageBitmapOptions': The provided value 'from-image' is not a valid enum value of type ImageOrientation."));
      }
      return (原 as (...a: unknown[]) => Promise<ImageBitmap>)(src, ...rest);
    }) as typeof window.createImageBitmap;
  });
  await page.setViewportSize({ width: 375, height: 667 });
  await 灌手机(page, { 业务: 外贸 });
  await page.getByRole("button", { name: "客户" }).last().click();
  await 拍(page, () => page.getByTestId("m-scan-card").click(), "02-en-uk.jpg");
  const 表 = page.getByTestId("m-new-customer-sheet");
  await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 120_000 });
  await expect(表.getByLabel("名字")).toHaveValue("Harbourline Lighting Ltd");
  await expect(表.getByLabel("邮箱")).toHaveValue("oliver.bennett@harbourline.co.uk");
});

test("识别文件：/ocr/ 给预压缩的 br（带长度），主文件不带主线程 OpenCV", async ({ request }) => {
  const r = await request.get("/ocr/v1/paddle.js", { headers: { "accept-encoding": "gzip, deflate, br" } });
  expect(r.status()).toBe(200);
  expect(r.headers()["content-encoding"]).toBe("br");
  expect(Number(r.headers()["content-length"])).toBeLessThan(200_000);
  expect((await r.body()).length).toBeLessThan(400_000);
  const 清单 = await (await request.get("/ocr/v1/manifest.json")).json();
  expect(清单.共用).toContain("ort/ort-wasm-simd-threaded.jsep.wasm");
});

test("识别文件下到一半断了：自动重试接着认，不用人管", async ({ page }) => {
  let 断过 = 0;
  await page.route("**/ocr/v1/models/PP-OCRv6_tiny_rec.tar", (r) => (断过++ === 0 ? r.abort("connectionreset") : r.continue()));
  await page.setViewportSize({ width: 375, height: 667 });
  await 灌手机(page, { 业务: 外贸 });
  await page.getByRole("button", { name: "客户" }).last().click();
  await 拍(page, () => page.getByTestId("m-scan-card").click(), "02-en-uk.jpg");
  const 表 = page.getByTestId("m-new-customer-sheet");
  await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 150_000 });
  await expect(表.getByLabel("名字")).toHaveValue("Harbourline Lighting Ltd");
  expect(断过).toBeGreaterThanOrEqual(2);
});

test("识别文件一直下不来：说没下载下来 +「再试一次」；网好了点一下接着认", async ({ page }) => {
  let 通 = false;
  await page.route("**/ocr/v1/models/PP-OCRv6_tiny_rec.tar", (r) => (通 ? r.continue() : r.abort("internetdisconnected")));
  await page.setViewportSize({ width: 375, height: 667 });
  await 灌手机(page, { 业务: 外贸 });
  await page.getByRole("button", { name: "客户" }).last().click();
  await 拍(page, () => page.getByTestId("m-scan-card").click(), "02-en-uk.jpg");
  const 错 = page.getByTestId("m-scan-err");
  await expect(错).toContainText("识别模型没下载下来：网络不稳，点「再试一次」接着下（下完的不用重下）", { timeout: 90_000 });
  await 量(page, "扫名片-375-没下载下来");
  通 = true;
  await 错.getByTestId("m-scan-retry").click();
  const 表 = page.getByTestId("m-new-customer-sheet");
  await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 150_000 });
  await expect(表.getByLabel("名字")).toHaveValue("Harbourline Lighting Ltd");
});

test("页面在后台时下载断了：说「下载被中断，保持在这个页面再点一次」；回来点「再试一次」接着认", async ({ page }) => {
  // 学锁屏 / 切走：document.hidden 由测试控制
  await page.addInitScript(() => {
    (window as unknown as { 后台: boolean }).后台 = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => (window as unknown as { 后台: boolean }).后台 });
  });
  let 通 = false;
  await page.route("**/ocr/v1/models/PP-OCRv6_tiny_rec.tar", (r) => (通 ? r.continue() : r.abort("connectionreset")));
  await page.setViewportSize({ width: 375, height: 667 });
  await 灌手机(page, { 业务: 外贸 });
  await page.getByRole("button", { name: "客户" }).last().click();
  await 拍(page, () => page.getByTestId("m-scan-card").click(), "02-en-uk.jpg");
  const 错 = page.getByTestId("m-scan-err");
  await expect(错).toContainText("下载被中断，保持在这个页面再点一次", { timeout: 60_000 });
  await 量(page, "扫名片-375-下载被中断");
  await page.evaluate(() => { (window as unknown as { 后台: boolean }).后台 = false; });
  通 = true;
  await 错.getByTestId("m-scan-retry").click();
  const 表 = page.getByTestId("m-new-customer-sheet");
  await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 150_000 });
  await expect(表.getByLabel("名字")).toHaveValue("Harbourline Lighting Ltd");
});

for (const 宽 of [360, 375]) {
  test(`手机 ${宽} 宽：相机没打开（点了系统没弹）→ 提示 +「从相册选」走通识别`, async ({ page }) => {
    await page.setViewportSize({ width: 宽, height: 667 });
    await 灌手机(page, { 业务: 外贸 });
    await page.getByRole("button", { name: "客户" }).last().click();
    // 不接 filechooser：无头浏览器打不开选图框，100 毫秒左右直接回 cancel、页面不失焦——和安卓内置浏览器不接选图、被静默拒绝一样
    await page.getByTestId("m-scan-card").click();
    const 提示 = page.getByTestId("m-scan-nocam");
    await expect(提示).toBeVisible({ timeout: 5_000 });
    await expect(提示).toContainText("相机没打开：到系统设置里给浏览器（或微信）打开相机权限；也可以先用手机相机拍好，再点「从相册选」");
    // Safari 在支持名单里：不推荐换浏览器
    await expect(page.getByTestId("m-scan-browser")).toHaveCount(0);
    await page.waitForTimeout(450);
    const 问题 = await 查排版(page, { 范围: ".m-nav", 忽略: [".m-toast"] });
    await page.screenshot({ path: 出处(`扫名片-${宽}-相机没打开.png`) });
    expect(说问题(问题), `相机没打开-${宽}`).toBe("");

    await 拍(page, () => 提示.getByTestId("m-scan-album").click(), "01-cn-classic.jpg", false);
    await expect(提示).toBeHidden();
    const 表 = page.getByTestId("m-new-customer-sheet");
    await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 120_000 });
    await expect(表.getByLabel("电话")).toHaveValue("+8613800138001");
  });
}

test("表单里「拍名片自动填」相机没打开：表单里也给提示，「从相册选」能接着认", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await 灌手机(page, { 业务: 外贸 });
  await page.getByRole("button", { name: "客户" }).last().click();
  await page.getByTestId("m-new-customer").click();
  const 表 = page.getByTestId("m-new-customer-sheet");
  await 表.getByTestId("m-scan-fill").click();
  const 提示 = 表.getByTestId("m-scan-nocam");
  await expect(提示).toBeVisible({ timeout: 5_000 });
  await 量(page, "扫名片-375-表单里相机没打开");
  // 提示下面紧挨着就是表单那条的「从相册选」
  await 拍(page, () => 表.getByTestId("m-scan-fill-album").click(), "02-en-uk.jpg", false);
  await expect(提示).toBeHidden();
  await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 120_000 });
});

test("/m 的 Permissions-Policy 放开相机（只给自己），别的页面照旧关着", async ({ request }) => {
  const m = await request.get("/m", { maxRedirects: 0 });
  expect(m.headers()["permissions-policy"]).toBe("camera=(self), microphone=(), geolocation=()");
  const 登录 = await request.get("/login", { maxRedirects: 0 });
  expect(登录.headers()["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
});

test.describe("不在支持名单里的浏览器（QQ App 内置）", () => {
  test.use({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36 V1_AND_SQ_9.0.0_4660_YYB_D QQ/9.0.0.14110 NetType/WIFI" });
  test("375 宽：点扫名片后推荐换 Edge / Safari、教怎么跳出去；表单入口一直挂着；不拦人，从相册选照样能认", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await 灌手机(page, { 业务: 外贸 });
    await page.getByRole("button", { name: "客户" }).last().click();
    // 没点之前客户页不挂
    await expect(page.getByTestId("m-scan-browser")).toHaveCount(0);
    await page.getByTestId("m-scan-card").click();
    const 推荐 = page.getByTestId("m-scan-browser");
    await expect(推荐).toHaveText("扫名片请用 Edge（安卓）或 Safari（iPhone）打开，其他浏览器可能打不开相机。点右上角 ··· →「在浏览器打开」");
    await expect(page.getByTestId("m-scan-nocam")).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(450);
    const 问题 = await 查排版(page, { 范围: ".m-nav", 忽略: [".m-toast"] });
    await page.screenshot({ path: 出处("扫名片-375-推荐换浏览器-客户页.png") });
    expect(说问题(问题), "推荐换浏览器-客户页").toBe("");

    await page.getByTestId("m-new-customer").click();
    const 表 = page.getByTestId("m-new-customer-sheet");
    await expect(表.getByTestId("m-scan-browser")).toBeVisible();
    await 量(page, "扫名片-375-推荐换浏览器-表单");
    await 拍(page, () => 表.getByTestId("m-scan-fill-album").click(), "02-en-uk.jpg", false);
    await expect(表.getByTestId("m-scan-done")).toBeVisible({ timeout: 120_000 });
    await expect(表.getByLabel("名字")).toHaveValue("Harbourline Lighting Ltd");
  });
});
