/**
 * 客户业务各页的长数据排版（2026-10-22 排版普查：D-25 之后拿长数据把各页走了一遍，客户业务这几页有字压字 / 整页横滚）。
 *
 * 数据照普查那批造：无空格长串、长邮箱、长网址、9 位数金额、长来源 / 渠道名、6 个字的自定义字段名。
 * 1024×700 和 1280×800 各走一遍（订单详情、客户记录另开 AI 栏再走一遍 1024），每项先截图再量：
 *   1 订单详情页头：长客户名的「XX 的记录 ›」不把标题挤成一栏、不横滚
 *   2 客户记录时间线正文：无空格长串、长邮箱、长网址折行，不冲出卡片
 *   3 客户记录字段名：6 个字的字段名不压到右边的值上
 *   4 / 5 / 11 商机列表：长商机名不压过后面几列；金额一行显示；各列内容不伸出格子
 *   6 线索：长来源 Tag 不盖住「状态」
 *   7 渠道：长渠道名不压过后面几列
 *   8 客户记录待办：1024 宽长任务名不一个字母一行地断
 *   9 跟进记录：长客户名最多两行
 *  10 客户记录联系人：名字一长，「关键」标签还在
 *  12 客户列表页头（AI 栏常驻；1024 宽下原来冲出 90px）：「我的客户 / 公海」页签不冲出标题那一块，右上角按钮放不下就整组折到下一行
 * 另外每页都量整页横滚
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { 连库, 我的id, 进门 } from "../e2e-desktop/helpers";
import { 灌真客户, 灌混排订单 } from "./种子";
import { 关掉弹窗, 切外贸 } from "./外贸模版";

// 不串行：一项没过，后面几页照样要截图、量
test.describe.configure({ mode: "default" });
const 出处 = process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, "客户业务长数据") : null;

const 无空格 = "ThisIsAVeryLongRemarkWithoutAnySpacesCopiedFromAnExcelCellOrAWhatsAppMessage_PI-20261022-EUROPE-000123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const 长邮箱 = "procurement.and.strategic.sourcing.department.frozen.poultry@international-trading-holdings-group.example.co.uk";
const 长客户名 = "AlNoorFrozenFoodTradingLLCDubaiInvestmentsParkPhase2WarehouseNo17";
const 长来源 = "LinkedInSalesNavigatorOutboundCampaignAutumn2026";
/** 设置里字段名上限 6 个字；6 个汉字已经比字段名那一栏（66px）宽 */
const 字段名 = { 档案字段1: "公司注册全称", 档案字段2: "采购职位职级", 档案字段3: "主营细分品类" };

async function 改字段名(browser: Browser) {
  const page = await browser.newPage();
  try {
    await 进门(page, "/settings?tab=business");
    await 关掉弹窗(page, 4_000);
    const 面板 = page.getByRole("tabpanel", { name: /^业务配置/ });
    await expect(面板).toBeVisible();
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    for (const [标, 值] of [["档案字段 1", 字段名.档案字段1], ["档案字段 2", 字段名.档案字段2], ["档案字段 3", 字段名.档案字段3]]) {
      await 面板.getByLabel(标, { exact: true }).fill(值);
    }
    await 面板.getByRole("button", { name: /^保\s*存$/ }).last().click();
    await expect(page.getByText(/已保存，全站措辞已更新/)).toBeVisible({ timeout: 15_000 });
  } finally {
    await page.close();
  }
}

