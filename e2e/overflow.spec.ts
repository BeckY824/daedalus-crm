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
import { 装个假模型, 拆掉假模型 } from "./fake-llm";

const 前缀 = "越界回归";
const 金额字 = "US$ 1,234,567.89";
const 长商机名 = "chicken breast BFQ. Exw. 10kg/Box. Country is Turkmenistan / Tadjikistan. Target price is 1300$, quantity 500 tons";
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
    await db.channel.deleteMany({ where: { name: { startsWith: 前缀 } } });
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
      // 时间线上挂着这张订单的跟进：头一行「订单 PI-…」
      const fu = await db.followUp.create({ data: { type: "EMAIL", title: "发了形式发票", content: "PI 已发，等对方回签", customerId: c.id, ownerId: 我.id } });
      await db.followUpOrder.create({ data: { followUpId: fu.id, orderId: o.id, nodeIdx: 1 } });
    }
    // 2026-10-19 客户截图那条：WhatsApp、已发送、挂着一个很长的商机名
    const 长商机 = await db.opportunity.create({ data: { name: 长商机名, customerId: c.id, amount: 650000, stage: "需求确认", status: "OPEN", probability: 30, ownerId: 我.id } });
    await db.followUp.create({ data: { type: "WHATSAPP", title: "", content: "Sent the price list and asked for the target port.", status: "已发送", customerId: c.id, opportunityId: 长商机.id, ownerId: 我.id, occurredAt: new Date(Date.now() + 60_000) } });
    await db.followPlan.create({ data: { subject: "确认迪拜仓和阿布扎比仓两个收货地址、清关代理以及第二批货的唛头和托盘要求（客户说周五前给）", plannedAt: new Date(Date.now() + 86400_000), customerId: c.id, ownerId: 我.id } });
    await db.task.create({ data: { title: "把 PI-20261015-0001-DXB-REVISED-FINAL 的形式发票改成两个收货人分开开票再发给 Ahmed", dueAt: new Date(Date.now() + 86400_000), customerId: c.id, ownerId: 我.id } });
    const 渠道 = await db.channel.create({ data: { name: `${前缀}迪拜华人商会食品进出口分会推荐渠道（第二联络处）`, channelOwnerId: 我.id } });
    await db.customer.update({ where: { id: c.id }, data: { channelId: 渠道.id, extra: { upsert: { create: { source: `${前缀}Gulfood 2026 迪拜国际食品展 Sheikh Saeed Hall 3 展位 S3-B21 现场扫码` }, update: { source: `${前缀}Gulfood 2026 迪拜国际食品展 Sheikh Saeed Hall 3 展位 S3-B21 现场扫码` } } } } });
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

    for (const 行 of [".rec-sec .rec-mini", ".rec-tl-contract", ".rec-tl-item .rec-tl-head", ".rec-plan", ".rec-task", ".rec-tags"]) {
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

/*
  2026-10-19 客户 Windows 截图：时间线一条 WhatsApp 跟进挂着很长的商机名，头一行不缩，
  时间和编辑 / 删除被推出中栏、压到右边那栏底下，「点铅笔没反应」——点到的是右栏。
  现在：铅笔在中栏里、点下去就是它，编辑框打得开、改了存得上。
*/
/**
 * React 流式渲染：晚到的那段先放在 body 末尾的隐藏 div 里，约 0.3 秒后才换到位，
 * 这期间同一条时间线在页面里有两份（main 上也一样）。等隐藏那份没了再量。
 */
async function 等流式揭开(page: Page) {
  await page.waitForFunction(() => !document.querySelector("body > div[hidden] .rec-tl-item"));
}

test("时间线：长关联商机名那条，铅笔留在中栏里，点得开编辑框，改了能存", async ({ page, browser }) => {
  // AI 栏要配了模型才有
  await 装个假模型(browser);
  try {
    await 登录(page);
    // 客户截图里右边 AI 栏开着：≥1600 默认常驻，窄一点的窗口是自己点开（或 ⌘J）的——两种都量
    for (const 宽 of [1100, 1280, 1366, 1680]) {
      await page.setViewportSize({ width: 宽, height: 900 });
      await page.goto(`/customers/${客户id}`);
      await 等流式揭开(page);
      const AI栏 = page.locator("aside.dock");
      if (宽 < 1600) {
        await expect(AI栏).toHaveCount(0);
        await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /打开 AI 面板/ }).click();
      }
      await expect(AI栏).toBeVisible();
      // 时间线这一整栏在 AI 栏左边、整页不横滚（1280 开着 AI 栏时正文 < 630 走单栏，原来整栏被挤到 AI 栏底下）
      await expect.poll(async () => (await page.locator(".rec-tl").boundingBox())!.x + (await page.locator(".rec-tl").boundingBox())!.width, { message: `${宽}px：时间线伸到 AI 栏底下` }).toBeLessThanOrEqual((await AI栏.boundingBox())!.x + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${宽}px：整页横向滚动`).toBeLessThanOrEqual(0);
      const 条 = page.locator(".rec-tl-item", { hasText: "关联商机：chicken breast" });
      await expect(条).toBeVisible();
      // 商机名一行省略，全文在悬停里
      const 链 = 条.locator(".rec-tl-order", { hasText: "关联商机" });
      await expect(链).toHaveAttribute("title", `关联商机：${长商机名}`);
      const 笔 = 条.getByRole("button", { name: "编辑跟进" });
      await 条.scrollIntoViewIfNeeded();
      // 鼠标直接移到铅笔那个点上：被别的栏盖着的话，鼠标落在那一栏上、这条不算悬停，下面量出来就不是铅笔
      await 笔.hover({ force: true });
      await expect(笔).toBeVisible();
      const 中栏 = (await page.locator(".rec-tl").boundingBox())!;
      const 框 = (await 笔.boundingBox())!;
      expect(框.x + 框.width, `${宽}px：铅笔越出中栏`).toBeLessThanOrEqual(中栏.x + 中栏.width + 1);
      expect(框.x + 框.width, `${宽}px：铅笔伸到 AI 栏底下`).toBeLessThanOrEqual((await AI栏.boundingBox())!.x);
      // 点下去落在铅笔上，不是被别的栏盖住
      await expect
        .poll(() => page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest("[aria-label='编辑跟进']")), [框.x + 框.width / 2, 框.y + 框.height / 2]), { message: `${宽}px：铅笔被盖住了` })
        .toBe(true);
      // 时间也在中栏里
      const 时 = (await 条.locator(".rec-tl-time").boundingBox())!;
      expect(时.x + 时.width).toBeLessThanOrEqual(中栏.x + 中栏.width + 1);
    }
    // 点开编辑、改一句、存上
    const 条 = page.locator(".rec-tl-item", { hasText: "关联商机：chicken breast" });
    await 条.getByRole("button", { name: "编辑跟进" }).hover({ force: true });
    await 条.getByRole("button", { name: "编辑跟进" }).click();
    const 框 = page.getByRole("dialog", { name: "编辑跟进记录" });
    await expect(框).toBeVisible();
    const 内容 = 框.locator("textarea").first();
    await expect(内容).toHaveValue(/Sent the price list/);
    await 内容.fill("Sent the price list and asked for the target port. 改过一次");
    await 框.getByRole("button", { name: /保\s*存/ }).click();
    await expect(框).toBeHidden();
    await expect(page.locator(".rec-tl-item", { hasText: "改过一次" })).toBeVisible();
  } finally {
    await 拆掉假模型(browser);
  }
});

/** 页头右上角那组按钮（.page-head-a）里，右缘越出窗口或被外层裁掉的：[字, 越出几 px] */
async function 页头被切的(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".page-head-a :is(button, a)")].flatMap((e) => {
      const b = e.getBoundingClientRect();
      if (b.width === 0) return [];
      let 边 = window.innerWidth;
      for (let x = e.parentElement; x; x = x.parentElement) if (getComputedStyle(x).overflowX !== "visible") 边 = Math.min(边, x.getBoundingClientRect().right);
      const 超 = Math.round(b.right - 边);
      return 超 > 1 ? [[(e.textContent || e.getAttribute("aria-label") || "").trim(), 超] as const] : [];
    }),
  );
}

test("全站页头右上角按钮：1024 / 1366 宽、宽字体下都在窗口里", async ({ page }) => {
  await 登录(page);
  const 页们 = ["/customers", "/customers/recent", `/customers/${客户id}`, "/follow-ups", "/follow-ups/plans", "/opportunities", "/opportunities/pipeline", "/orders", "/leads", "/contacts", "/channels", "/overview", "/settings"];
  for (const 宽 of [1024, 1366]) {
    await page.setViewportSize({ width: 宽, height: 800 });
    for (const 路 of 页们) {
      await page.goto(路);
      await expect(page.locator(".page-head, .rec-head").first(), `${宽}px ${路}：没有页头`).toBeVisible();
      await page.addStyleTag({ content: "body * { letter-spacing: 0.06em !important; }" });
      await page.waitForTimeout(200);
      expect(await 页头被切的(page), `${宽}px ${路}：页头按钮被切`).toEqual([]);
    }
  }
});

/*
  2026-10-19 客户 Windows 截图：跟进记录页头最右边只露出半颗「计划」。整页跟着窗口滚，
  右上角的最小化 / 最大化 / 关闭是系统盖在网页上面的、不跟着滚——往下滚一点，页头就钻到那三颗底下。
  现在正文顶上垫了一条同高的底色带（globals.css html.os-win .main::before），滚上去的内容整条没进去。
*/
test("Windows 桌面端：往下滚，页头按钮整条没进标题栏那条带子里，不被系统按钮切成半颗", async ({ browser }) => {
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Electron/38.0.0 Safari/537.36",
    viewport: { width: 1280, height: 600 },
  });
  const page = await ctx.newPage();
  try {
    await 登录(page);
    await page.goto("/follow-ups");
    await expect(page.locator(".page-head-a")).toBeVisible();
    await page.evaluate(() => document.documentElement.classList.add("os-win"));
    const 带高 = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--caption-h")));
    // 没滚：页头整个在带子下面，看得见
    expect((await page.locator(".page-head-a").boundingBox())!.y).toBeGreaterThanOrEqual(带高);
    // 往下滚到页头一半进了带子：右上角那一块（系统按钮的位置）点下去是带子，不是哪颗页头按钮
    await page.evaluate(() => window.scrollTo(0, 40));
    await page.waitForTimeout(200);
    const 打到的 = await page.evaluate((h) => {
      const 在 = (x: number) => document.elementFromPoint(x, h / 2);
      return [window.innerWidth - 20, window.innerWidth - 80, window.innerWidth - 200].map((x) => Boolean(在(x)?.closest(".page-head-a")));
    }, 带高);
    expect(打到的).toEqual([false, false, false]);
  } finally {
    await ctx.close();
  }
});
