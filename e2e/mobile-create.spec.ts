/**
 * 手机伴侣上新建客户 / 商机（2026-10-19 客户反馈第 7 条）的界面。
 *
 * 不走登录 + 电脑授权那条链路（那要真云端）：先开一次 /m 让页面建好本地库和行钥匙，再照 lib/mobile/store.ts 的格式
 * 把「已经连上团队」的状态灌进 IndexedDB（团队身份、本人、业务设置=外贸、一位老客户），刷新就进到主界面。
 * 网页模式下没有中转（/api/sync/scoped 回 404），同步一直失败——正好：新建的留在「待同步」，看得到标记，也不会被当成登录失效清掉。
 * 推到电脑那一段在 tests/team-notice-mobile-create.test.ts（真中转 + 两台电脑）。
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});

const 截 = (page: Page, 名: string) =>
  page.screenshot({ path: process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, 名) : test.info().outputPath(名) });

async function 灌好(page: Page) {
  await page.goto("/m");
  await expect(page.getByRole("button", { name: /登录/ }).first()).toBeVisible();
  await page.evaluate(async () => {
    const 开 = () => new Promise<IDBDatabase>((ok, bad) => { const r = indexedDB.open("daedalus-mobile", 1); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
    const 等 = <T,>(r: IDBRequest<T>) => new Promise<T>((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
    const db = await 开();
    const 钥 = await 等(db.transaction("kv").objectStore("kv").get("rowKey")) as CryptoKey;
    const 钟 = `${String(1760000000000).padStart(15, "0")}-seed`;
    const 行们 = [
      { t: "User", k: "acct_li", r: { id: "acct_li", name: "李娜", email: "li@e2e.local", active: true } },
      { t: "Setting", k: "business", r: { key: "business", value: JSON.stringify({ template: "trade", currency: "USD", customer: "客户", sources: ["阿里国际站", "独立站询盘", "谷歌搜索", "展会获取", "WhatsApp", "邮件开发", "领英", "老客户返单", "转介绍", "其他"] }) } },
      { t: "Customer", k: "c-old", r: { id: "c-old", name: "Atlas Home Supplies", phone: "+14155550132", salesOwnerId: "acct_li", followStatus: "跟进中", createdAt: Date.now() - 86400_000, updatedAt: Date.now() - 86400_000 } },
      { t: "CustomerExtra", k: "c-old", r: { customerId: "c-old", country: "美国", whatsapp: "+14155550132", email: "maria@atlas.example" } },
    ];
    const 密的 = [];
    for (const x of 行们) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const 钟们 = Object.fromEntries(Object.keys(x.r).map((k) => [k, 钟]));
      密的.push([`${x.t}:${x.k}`, { iv, ct: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, 钥, new TextEncoder().encode(JSON.stringify({ ...x, 钟: 钟们 }))) }] as const);
    }
    const t = db.transaction(["rows", "kv"], "readwrite");
    for (const [k, v] of 密的) t.objectStore("rows").put(v, k);
    t.objectStore("kv").put("dk_e2e_fake_token", "token");
    t.objectStore("kv").put({ teamId: "t_e2e", device: "m_e2e", key: "A".repeat(43), epoch: 0, keys: {}, userId: "acct_li", 私钥: { raw: new Uint8Array(32) } }, "team");
    t.objectStore("kv").put({ name: "李娜", contact: "li@e2e.local" }, "account");
    t.objectStore("kv").put("E2E 团队", "teamName");
    await new Promise<void>((ok, bad) => { t.oncomplete = () => ok(); t.onerror = () => bad(t.error); });
    db.close();
  });
  await page.reload();
  await page.getByRole("button", { name: "客户" }).last().click();
  await expect(page.getByText("Atlas Home Supplies")).toBeVisible();
}

test("手机新建客户（外贸）：至少一个联系方式，存下就进详情、标着待同步；再在详情里建商机", async ({ page }) => {
  await 灌好(page);
  await expect(page.getByTestId("m-new-customer")).toBeVisible();
  await 截(page, "02-手机-客户列表右上角加号.png");
  await page.getByTestId("m-new-customer").click();
  const 表 = page.getByTestId("m-new-customer-sheet");
  await expect(表.getByText("新建客户")).toBeVisible();
  const 存 = 表.getByRole("button", { name: "保存" }).first();
  await 表.getByLabel("名字").fill("Nordlicht Leuchten GmbH");
  // 只有名字：保存是灰的（电话、WhatsApp、邮箱至少一个）
  await expect(存).toBeDisabled();
  await 表.getByLabel("WhatsApp").fill("+49 151 2345 6789");
  await 表.getByLabel("邮箱").fill("einkauf@nordlicht.example");
  await 表.getByLabel("国家").fill("德国");
  await 表.getByRole("button", { name: "展会获取" }).click();
  await expect(存).toBeEnabled();
  await 截(page, "03-手机-新建客户.png");

  // 撞号：手机上已有的号码挡住，表单不关、错就写在表里
  await 表.getByLabel("电话").fill("+1 415 555 0132");
  await 存.click();
  await expect(表.getByRole("alert")).toContainText("已经有了：Atlas Home Supplies");
  await 表.getByLabel("电话").fill("");
  await 存.click();

  // 存好进详情
  await expect(page.getByTestId("m-new-customer-sheet")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Nordlicht Leuchten GmbH" })).toBeVisible();
  await expect(page.getByText("🇩🇪 德国").first()).toBeVisible();

  await page.getByTestId("m-new-opp").click();
  const 商 = page.getByTestId("m-new-opp-sheet");
  await 商.getByLabel("商机名称").fill("工矿灯 2000 套");
  await 商.getByLabel(/金额/).fill("36000");
  // 外贸模版的阶段叫法；没有「客户确认」（赢单 / 转订单在电脑上）
  await expect(商.getByRole("radio")).toHaveText(["询盘", "比价中", "已报价", "寄样"]);
  await 商.getByRole("radio", { name: "已报价" }).click();
  await expect(商.getByRole("radio", { name: "已报价" })).toHaveAttribute("aria-checked", "true");
  await expect(商.getByRole("radio", { name: "询盘" })).toHaveAttribute("aria-checked", "false");
  await page.waitForTimeout(400); // 等选中的底色过渡完再拍
  await 截(page, "04-手机-新建商机.png");
  await 商.getByRole("button", { name: "保存" }).first().click();
  await expect(page.getByTestId("m-new-opp-sheet")).toHaveCount(0);
  await expect(page.getByText("工矿灯 2000 套")).toBeVisible();
  await expect(page.getByText("已报价")).toBeVisible();
  await expect(page.getByText("待同步").first()).toBeVisible();
  await page.waitForTimeout(2600); // 等「商机已建好」提示收起
  await 截(page, "05-手机-建好后的详情.png");
});
