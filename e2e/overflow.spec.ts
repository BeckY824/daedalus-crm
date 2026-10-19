/**
 * 客户详情页的小行不许越出卡片（2026-10-19 客户 Windows 截图：左栏商机行「客户确认｜已转订单｜US$ 49,250｜2026-10-15 询盘」、
 * 订单行「2026-10-15 · T/T 30/70 · 山东佳盈食品有限公司」越过了卡片右边框）。
 *
 * 用长订单号、长付款方式、长供应商名、七位数美元金额，在 Windows 常见宽度（1024 / 1280 / 1366）下量：
 *   - 左栏商机 / 报价记录 / 订单每一行，里面每一段的右缘都不超过这一行
 *   - 金额整段显示（不被省略号截掉）
 *   - 时间线上的订单卡片同样不越界；整页不出横向滚动条
 *   - 新建订单弹窗里「同时标为已转订单」的长商机名那一行不越出弹窗
 * 再加一点字距模拟 Windows 的雅黑（比 Mac 的苹方宽），Mac 上量过了 Windows 上也过。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 前缀 = "越界回归";
const 金额字 = "US$ 1,234,567.89";
let 客户id = "";

async function 登录(page: Page) {
  for (let i = 0; i < 3; i++) {
    await page.goto("/login");
    await page.getByPlaceholder("用户名").fill("admin");
    await page.getByPlaceholder("登录密码").fill("admin123");
    await page.getByRole("button", { name: /登\s*录/ }).click();
    try {
      await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
      return;
    } catch {
      /* dev 模式下第一次点击可能落空，再试 */
    }
  }
  throw new Error("登录失败");
}

async function 套预设(page: Page, 名: string) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "业务配置" }).click();
  const 面板 = page.getByRole("tabpanel", { name: "业务配置" });
  await 面板.getByRole("button", { name: 名, exact: true }).click();
  await 面板.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
}

async function 收拾() {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: { startsWith: 前缀 } } });
    await db.supplier.deleteMany({ where: { name: { startsWith: 前缀 } } });
  } finally {
    await db.$disconnect();
  }
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  await 收拾();
  const db = 连库();
  try {
    const 我 = await db.user.findFirstOrThrow({ where: { email: "zhangsan" } });
    const c = await db.customer.create({ data: { name: `${前缀}·Shandong Jiaying International Food Trading Co., Ltd.`, phone: "8613800009876", salesOwnerId: 我.id } });
    客户id = c.id;
    const sup = await db.supplier.create({ data: { name: `${前缀}山东佳盈食品有限公司（临沂经济技术开发区第二分厂）` } });
    for (const [i, name] of ["2026 年第四季度速冻水饺及速冻包子大批量采购询盘（迪拜 + 阿布扎比两个仓）", "短"].entries()) {
      const o = await db.opportunity.create({ data: { name, customerId: c.id, amount: 1234567.89, stage: "需求确认", status: i === 0 ? "OPEN" : "WON", probability: 60, ownerId: 我.id } });
      await db.opportunityMoney.create({ data: { opportunityId: o.id, currency: "USD" } });
      const q = await db.quote.create({ data: { opportunityId: o.id, currency: "USD" } });
      await db.quoteLine.create({ data: { quoteId: q.id, product: "速冻猪肉白菜水饺（出口清真版改牛肉）", spec: "20g/个 × 50 个/袋 × 20 袋/箱", qty: 120000, unit: "箱", unitPrice: 12345.67 } });
    }
    for (const no of ["PI-20261015-0001-DXB-REVISED-FINAL", "PI-2"]) {
      const k = await db.contract.create({ data: { customerId: c.id, amount: 1234568, signedAt: new Date("2026-10-15T08:00:00Z") } });
      await db.contractMoney.create({ data: { contractId: k.id, currency: "USD", amountExact: 1234567.89 } });
      const o = await db.tradeOrder.create({ data: { no, customerId: c.id, ownerId: 我.id, amount: 1234567.89, currency: "USD", payment: "T/T 30% deposit, 70% balance against copy of B/L", contractId: k.id } });
      await db.tradeOrderPurchase.create({ data: { orderId: o.id, supplierId: sup.id, cost: 7654321.12 } });
    }
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await 登录(page);
    await 套预设(page, "通用销售");
  } finally {
    await page.close();
    await 收拾();
    const db = 连库();
    await db.setting.deleteMany({ where: { key: "business" } });
    await db.$disconnect();
  }
});

