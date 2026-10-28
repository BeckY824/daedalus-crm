/**
 * 商机管道不许横滚（2026-10-22）：商机名很长时，原来那一列被撑到一千多像素宽，整排阶段要往右拉滚动条才看得全。
 * 现在各阶段按窗口宽度等分、放不下就折到下一行（上下滚可以，左右滚不行）；卡片上的商机名最多两行，悬停看全文。
 *
 * 量的是：
 *   - Windows 1024 / 1280 / 1366（高 680）、Mac 1440×900；1024 再加「AI 栏常驻 + 左栏最宽」最挤的一种
 *   - 数据：e2e-layout/种子.ts 那批（一整句英文商机名），再加一串没有空格的长名、一列里塞 24 张卡
 *   - 整页和管道都不横滚；同一行的列等宽、不超出管道；长名只占两行、title 里是全文；排版检查（e2e/layout-audit.ts）不报
 *   - 列比现在多（以后阶段能加）：把列复制到 8 列再量一遍，照样折行不横滚
 *   - 折到第二行的列也能拖进去：拖过去整列亮、松手写库
 *   - 卡片底行（团队里显示负责人时）：两个负责人 + 大额 + 一长串英文名，金额一行写完、负责人不冲出卡片
 *   - 超大金额（上亿美元、带负号的 8 位数）：一行放不下就在符号和数字之间折一次，数字不断开、不冲出卡片
 *
 *   E2E_PORT=3560 E2E_SHOT_DIR=… npx playwright test -c playwright.layout.config.ts e2e-layout/商机管道.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { 连库, 我的id, 进门 } from "../e2e-desktop/helpers";
import { 查排版, 说问题 } from "../e2e/layout-audit";
import { 灌真客户 } from "./种子";
import { 关掉弹窗, 切外贸 } from "./外贸模版";

const 出处 = process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, "商机管道") : null;
const 忽略 = [".ant-message", ".ant-notification", "nextjs-portal"];

const 无空格长名 = "FrozenChickenBreastBFQSkinlessBonelessIQF10kgBoxHalalCertifiedCIFTurkmenbashiViaMersin500MT";
const 拖的那张 = "gate-pipe-drag";
// 团队数据才在卡片底行显示负责人：再来一个人，名字是一长串英文（质量审 #87 时 1280 下冲出卡片 21px）
const 另一个人 = { id: "gate-pipe-owner", 名: "Maximilian-Alexander Wolfeschlegelsteinhausenbergerdorff" };

const 窗口们 = [
  { 名: "1024", 宽: 1024, 高: 680 },
  { 名: "1280", 宽: 1280, 高: 680 },
  { 名: "1366", 宽: 1366, 高: 680 },
  { 名: "Mac-1440", 宽: 1440, 高: 900 },
  { 名: "1024-AI栏常驻-左栏最宽", 宽: 1024, 高: 680, 挤: true },
];

test.beforeAll(async ({ browser }) => {
  const db = 连库();
  try {
    const 我 = await 我的id(db);
    // 前一个用例挂了会换个进程重跑 beforeAll：先清掉上回灌的，再灌
    await db.opportunity.deleteMany({ where: { id: { startsWith: "gate-pipe-" } } });
    await 灌真客户(db, 我);
    const 客户 = "gate-scandi";
    await db.opportunity.create({ data: { id: "gate-pipe-nospace", name: 无空格长名, amount: 456789.12, stage: "初步沟通", customerId: 客户, ownerId: 我, probability: 20, money: { create: { currency: "USD" } } } });
    // 一列里塞很多张：页面往下长，不往右长
    for (let i = 0; i < 24; i++) {
      await db.opportunity.create({ data: { id: `gate-pipe-many-${i}`, name: `Frozen chicken wings mid-joint grade A, 10kg/carton, lot ${i + 1} of 24, FOB Qingdao`, amount: 10000 + i, stage: "初步沟通", customerId: 客户, ownerId: 我, probability: 20, money: { create: { currency: "USD" } } } });
    }
    await db.opportunity.create({ data: { id: 拖的那张, name: "拖拽测试 · Drag me into the second row", amount: 1, stage: "需求确认", customerId: 客户, ownerId: 我, probability: 40, money: { create: { currency: "USD" } } } });
    await db.user.upsert({ where: { id: 另一个人.id }, create: { id: 另一个人.id, email: "pipe-owner@e2e.local", name: 另一个人.名, password: "x", role: "SALES", title: "业务员" }, update: { active: true, name: 另一个人.名 } });
    await db.opportunity.create({ data: { id: "gate-pipe-owner-big", name: "Big order · long owner", amount: 1234567.89, stage: "需求确认", customerId: 客户, ownerId: 另一个人.id, probability: 40, money: { create: { currency: "USD" } } } });
    await db.opportunity.create({ data: { id: "gate-pipe-owner-eur", name: "EUR order · my own", amount: 45000, stage: "需求确认", customerId: 客户, ownerId: 我, probability: 40, money: { create: { currency: "EUR" } } } });
    // 质量审 #87 时量到：1280 一排五列，这两种金额原来多出 4–6px
    await db.opportunity.create({ data: { id: "gate-pipe-huge", name: "Huge order · nine digits", amount: 123456789.12, stage: "需求确认", customerId: 客户, ownerId: 另一个人.id, probability: 40, money: { create: { currency: "USD" } } } });
    await db.opportunity.create({ data: { id: "gate-pipe-negative", name: "Credit note · negative", amount: -12345678.9, stage: "需求确认", customerId: 客户, ownerId: 我, probability: 40, money: { create: { currency: "USD" } } } });
  } finally {
    await db.$disconnect();
  }
  // 开发服务器头一回编译慢，「已更新到」会晚弹、挡住设置页的保存键：先进一次门，等它出来点掉（服务端记成看过）
  const 先进 = await browser.newPage();
  try {
    await 进门(先进);
    await 关掉弹窗(先进, 30_000);
  } finally {
    await 先进.close();
  }
  await 切外贸(browser);
});

// 多出来的那个人别留给后面的用例：其他页会因为「团队里有两个人」多出负责人一列
test.afterAll(async () => {
  const db = 连库();
  try {
    await db.opportunity.deleteMany({ where: { ownerId: 另一个人.id } });
    await db.user.deleteMany({ where: { id: 另一个人.id } });
  } finally {
    await db.$disconnect();
  }
});

async function 开管道(page: Page, 宽: number, 高: number, 挤 = false) {
  await page.setViewportSize({ width: 宽, height: 高 });
  await 进门(page);
  await page.evaluate((挤) => {
    try {
      localStorage.setItem("rail-w", 挤 ? "360" : "220");
      localStorage.setItem("dock-w", "380");
    } catch { /* 存不下就是默认 */ }
  }, 挤);
  await page.goto("/opportunities/pipeline");
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await 关掉弹窗(page);
  if (挤) {
    const 栏 = page.getByRole("complementary", { name: "AI 面板" });
    if (!(await 栏.isVisible().catch(() => false))) await page.keyboard.press("Control+j");
    await expect(栏).toBeVisible();
  }
  await expect(page.locator(".pipe-col").first()).toBeVisible();
  await page.waitForTimeout(500);
}

