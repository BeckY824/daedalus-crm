/**
 * 手机伴侣只读看团队的产品图片（2026-10-22 D-24）：客户详情列这位客户商机、订单上的图，前几张自动取来当缩略图，点开全屏看。
 *
 * 和 mobile-create 一样不走登录 + 授权（e2e/mobile-seed.ts 灌好「已经连上团队」的状态，团队钥匙是 "A"×43、编号 0）；
 * 图片通道（/api/sync/attach）用 page.route 接住，回桌面端 封附件 封好的密文——和真云端回的是同一份字节。
 * 云端的权限、续传在 tests/sync-attach.test.ts，解密、核 sha256 的各种情况在 tests/mobile-attach.test.ts。
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { 封附件 } from "../src/lib/sync/crypto";
import { 灌手机 } from "./mobile-seed";

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});

const 截 = (page: Page, 名: string) =>
  page.screenshot({ path: process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, 名) : test.info().outputPath(名) });

const 图 = readFileSync(path.join(__dirname, "fixtures/cards/02-en-uk.jpg"));
const sha = createHash("sha256").update(图).digest("hex");
const 密文 = (id: string) => 封附件(图, "A".repeat(43), 0, { teamId: "t_e2e", id, sha256: sha });

test("客户详情：商机、订单上的产品图片自动取来当缩略图，点开全屏看；还在上传的说清楚", async ({ page }) => {
  const 问过: string[] = [];
  await page.route("**/api/sync/attach?**", (r) => {
    const u = new URL(r.request().url());
    const id = u.searchParams.get("id") ?? "";
    问过.push(`${id}@${u.searchParams.get("device")}`);
    if (id === "a_up") return r.fulfill({ status: 404, json: { error: "对方还在上传，稍后再看", uploading: true } });
    return r.fulfill({ status: 200, body: 密文(id), contentType: "application/octet-stream" });
  });
  await 灌手机(page, {
    行们: [
      { t: "Customer", k: "c1", r: { id: "c1", name: "Atlas Home", salesOwnerId: "acct_li", followStatus: "意向较高" } },
      { t: "Opportunity", k: "o1", r: { id: "o1", customerId: "c1", name: "春季家居", amount: 186000, stage: "方案报价", status: "OPEN" } },
      { t: "TradeOrder", k: "t1", r: { id: "t1", customerId: "c1", no: "PI-001" } },
      { t: "Attachment", k: "a1", r: { id: "a1", opportunityId: "o1", name: "样品正面.jpg", mime: "image/jpeg", size: 图.length, sha256: sha, createdAt: 1760000000000 } },
      { t: "Attachment", k: "a2", r: { id: "a2", orderId: "t1", name: "包装.jpg", mime: "image/jpeg", size: 图.length, sha256: sha, createdAt: 1760000100000 } },
      { t: "Attachment", k: "a_up", r: { id: "a_up", opportunityId: "o1", name: "刚拍的.jpg", mime: "image/jpeg", size: 图.length, sha256: sha, createdAt: 1760000200000 } },
    ],
  });
  await page.getByRole("button", { name: "客户" }).last().click();
  await page.getByText("Atlas Home").first().click();

  const 卡 = page.getByTestId("m-images");
  await expect(卡.getByText("3 张")).toBeVisible();
  // 前几张自动取：解开、核过 sha256 的显示成缩略图；还在上传的留占位
  await expect(卡.locator("img")).toHaveCount(2);
  await expect(卡.getByText("订单 PI-001")).toBeVisible();
  expect(问过.every((x) => x.endsWith("@m_e2e"))).toBe(true);
  await 截(page, "mobile-images-详情.png");

  await 卡.getByRole("button", { name: "看图片 包装.jpg" }).click();
  const 大图 = page.getByRole("dialog", { name: "包装.jpg" });
  await expect(大图.locator("img")).toBeVisible();
  await expect(大图.getByText("订单 PI-001 ·")).toBeVisible();
  await expect(大图).toHaveCSS("opacity", "1");
  await 截(page, "mobile-images-大图.png");
  await 大图.click();
  await expect(大图).toBeHidden();
  // 安卓返回键 / 手势：先关大图，详情还在
  await 卡.getByRole("button", { name: "看图片 样品正面.jpg" }).click();
  await expect(page.getByRole("dialog", { name: "样品正面.jpg" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "样品正面.jpg" })).toBeHidden();
  await expect(卡).toBeVisible();
  // 在大图上连点两下：第二下落在还在淡出的大图上，只关大图，详情不跟着退
  await 卡.getByRole("button", { name: "看图片 样品正面.jpg" }).click();
  const 再开 = page.getByRole("dialog", { name: "样品正面.jpg" });
  await expect(再开).toHaveCSS("opacity", "1");
  const 框 = (await 再开.boundingBox())!;
  await page.mouse.click(框.x + 框.width / 2, 框.y + 框.height / 2);
  await page.waitForTimeout(80);
  await page.mouse.click(框.x + 框.width / 2, 框.y + 框.height / 2);
  await expect(再开).toBeHidden();
  await page.waitForTimeout(800);
  await expect(卡).toBeVisible();

  await 卡.getByRole("button", { name: "看图片 刚拍的.jpg" }).click();
  await expect(page.getByRole("dialog", { name: "刚拍的.jpg" }).getByText("对方还在上传，稍后再看")).toBeVisible();
});

