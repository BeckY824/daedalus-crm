/**
 * 手机伴侣 /m 的排版压力走查（2026-10-19 团队版主动排查）：几种常见手机宽度 × 刁钻数据，每一屏都用 layout-audit 量一遍。
 *
 *   宽度：360（常见安卓）、375（iPhone SE / mini）、412（大屏安卓）、430（iPhone Pro Max）
 *   数据：超长英文公司名、一长串不带空格的、阿拉伯文、俄文、emoji、超长中文公司名、超大金额、超长订单号 / 商机名、
 *        长邮箱、长网址的跟进、公海客户、同事记的跟进、过期计划、同步被拒的几条、超长团队名 / 账号名
 *
 * 发现的问题写进 E2E_SHOT_DIR/手机排版问题.json（没有就写进 test 输出目录），有问题的那一屏截图。
 * TEAM_QA_REPORT=1 时只记不判（走查用）；平时当回归测试跑，有问题就红。
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { 查排版, 说问题, type 排版问题 } from "./layout-audit";
import { 灌手机, 外贸来源, type 种子行 } from "./mobile-seed";

const 宽们 = [360, 375, 412, 430];
const 只记 = process.env.TEAM_QA_REPORT === "1";
const 出处 = (名: string) => (process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, 名) : test.info().outputPath(名));

const 天 = 86400_000;
const 现在 = Date.now();
const 名们 = {
  长英: "Al-Rashid Trading & Contracting Company W.L.L. — Lighting & Electrical Division (Riyadh Branch)",
  不断: "Supercalifragilisticexpialidociouslightingcompanyinternationallimited",
  阿拉伯: "شركة النور للتجارة والمقاولات الكهربائية المحدودة",
  俄: "ООО «Светотехническая компания Северо-Западного федерального округа»",
  表情: "🌟Sunny 灯饰🌈✨有限公司😀😀👍🏽👨‍👩‍👧‍👦",
  长中: "深圳市宝安区福永街道某某照明电器科技股份有限公司东莞分公司（外贸二部）",
};
const 长邮箱 = "procurement.department.lighting.projects@alrashid-trading-and-contracting.example.com";
const 长单号 = "PI-2026-10-19-ALRASHID-RIYADH-0001234567890";
const 长商机 = "沙特利雅得新城 NEOM 配套道路照明二期项目 LED 路灯 12000 套 + 智能控制系统 + 五年质保";
const 长网址 = "https://www.alrashid-trading-and-contracting.example.com/procurement/tenders/2026/lighting/specification-sheet-v3-final-final.pdf";

function 压力数据(): 种子行[] {
  const 行: 种子行[] = [{ t: "User", k: "acct_wang", r: { id: "acct_wang", name: "王磊（华东区销售总监 · 兼外贸二部负责人）", active: true } }];
  let i = 0;
  for (const [k, name] of Object.entries(名们)) {
    i++;
    const id = `c-${k}`;
    行.push({ t: "Customer", k: id, r: { id, name, phone: `+96650000${String(i).padStart(4, "0")}`, salesOwnerId: "acct_li", followStatus: i % 2 ? "跟进中" : "待跟进", createdAt: 现在 - i * 天, updatedAt: 现在 - i * 天 } });
    行.push({ t: "CustomerExtra", k: id, r: { customerId: id, country: i % 3 === 0 ? "沙特阿拉伯" : i % 3 === 1 ? "俄罗斯" : "阿拉伯联合酋长国", whatsapp: `+9665000000${i}`, email: 长邮箱, wechat: `wxid_${"a".repeat(30)}${i}` } });
    行.push({ t: "Contact", k: `ct-${k}`, r: { id: `ct-${k}`, customerId: id, name: `${name} 采购经理 Mohammed bin Abdullah Al-Rashid`, position: "Senior Procurement Manager (Lighting & Electrical)", phone: "+966 50 000 0000", email: 长邮箱, wechat: "", isPrimary: true } });
    行.push({ t: "Opportunity", k: `o-${k}`, r: { id: `o-${k}`, customerId: id, name: 长商机, stage: "方案报价", status: "OPEN", amount: 123456789012.34, ownerId: "acct_li", createdAt: 现在 - 天, updatedAt: 现在 - 天, activityAt: 现在 - 天 } });
    行.push({ t: "OpportunityMoney", k: `o-${k}`, r: { opportunityId: `o-${k}`, currency: i % 2 ? "USD" : "AED" } });
    行.push({ t: "TradeOrder", k: `t-${k}`, r: { id: `t-${k}`, no: 长单号, customerId: id, ownerId: "acct_li", amount: 98765432.1, currency: "USD", createdAt: 现在 - 天, updatedAt: 现在 - 天 } });
    行.push({ t: "FollowUp", k: `f-${k}-1`, r: { id: `f-${k}-1`, customerId: id, type: "WECHAT", content: `对方要规格书：${长网址}\n${"很长的一段沟通记录，".repeat(12)}`, occurredAt: 现在 - 2 * 天, ownerId: "acct_wang", opportunityId: `o-${k}` } });
    行.push({ t: "FollowUp", k: `f-${k}-2`, r: { id: `f-${k}-2`, customerId: id, type: "WHATSAPP", content: "Supercalifragilisticexpialidocious".repeat(4), occurredAt: 现在 - 3 * 天, ownerId: "acct_li" } });
    行.push({ t: "FollowUpOrder", k: `f-${k}-2`, r: { followUpId: `f-${k}-2`, orderId: `t-${k}`, nodeIdx: 0 } });
    // 过期 / 今天 / 之后的计划：今天页三组都有
    行.push({ t: "FollowPlan", k: `p-${k}`, r: { id: `p-${k}`, customerId: id, subject: `${长商机}——确认样品和报价`, plannedAt: 现在 + (i - 3) * 天, method: "微信沟通", done: false, ownerId: "acct_li" } });
  }
  // 公海客户
  for (let j = 0; j < 3; j++) {
    const id = `pool-${j}`;
    行.push({ t: "Customer", k: id, r: { id, name: `${名们.长英} 公海 ${j}`, phone: `+97150000000${j}`, salesOwnerId: "acct_wang", followStatus: "待跟进", createdAt: 现在 - 9 * 天, updatedAt: 现在 - 9 * 天 } });
    行.push({ t: "CustomerPool", k: id, r: { customerId: id, reason: "超过 30 天没跟进，自动退回公海" } });
  }
  return 行;
}

const 被拒 = [0, 1, 2].map((j) => ({
  改动: { t: "FollowUp", k: `rej-${j}`, o: "I", r: { id: `rej-${j}`, customerId: "c-长英", type: "WECHAT", content: `被拒的一条：${长网址} ${"内容很长".repeat(20)}`, occurredAt: 现在 - j * 天, ownerId: "acct_li" }, c: [], h: "" },
  原因: "这位客户已经转给了王磊（华东区销售总监 · 兼外贸二部负责人），你没有权限再记它的跟进；内容已留在这里可以复制",
}));

test.use({
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});

type 记录 = { 宽: number; 屏: string; 问题: 排版问题[] };
const 全部: 记录[] = [];

async function 量(page: Page, 宽: number, 屏: string, 范围?: string) {
  await page.waitForTimeout(450); // 等抽屉 / 弹簧动画停
  const 问题 = await 查排版(page, { 范围, 忽略: [".m-toast"] });
  全部.push({ 宽, 屏, 问题 });
  if (问题.length) await page.screenshot({ path: 出处(`手机-${宽}-${屏}.png`) });
}
/** 把页面里所有能竖着滚的都滚到底 */
const 滚到底 = (page: Page) => page.evaluate(() => {
  for (const e of document.querySelectorAll("*")) if (e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
});

for (const 宽 of 宽们) {
  test(`手机 ${宽} 宽：刁钻数据下每一屏不撑破、不出界、不被盖住`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 宽, height: 宽 <= 375 ? 667 : 915 });
    await 灌手机(page, {
      我名: "李娜 Lina Abdullah Al-Rashid", 团队名: "深圳市某某照明电器科技股份有限公司外贸二部（中东 / 东欧）", 账号: { name: "李娜 Lina Abdullah Al-Rashid", contact: 长邮箱 },
      业务: { template: "trade", currency: "USD", customer: "客户", sources: 外贸来源 }, 行们: 压力数据(), 被拒,
    });
    await expect(page.getByRole("button", { name: "今天" }).last()).toBeVisible();
    await page.getByRole("button", { name: "今天" }).last().click();
    await 量(page, 宽, "今天");
    await 滚到底(page);
    await 量(page, 宽, "今天-底部");

    await page.getByRole("button", { name: "客户" }).last().click();
    await 量(page, 宽, "客户列表");
    await page.getByText(/^公海/).first().click();
    await 量(page, 宽, "公海");
    await page.getByText(/^我的客户/).first().click();
    await page.getByPlaceholder(/公司、联系人/).fill("Supercalifragilistic");
    await 量(page, 宽, "搜索");
    await page.getByRole("button", { name: "清空" }).click();

    for (const k of Object.keys(名们)) {
      await page.getByText(名们[k as keyof typeof 名们], { exact: true }).first().click();
      await expect(page.getByRole("heading", { name: 名们[k as keyof typeof 名们] })).toBeVisible();
      await 量(page, 宽, `详情-${k}`);
      await 滚到底(page);
      await 量(page, 宽, `详情-${k}-底部`);
      if (k === "长英") {
        await page.getByRole("button", { name: "记一笔跟进" }).click();
        await page.getByTestId("m-record-link").selectOption({ index: 1 });
        await 量(page, 宽, "记跟进", ".m-sheet");
        await page.getByRole("button", { name: /取消/ }).first().click();
        await page.waitForTimeout(400);
        await 滚到底(page);
        const 再建 = page.getByText("再建一个商机");
        if (await 再建.isVisible()) {
          await 再建.click();
          await page.getByLabel("商机名称").fill(长商机);
          await page.getByLabel(/金额/).fill("123456789012");
          await 量(page, 宽, "新建商机", ".m-sheet");
          await page.getByRole("button", { name: /取消/ }).first().click();
          await page.waitForTimeout(400);
        }
      }
      await page.getByRole("button", { name: "返回" }).last().click();
      await page.waitForTimeout(350);
    }

    await page.getByTestId("m-new-customer").click();
    const 表 = page.getByTestId("m-new-customer-sheet");
    await 表.getByLabel("名字").fill(名们.长英);
    await 表.getByLabel("邮箱").fill(长邮箱);
    await 表.getByLabel("电话").fill("+966500000001");
    await 表.getByRole("button", { name: "保存" }).first().click();
    await expect(表.getByRole("alert")).toBeVisible();
    await 量(page, 宽, "新建客户-撞号", ".m-sheet");
    await 滚到底(page);
    await 量(page, 宽, "新建客户-底部", ".m-sheet");
    await page.getByRole("button", { name: /取消/ }).first().click();
    await page.waitForTimeout(400);

    await page.getByRole("button", { name: "我的" }).click();
    await 量(page, 宽, "我的", ".m-sheet");
    await 滚到底(page);
    await 量(page, 宽, "我的-底部", ".m-sheet");
    const 没同步上 = page.getByText(/没同步上/).first();
    if (await 没同步上.isVisible()) {
      await 没同步上.click();
      await 量(page, 宽, "没同步上的记录", ".m-sheet");
    }

    const 有的 = 全部.filter((x) => x.宽 === 宽 && x.问题.length);
    fs.mkdirSync(path.dirname(出处("x")), { recursive: true });
    fs.writeFileSync(出处(`手机排版问题-${宽}.json`), JSON.stringify(有的, null, 2));
    if (!只记) expect(有的.map((x) => `${x.屏}\n${说问题(x.问题)}`).join("\n\n")).toBe("");
  });
}