/** 横滚、列宽、长名几样一次量出来 */
async function 量(page: Page) {
  return page.evaluate((长名) => {
    const 管 = document.querySelector<HTMLElement>(".pipe")!;
    const 管框 = 管.getBoundingClientRect();
    const 列们 = [...document.querySelectorAll<HTMLElement>(".pipe-col")].map((c) => {
      const r = c.getBoundingClientRect();
      return { 上: Math.round(r.top), 左: r.left, 右: r.right, 宽: r.width };
    });
    const 行们 = new Map<number, number[]>();
    for (const c of 列们) 行们.set(c.上, [...(行们.get(c.上) ?? []), c.宽]);
    const 卡名 = [...document.querySelectorAll<HTMLElement>(".pipe-card-t")].find((e) => e.textContent === 长名)!;
    const 行高 = parseFloat(getComputedStyle(卡名).lineHeight);
    // 滚动区里任何一块横滚都算（不只看整页）
    const 横滚的 = [...document.querySelectorAll<HTMLElement>("main *, .pipe")].filter((e) => {
      const ox = getComputedStyle(e).overflowX;
      return (ox === "auto" || ox === "scroll") && e.scrollWidth > e.clientWidth + 1;
    }).map((e) => e.className || e.tagName);
    return {
      整页横滚: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      管道横滚: 管.scrollWidth > 管.clientWidth + 1,
      横滚的,
      出界的列: 列们.filter((c) => c.左 < 管框.left - 1 || c.右 > 管框.right + 1).length,
      行数: 行们.size,
      每行列宽: [...行们.values()],
      长名行数: Math.round(卡名.clientHeight / 行高),
      长名被截: 卡名.scrollHeight > 卡名.clientHeight + 1,
      长名提示: 卡名.closest<HTMLElement>(".pipe-card")!.title,
      有渐隐: !!document.querySelector(".pipe-wrap[data-more]"),
    };
  }, 无空格长名);
}