/** 每一行里越出这一行的段：[行里的字, 越出几 px] */
async function 越界的(page: Page, 行: string) {
  return page.locator(行).evaluateAll((rows) =>
    rows.flatMap((row) => {
      const r = row.getBoundingClientRect();
      return [...row.querySelectorAll("*")]
        .filter((e) => {
          const s = getComputedStyle(e);
          return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0" && !e.closest(".rec-mini-acts, .rec-tl-acts");
        })
        .map((e) => [(e.textContent ?? "").trim().slice(0, 40), Math.round(e.getBoundingClientRect().right - r.right)] as const)
        .filter(([, 超]) => 超 > 1);
    }),
  );
}

test("客户详情：左栏商机 / 报价 / 订单行和时间线订单卡，在 1024–1366 宽、宽字体下都不越出卡片，金额整段显示", async ({ page }) => {
  await 登录(page);
  await 套预设(page, "外贸出口");
  for (const 宽 of [1024, 1280, 1366]) {
    await page.setViewportSize({ width: 宽, height: 900 });
    await page.goto(`/customers/${客户id}`);
    await expect(page.locator(".rec-mini-2").first()).toBeVisible();
    // 模拟 Windows 雅黑：比苹方宽一截
    await page.addStyleTag({ content: "body * { letter-spacing: 0.06em !important; }" });
    await page.waitForTimeout(300);

    for (const 行 of [".rec-sec .rec-mini", ".rec-tl-contract"]) {
      expect(await 越界的(page, 行), `${宽}px：${行} 里有段越出了这一行`).toEqual([]);
    }
    // 金额不许被省略号截掉：每个金额都整段放得下
    const 金额们 = page.locator(".rec-sec .rec-mini-amt, .rec-sec .rec-mini-money", { hasText: "US$" });
    expect(await 金额们.count()).toBeGreaterThanOrEqual(4);
    await expect(page.locator(".rec-sec .rec-mini-amt", { hasText: 金额字 }).first()).toBeVisible();
    for (const 量 of await 金额们.evaluateAll((es) => es.map((e) => [e.textContent, e.scrollWidth - e.clientWidth] as const))) {
      expect(量[1], `${宽}px：金额「${量[0]}」被截了`).toBeLessThanOrEqual(1);
    }
    // 订单行的供应商、付款方式还在（挤不下折行或省略，悬停有全文）
    await expect(page.locator(".rec-sec .rec-mini-sub .rec-mini-m[title*='山东佳盈食品有限公司']").first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${宽}px：整页横向滚动`).toBeLessThanOrEqual(0);
  }

  // 新建订单弹窗「同时标为已转订单」：长商机名 + 阶段标签 + 金额，不越出弹窗
  await page.getByRole("button", { name: "新建订单" }).click();
  const 框 = page.getByRole("dialog", { name: /新建订单/ });
  await expect(框.locator(".contract-links-i").first()).toBeVisible();
  const 越出弹窗 = await 框.locator(".contract-links-i").evaluateAll((es) => {
    const 边 = es[0].closest(".ant-modal-body")!.getBoundingClientRect().right;
    return es.flatMap((e) => [...e.querySelectorAll("*"), e].map((x) => [(x.textContent ?? "").slice(0, 30), Math.round(x.getBoundingClientRect().right - 边)] as const).filter(([, 超]) => 超 > 1));
  });
  expect(越出弹窗).toEqual([]);
  await expect(框.locator(".contract-links-m", { hasText: 金额字 }).first()).toBeVisible();
});