test.beforeAll(async ({ browser }) => {
  const db = 连库();
  try {
    const 我 = await 我的id(db);
    await 灌真客户(db, 我);
    await 灌混排订单(db, 我);
    await db.customer.deleteMany({ where: { id: { startsWith: "long-" } } });
    await db.lead.deleteMany({ where: { id: { startsWith: "long-" } } });
    await db.channel.deleteMany({ where: { id: { startsWith: "long-" } } });
    const 现在 = Date.now();
    for (let i = 0; i < 3; i++) {
      await db.channel.create({ data: { id: `long-ch${i}`, name: i ? `Global Sourcing Agent Network for Frozen Poultry & Seafood (Middle East / CIS) 渠道 ${i}` : `渠道${无空格}`, phone: "+971 4 123 4567", remark: 无空格, channelOwnerId: 我 } });
    }
    await db.customer.create({
      data: {
        id: "long-c1", name: 长客户名, phone: "+971 50 123 4567 / +971 4 765 4321 (office, ask for procurement)", salesOwnerId: 我,
        school: "AL NOOR FROZEN FOOD TRADING LLC (DUBAI INVESTMENTS PARK)", grade: "SeniorProcurementManagerForFrozenPoultryAndSeafoodImports", major: "冷冻禽肉水产品及清真认证肉类产品进出口批发与零售连锁",
        followStatus: "跟进中", decisionStatus: "意向强", lastFollowAt: new Date(现在), remark: 无空格, channelId: "long-ch0",
        extra: { create: { country: "阿拉伯联合酋长国（迪拜）", email: 长邮箱, source: 长来源, level: "A 级", website: `https://www.alnoor-frozen-food-trading.example.ae/${无空格}` } },
        contacts: { create: Array.from({ length: 4 }, (_, k) => ({ name: k ? `Mr. Abdulrahman bin Mohammed bin Rashid Al-Maktoum ${k}` : "AbdulrahmanBinMohammedBinRashidAlMaktoumProcurement", position: "Head of Global Procurement & Strategic Sourcing (EMEA, CIS, MENA)", phone: "+971 50 123 4567", email: 长邮箱, isPrimary: k === 0 })) },
      },
    });
    // 12：公海里有人，客户列表页头才摆「我的客户 / 公海」页签
    await db.customer.create({ data: { id: "long-pool", name: "AlNoorFrozenFoodTradingLLCPoolCustomer", phone: "+971 4 000 0000", salesOwnerId: 我, pool: { create: { reason: "手动" } } } });
    for (let j = 0; j < 3; j++) {
      await db.opportunity.create({ data: { id: `long-c1-o${j}`, name: `${无空格}-${j}`, amount: 98765432.1, stage: ["初步沟通", "方案报价", "谈判审核"][j], customerId: "long-c1", ownerId: 我, probability: 60, activityAt: new Date(现在 + 60_000), money: { create: { currency: "USD" } } } });
    }
    for (let j = 0; j < 4; j++) {
      await db.followUp.create({ data: { customerId: "long-c1", ownerId: 我, type: ["PHONE", "EMAIL", "WHATSAPP", "MEETING"][j], title: "", status: "已完成", occurredAt: new Date(现在 + 60_000 - j * 3600_000), opportunityId: `long-c1-o${j % 3}`, content: j % 2 ? 无空格 : `${无空格} 客户发来：${长邮箱} https://example.com/${无空格}` } });
      await db.task.create({ data: { customerId: "long-c1", ownerId: 我, title: `Task${无空格}`, dueAt: new Date(现在 + (j - 1) * 86400_000) } });
    }
    for (let j = 0; j < 3; j++) {
      await db.lead.create({ data: { id: `long-l${j}`, name: j % 2 ? `LeadCompany${无空格}` : "THE INTERNATIONAL GROUP OF SCANDINAVIAN FOOD PACKAGING AND COLD CHAIN LOGISTICS HOLDINGS LIMITED (UK BRANCH)", contact: "Mr. Alexander Christopher Montgomery-Smythe", phone: "+44 20 7946 0000", email: 长邮箱, source: 长来源, status: "待跟进", remark: 无空格, ownerId: 我 } });
    }
  } finally {
    await db.$disconnect();
  }
  // 同 商机管道.spec：CHANGELOG 一改，「已更新到」会晚弹、挡住设置页的保存键——先进一次门把它点掉（服务端记成看过）
  const 先进 = await browser.newPage();
  try {
    await 进门(先进);
    await 关掉弹窗(先进, 30_000);
  } finally {
    await 先进.close();
  }
  await 切外贸(browser);
  await 改字段名(browser);
});

// 字段名改回外贸那套，别带到后面的用例里
test.afterAll(async ({ browser }) => {
  await 切外贸(browser);
});

async function 去(page: Page, 址: string, 宽: number, AI栏 = false) {
  await page.setViewportSize({ width: 宽, height: 宽 === 1024 ? 700 : 800 });
  await 进门(page, 址);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await 关掉弹窗(page);
  const 栏 = page.getByRole("complementary", { name: "AI 面板" });
  if ((await 栏.isVisible().catch(() => false)) !== AI栏) await page.keyboard.press("Control+j");
  await expect(栏).toBeVisible({ visible: AI栏 });
  await page.waitForTimeout(400);
}

async function 拍(page: Page, 名: string, 看: string | null = null) {
  if (看) await page.locator(看).first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(200);
  if (出处) { mkdirSync(出处, { recursive: true }); await page.screenshot({ path: path.join(出处, `${名}.png`) }); }
}