async function 截(page: Page, 名: string) {
  if (!出处) return;
  mkdirSync(出处, { recursive: true });
  await page.screenshot({ path: path.join(出处, `${名}.png`) });
  await page.screenshot({ path: path.join(出处, `${名}-整页.png`), fullPage: true });
}

for (const w of 窗口们) {
  test(`${w.名}：所有阶段不横滚，长名两行省略`, async ({ page }) => {
    await 开管道(page, w.宽, w.高, w.挤);
    await 截(page, w.名);
    const m = await 量(page);
    expect(m.整页横滚, "整页横滚").toBe(false);
    expect(m.管道横滚, "管道横滚").toBe(false);
    expect(m.横滚的, "有区域横滚").toEqual([]);
    expect(m.出界的列, "列伸出管道").toBe(0);
    // 同一行等宽（最后一行可以少几列，但宽度和上面一样）
    const 宽们 = m.每行列宽.flat();
    expect(Math.max(...宽们) - Math.min(...宽们), `列宽不一：${JSON.stringify(m.每行列宽)}`).toBeLessThanOrEqual(1);
    expect(m.长名行数, "长名最多两行").toBeLessThanOrEqual(2);
    expect(m.长名被截, "长名超出的部分省略").toBe(true);
    expect(m.长名提示, "悬停看全文").toContain(无空格长名);
    expect(m.有渐隐, "右沿渐隐已经没用了").toBe(false);
    // 1280 起（不挤的时候）五个阶段一排看全：折行只留给窄窗口，不然最后一个阶段压在一长列卡片下面
    if (w.宽 >= 1280 && !w.挤) expect(m.行数, `${w.名} 应该一排放下`).toBe(1);
    const 问题 = await 查排版(page, { 忽略 });
    expect(问题, 说问题(问题)).toEqual([]);
  });
}

test("阶段多到 8 列：照样折行，不横滚", async ({ page }) => {
  await 开管道(page, 1280, 680);
  await page.evaluate(() => {
    const 管 = document.querySelector(".pipe")!;
    const 样 = 管.querySelectorAll(".pipe-col");
    for (let i = 0; i < 3; i++) 管.appendChild(样[i % 样.length].cloneNode(true));
  });
  await page.waitForTimeout(200);
  await 截(page, "1280-8列");
  const m = await 量(page);
  expect(m.整页横滚 || m.管道横滚, "横滚").toBe(false);
  expect(m.出界的列).toBe(0);
  expect(m.行数, "放不下就折行").toBeGreaterThan(1);
});

test("1024：拖到第二行的列里，整列亮、松手就推进", async ({ page }) => {
  await 开管道(page, 1024, 680);
  const 列们 = page.locator(".pipe-col");
  const 第一列上沿 = (await 列们.first().boundingBox())!.y;
  // 找第二行里不是「赢单」的一列（拖进赢单会先弹登记签约，另有用例）
  const 名们 = await 列们.locator(".pipe-h b").allTextContents();
  let 目标 = -1;
  for (let i = 0; i < 名们.length - 1; i++) {
    if ((await 列们.nth(i).boundingBox())!.y > 第一列上沿 + 10) { 目标 = i; break; }
  }
  expect(目标, "1024 宽应折成两行").toBeGreaterThan(0);
  const 去的列 = 列们.nth(目标);
  const 卡 = page.locator(".pipe-card", { hasText: "Drag me into the second row" });
  await 卡.scrollIntoViewIfNeeded();

  // 拖过去时整列亮（手动走一遍 dragstart → dragover，停在半路截图）
  const 数据 = await page.evaluateHandle(() => new DataTransfer());
  await 卡.dispatchEvent("dragstart", { dataTransfer: 数据 });
  await 去的列.dispatchEvent("dragover", { dataTransfer: 数据 });
  await expect(去的列).toHaveClass(/pipe-col-on/);
  await 去的列.scrollIntoViewIfNeeded();
  await 截(page, "1024-拖到第二行-亮");
  await 去的列.dispatchEvent("drop", { dataTransfer: 数据 });
  await 卡.dispatchEvent("dragend", { dataTransfer: 数据 });

  await expect(page.locator(".ant-message")).toContainText(`已推进到 ${名们[目标]}`);
  await expect(去的列.locator(".pipe-card", { hasText: "Drag me into the second row" })).toBeVisible();
  const db = 连库();
  try {
    const 现在 = await db.opportunity.findUniqueOrThrow({ where: { id: 拖的那张 } });
    expect(现在.stage).not.toBe("需求确认");
  } finally {
    await db.$disconnect();
  }

  // 真鼠标拖一次（Chromium 的原生拖放），拖回第一列的列头。第一列塞了 24 张卡，第二行在两千多像素以下：
  // 起点终点不在一屏里，Playwright 半路滚屏会把原生拖放打断，所以窗口拉高到两头都看得见（宽不变，排版一样）
  const 第一列 = 列们.first();
  const 管道多高 = await page.evaluate(() => {
    const 管 = document.querySelector<HTMLElement>(".pipe")!;
    for (let e: HTMLElement | null = 管; e; e = e.parentElement) e.scrollTop = 0;
    return 管.getBoundingClientRect().bottom;
  });
  await page.setViewportSize({ width: 1024, height: Math.ceil(管道多高 + 100) });
  await 卡.dragTo(第一列.locator(".pipe-h"));
  await expect(第一列.locator(".pipe-card", { hasText: "Drag me into the second row" })).toBeVisible();
});