/*
 * 10-19 新加的两屏也过一遍排版检查：
 *   - 个人版账号在手机上登录（客户反馈「手机点了 电脑没跳出来匹配」）：只给说明、不生成配对数字、不发申请；「退出登录」回到登录页
 *   - 公海客户详情的「领取并记跟进」和弹层
 */
for (const 宽 of [360, 375]) {
  test(`手机 ${宽} 宽：个人版账号登录只给说明、不发申请`, async ({ page }) => {
    await page.setViewportSize({ width: 宽, height: 667 });
    const 发过: string[] = [];
    await page.route("**/api/mobile/link", async (r) => {
      const 动作 = String((r.request().postDataJSON() as { action?: string } | null)?.action);
      发过.push(动作);
      await r.fulfill({ json: 动作 === "eligibility" ? { ok: true, status: "no-team" } : { error: "不该发到这里" }, status: 动作 === "eligibility" ? 200 : 500 });
    });
    await page.goto("/m");
    await expect(page.getByRole("button", { name: /登录/ }).first()).toBeVisible();
    // 登录这一步要真云端：直接把登录拿到的令牌放进本地库，刷新就进「授权」那一步
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((ok, bad) => { const r = indexedDB.open("daedalus-mobile", 1); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
      const t = db.transaction("kv", "readwrite");
      t.objectStore("kv").put("dk_e2e_solo_token", "token");
      t.objectStore("kv").put({ name: "个人版用户 Personal Edition User", contact: "solo.personal.edition@example.com" }, "account");
      await new Promise<void>((ok, bad) => { t.oncomplete = () => ok(); t.onerror = () => bad(t.error); });
      db.close();
    });
    await page.reload();
    const 屏 = page.getByTestId("m-not-team");
    await expect(屏).toBeVisible();
    await expect(屏).toHaveAttribute("data-why", "no-team");
    await expect(屏.getByRole("heading", { name: "手机伴侣是团队版功能" })).toBeVisible();
    await expect(屏).toContainText("个人版的数据只在你的电脑上，手机连不上。想用手机记跟进，可以私信我们开通团队版。");
    await expect(page.getByText("配对数字")).toHaveCount(0);
    await 量(page, 宽, "个人版说明");
    // 只问了资格（开发模式下效果会跑两遍，问两次也算），没发申请
    expect(发过.length > 0 && 发过.every((x) => x === "eligibility"), 发过.join(",")).toBe(true);
    if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: 出处(`手机-${宽}-个人版说明.png`) });
    await 屏.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("button", { name: /登录/ }).first()).toBeVisible();
    expect(发过.every((x) => x === "eligibility"), 发过.join(",")).toBe(true);
    const 有的 = 全部.filter((x) => x.宽 === 宽 && x.屏 === "个人版说明" && x.问题.length);
    if (!只记) expect(有的.map((x) => `${x.屏}\n${说问题(x.问题)}`).join("\n\n")).toBe("");
  });

  test(`手机 ${宽} 宽：公海客户「领取并记跟进」`, async ({ page }) => {
    await page.setViewportSize({ width: 宽, height: 667 });
    const 名 = `${名们.长英} 公海`;
    await 灌手机(page, { 行们: [
      { t: "User", k: "acct_wang", r: { id: "acct_wang", name: "王磊（华东区销售总监 · 兼外贸二部负责人）", active: true } },
      { t: "Customer", k: "pool-x", r: { id: "pool-x", name: 名, phone: "+971500000009", salesOwnerId: "acct_wang", followStatus: "待跟进", createdAt: 现在 - 9 * 天, updatedAt: 现在 - 9 * 天 } },
      { t: "CustomerPool", k: "pool-x", r: { customerId: "pool-x", reason: "超过 30 天没跟进，自动退回公海" } },
    ] });
    await page.getByRole("button", { name: "客户" }).last().click();
    await page.getByText(/^公海/).first().click();
    await page.getByText(名, { exact: true }).first().click();
    await expect(page.getByRole("button", { name: /领取并记跟进/ })).toBeVisible();
    await 量(page, 宽, "公海详情");
    if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: 出处(`手机-${宽}-公海详情.png`) });
    await page.getByRole("button", { name: /领取并记跟进/ }).click();
    await expect(page.getByTestId("m-record-pool")).toBeVisible();
    await 量(page, 宽, "领取并记跟进", ".m-sheet");
    if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: 出处(`手机-${宽}-领取并记跟进.png`) });
    const 有的 = 全部.filter((x) => x.宽 === 宽 && ["公海详情", "领取并记跟进"].includes(x.屏) && x.问题.length);
    if (!只记) expect(有的.map((x) => `${x.屏}\n${说问题(x.问题)}`).join("\n\n")).toBe("");
  });
}