const 整页横滚 = (page: Page) => page.evaluate(() => {
  const de = document.documentElement;
  let 最多 = Math.max(de.scrollWidth, document.body.scrollWidth) - de.clientWidth;
  // 主区自己是滚动容器时，横滚出在它身上
  for (const e of document.querySelectorAll<HTMLElement>("main.app-content, .app-content")) 最多 = Math.max(最多, e.scrollWidth - e.clientWidth);
  return 最多;
});

/** 选中的元素右缘不超过它所在的格子 / 盒子（裁掉也不算数：要的是它自己收住，配省略号） */
const 伸出 = (page: Page, 选: string, 盒: string) => page.evaluate(([选, 盒]) => {
  const 坏: string[] = [];
  for (const e of document.querySelectorAll<HTMLElement>(选)) {
    const 框 = e.closest(盒);
    if (!框 || !e.getBoundingClientRect().width) continue;
    const r = e.getBoundingClientRect(), b = 框.getBoundingClientRect();
    if (r.right > b.right + 1) 坏.push(`「${(e.textContent ?? "").trim().slice(0, 24)}」右缘 ${Math.round(r.right)} > ${Math.round(b.right)}`);
  }
  return 坏.slice(0, 5);
}, [选, 盒] as const);

/** 文字比自己的盒子宽又没有省略号（nowrap 溢出、长串冲出去） */
const 字溢出 = (page: Page, 选: string) => page.evaluate((选) => {
  const 坏: string[] = [];
  for (const e of document.querySelectorAll<HTMLElement>(选)) {
    const s = getComputedStyle(e);
    if (e.clientWidth && e.scrollWidth > e.clientWidth + 1 && s.textOverflow !== "ellipsis") 坏.push(`「${(e.textContent ?? "").trim().slice(0, 24)}」${e.scrollWidth} > ${e.clientWidth}`);
  }
  return 坏.slice(0, 5);
}, 选);