test("1280：卡片底行两个负责人 + 大额 + 长英文名，金额一行、负责人不冲出卡片", async ({ page }) => {
  await 开管道(page, 1280, 680);
  const 大 = page.locator(".pipe-card", { hasText: "Big order · long owner" });
  const 欧 = page.locator(".pipe-card", { hasText: "EUR order · my own" });
  await 大.scrollIntoViewIfNeeded();
  await 截(page, "1280-卡片底行负责人");
  const 量底行 = (卡: typeof 大) => 卡.evaluate((c) => {
    const 框 = c.getBoundingClientRect();
    const 额 = c.querySelector<HTMLElement>(".pipe-card-a")!;
    const 人 = c.querySelector<HTMLElement>(".pipe-card-o");
    const 一行 = (e: HTMLElement) => e.getClientRects().length === 1 && e.getBoundingClientRect().height < parseFloat(getComputedStyle(e).lineHeight) * 1.5;
    return {
      金额: 额.textContent,
      金额一行: 一行(额),
      金额出界: 额.getBoundingClientRect().right > 框.right - 1,
      有负责人: !!人,
      负责人一行: 人 ? 一行(人) : null,
      负责人出界: 人 ? 人.getBoundingClientRect().right > 框.right - 1 : null,
      负责人提示: 人?.title ?? null,
    };
  });
  const a = await 量底行(大);
  expect(a.有负责人, "团队里有两个人，应该显示负责人").toBe(true);
  expect(a.金额, "大额").toMatch(/1,234,567\.89/);
  expect(a.金额一行, "金额一行写完").toBe(true);
  expect(a.金额出界, "金额冲出卡片").toBe(false);
  expect(a.负责人一行, "长英文名一行省略").toBe(true);
  expect(a.负责人出界, "长英文名冲出卡片").toBe(false);
  expect(a.负责人提示, "悬停看全名").toBe(另一个人.名);
  const b = await 量底行(欧);
  expect(b.金额, "欧元").toMatch(/45,000/);
  expect(b.金额一行, "欧元金额一行").toBe(true);
  expect(b.负责人一行, "中文名不折行").toBe(true);
  expect(b.负责人出界).toBe(false);
  const 问题 = await 查排版(page, { 忽略 });
  expect(问题, 说问题(问题)).toEqual([]);
});

for (const 宽 of [1024, 1280]) test(`${宽}：上亿、带负号的金额一行放不下就在符号后折一次，数字不断开、不冲出卡片`, async ({ page }) => {
  await 开管道(page, 宽, 680);
  const 大 = page.locator(".pipe-card", { hasText: "Huge order · nine digits" });
  await 大.scrollIntoViewIfNeeded();
  await 截(page, `${宽}-超大金额`);
  for (const 名 of ["Huge order · nine digits", "Credit note · negative", "Big order · long owner"]) {
    const r = await page.locator(".pipe-card", { hasText: 名 }).evaluate((c) => {
      const 框 = c.getBoundingClientRect();
      const 额 = c.querySelector<HTMLElement>(".pipe-card-a")!;
      const 段 = [...额.querySelectorAll<HTMLElement>(".pipe-card-a-n")];
      const 行高 = parseFloat(getComputedStyle(额).lineHeight);
      return {
        金额: 额.textContent,
        段数: 段.length,
        每段一行: 段.every((e) => e.getClientRects().length === 1 && e.getBoundingClientRect().height < 行高 * 1.5),
        出界: [额, ...段].some((e) => e.getBoundingClientRect().right > 框.right - 1),
      };
    });
    expect(r.段数, `${名}：符号和数字两段`).toBe(2);
    expect(r.每段一行, `${名}：${r.金额} 符号、数字各自不断开`).toBe(true);
    expect(r.出界, `${名}：${r.金额} 冲出卡片`).toBe(false);
  }
  const 问题 = await 查排版(page, { 忽略 });
  expect(问题, 说问题(问题)).toEqual([]);
});