test("取图时断了网：联网后（下一次同步连上）自动补取，不用一张张点", async ({ page }) => {
  let 断 = true;
  const 问过: string[] = [];
  await page.route("**/api/sync/attach?**", (r) => {
    const id = new URL(r.request().url()).searchParams.get("id") ?? "";
    问过.push(id);
    if (id === "a_up") return r.fulfill({ status: 404, json: { error: "对方还在上传，稍后再看", uploading: true } });
    if (id === "a2" && 断) return r.abort("internetdisconnected");
    return r.fulfill({ status: 200, body: 密文(id), contentType: "application/octet-stream" });
  });
  await 灌手机(page, {
    行们: [
      { t: "Customer", k: "c1", r: { id: "c1", name: "Atlas Home", salesOwnerId: "acct_li", followStatus: "意向较高" } },
      { t: "Opportunity", k: "o1", r: { id: "o1", customerId: "c1", name: "春季家居", amount: 186000, stage: "方案报价", status: "OPEN" } },
      { t: "Attachment", k: "a1", r: { id: "a1", opportunityId: "o1", name: "样品正面.jpg", mime: "image/jpeg", size: 图.length, sha256: sha, createdAt: 1760000000000 } },
      { t: "Attachment", k: "a2", r: { id: "a2", opportunityId: "o1", name: "包装.jpg", mime: "image/jpeg", size: 图.length, sha256: sha, createdAt: 1760000100000 } },
      { t: "Attachment", k: "a_up", r: { id: "a_up", opportunityId: "o1", name: "刚拍的.jpg", mime: "image/jpeg", size: 图.length, sha256: sha, createdAt: 1760000200000 } },
    ],
  });
  await page.getByRole("button", { name: "客户" }).last().click();
  await page.getByText("Atlas Home").first().click();
  const 卡 = page.getByTestId("m-images");
  await expect(卡.locator("img")).toHaveCount(1);
  await expect.poll(() => 问过.filter((x) => x === "a2").length).toBe(1);

  // 网回来了：下一次同步连上（这里的同步回 404，但连上了），断了的、还在上传的都再取一次
  断 = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(卡.locator("img")).toHaveCount(2);
  expect(问过.filter((x) => x === "a2")).toHaveLength(2);
  await expect.poll(() => 问过.filter((x) => x === "a_up").length).toBe(2);
  expect(问过.filter((x) => x === "a1")).toHaveLength(1);
});