for (const 宽 of [1024, 1280]) {
  test(`${宽} 宽 · 1 订单详情页头：长客户名不挤标题、不横滚`, async ({ page }) => {
    await 去(page, "/orders/gate-long-uk-t0", 宽);
    await 拍(page, `1-订单详情页头-${宽}`);
    expect.soft(await 整页横滚(page), "整页横滚").toBeLessThanOrEqual(1);
    const 标题宽 = await page.locator(".page-head h1").first().evaluate((e) => e.getBoundingClientRect().width);
    expect.soft(标题宽, "标题被挤窄").toBeGreaterThanOrEqual(240);
    expect.soft(await 伸出(page, ".page-head-a a", ".page-head")).toEqual([]);
  });

  test(`${宽} 宽 · 2 / 3 / 8 / 10 客户记录：时间线正文、字段名、待办、联系人`, async ({ page }) => {
    await 去(page, "/customers/long-c1", 宽);
    await 拍(page, `3-客户记录字段名-${宽}`);
    expect.soft(await 字溢出(page, ".rec-field-k"), "3 字段名压到值上").toEqual([]);
    expect.soft(await 伸出(page, ".rec-mini-n .ant-tag", ".rec-mini"), "10 关键标签").toEqual([]);
    // 8：待办一条不超过 4 行（一个字母一行地断时十几行）
    const 待办行高 = await page.locator(".rec-task-t").evaluateAll((es) => es.map((e) => Math.round(e.getBoundingClientRect().height / (parseFloat(getComputedStyle(e).lineHeight) || 20))));
    expect.soft(Math.max(0, ...待办行高), "8 待办行数").toBeLessThanOrEqual(4);
    await 拍(page, `2-客户记录时间线-${宽}`, ".rec-tl-content");
    expect.soft(await 整页横滚(page), "整页横滚").toBeLessThanOrEqual(1);
    expect.soft(await 字溢出(page, ".rec-tl-content"), "2 时间线正文").toEqual([]);
    expect.soft(await 伸出(page, ".rec-tl-content", ".rec-tl-item"), "2 时间线正文冲出卡片").toEqual([]);
  });

  test(`${宽} 宽 · 4 / 5 / 11 商机列表：长名不压后面几列，金额一行`, async ({ page }) => {
    await 去(page, "/opportunities", 宽);
    await expect(page.getByText(`${无空格}-0`).first()).toBeAttached();
    await 拍(page, `4-商机列表-${宽}`);
    expect.soft(await 整页横滚(page), "整页横滚").toBeLessThanOrEqual(1);
    expect.soft(await 伸出(page, ".ant-table-tbody td > *", "td"), "4 / 11 内容伸出格子").toEqual([]);
    const 金额行数 = await page.locator(".ant-table-tbody td").filter({ hasText: /US\$\s?98,765,432/ }).evaluateAll((tds) => tds.map((td) => {
      const s = td.querySelector("span") ?? td;
      return Math.round(s.getBoundingClientRect().height / (parseFloat(getComputedStyle(s).lineHeight) || 22));
    }));
    expect.soft(金额行数.length, "金额列找到了").toBeGreaterThan(0);
    expect.soft(Math.max(0, ...金额行数), "5 金额断行").toBeLessThanOrEqual(1);
  });

  test(`${宽} 宽 · 6 线索：长来源不盖住状态`, async ({ page }) => {
    await 去(page, "/leads", 宽);
    await expect(page.getByText(长来源).first()).toBeAttached();
    await 拍(page, `6-线索-${宽}`);
    expect.soft(await 整页横滚(page), "整页横滚").toBeLessThanOrEqual(1);
    expect.soft(await 伸出(page, ".ant-table-tbody td > *", "td"), "6 / 11 内容伸出格子").toEqual([]);
  });

  test(`${宽} 宽 · 7 渠道：长渠道名不压后面几列`, async ({ page }) => {
    await 去(page, "/channels", 宽);
    await expect(page.getByText(`渠道${无空格}`).first()).toBeAttached();
    await 拍(page, `7-渠道-${宽}`);
    expect.soft(await 整页横滚(page), "整页横滚").toBeLessThanOrEqual(1);
    expect.soft(await 伸出(page, ".ant-table-tbody td > *, .ant-table-tbody td .link-strong", "td"), "7 内容伸出格子").toEqual([]);
  });

  test(`${宽} 宽 · 9 跟进记录：长客户名最多两行`, async ({ page }) => {
    await 去(page, "/follow-ups", 宽);
    await expect(page.getByText(长客户名).first()).toBeAttached();
    await 拍(page, `9-跟进记录-${宽}`);
    expect.soft(await 整页横滚(page), "整页横滚").toBeLessThanOrEqual(1);
    const 行数 = await page.locator(".ant-table-tbody .cust-link-t > a").evaluateAll((es) => es.map((e) => Math.round(e.getBoundingClientRect().height / (parseFloat(getComputedStyle(e).lineHeight) || 22))));
    expect.soft(行数.length, "客户列找到了").toBeGreaterThan(0);
    expect.soft(Math.max(0, ...行数), "9 客户名行数").toBeLessThanOrEqual(2);
  });
}

test("1024 宽 · AI 栏开 · 1 / 10 订单详情页头、客户记录联系人", async ({ page }) => {
  await 去(page, "/orders/gate-long-uk-t0", 1024, true);
  await 拍(page, "1-订单详情页头-1024-AI栏");
  expect.soft(await 整页横滚(page), "整页横滚").toBeLessThanOrEqual(1);
  expect.soft(await 伸出(page, ".page-head-a a", ".page-head")).toEqual([]);
  await 去(page, "/customers/long-c1", 1024, true);
  await 拍(page, "10-客户记录联系人-1024-AI栏");
  expect.soft(await 伸出(page, ".rec-mini-n .ant-tag", ".rec-mini"), "10 关键标签").toEqual([]);
  expect.soft(await 整页横滚(page), "整页横滚").toBeLessThanOrEqual(1);
});

for (const 宽 of [1024, 1280] as const) test(`${宽} 宽 · AI 栏开 · 12 客户列表页头：页签不冲出去，按钮放不下就折到下一行`, async ({ page }) => {
  await 去(page, "/customers", 宽, true);
  await expect(page.locator(".page-head-t .ant-segmented")).toBeVisible();
  await 拍(page, `12-客户列表页头-${宽}-AI栏`);
  expect.soft(await 整页横滚(page), "整页横滚").toBeLessThanOrEqual(1);
  expect.soft(await 伸出(page, ".page-head-t .ant-segmented", ".page-head > :first-child"), "12 页签冲出标题那一块").toEqual([]);
  expect.soft(await 伸出(page, ".page-head-a .ant-btn", ".page-head"), "12 按钮冲出页头").toEqual([]);
  const 标题块宽 = await page.locator(".page-head > :first-child").first().evaluate((e) => e.getBoundingClientRect().width);
  expect.soft(标题块宽, "12 标题那一块被挤窄").toBeGreaterThanOrEqual(240);
});
