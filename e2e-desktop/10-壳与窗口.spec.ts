/**
 * 窗口、平台、壳的桥这几件只在桌面端有的界面（回归核对 D-094 / D-097 / D-113 / R-006 / R-008）。
 *
 * 壳不在：window.desktopUpdate 由用例在页面载入前装一个假的（addInitScript），推什么阶段由用例定；
 * 平台靠 UA 认（DesktopTab 按 navigator.userAgent 里有没有 Windows 分文案），所以另开带 Mac / Windows UA 的上下文。
 *
 * 排在最后：前面的用例已经选过模版、录过客户；这一组自己要的数据自己造。
 * 单跑这一份时新库会先落到 /start——进门() 之后碰上就选「通用销售」。
 */
import { test, expect, devices, type Browser, type Page } from "@playwright/test";
import { BASE_URL } from "./env";
import { 连库, 进门 } from "./helpers";

async function 进来(page: Page, 去处?: string) {
  await 进门(page, 去处);
  if (/\/start$/.test(page.url())) {
    await page.getByRole("button", { name: /用通用销售开始/ }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    if (去处) await 进门(page, 去处);
  }
  // 单跑这一份时，「已更新到」还没被点过：会在页面出来后自己弹。等一下，弹了就关掉
  const 弹窗 = page.getByRole("dialog", { name: /已更新到/ });
  if (await 弹窗.waitFor({ state: "visible", timeout: 2_500 }).then(() => true, () => false)) {
    await 弹窗.getByRole("button", { name: /知\s*道\s*了/ }).click();
    await expect(弹窗).toBeHidden();
  }
}

const Mac的UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Electron/38.2.0";
const Windows的UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Electron/38.2.0";

async function 用UA开(browser: Browser, ua: string) {
  const ctx = await browser.newContext({ ...devices["Desktop Chrome"], userAgent: ua, baseURL: BASE_URL, locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: { width: 1440, height: 900 } });
  // 提醒那张卡只在壳有提醒的桥时才画（老壳没有这个口子就整张不出现）：装一个假的
  await ctx.addInitScript(() => {
    let 设 = { 角标: true, 早报: true, 早报时间: "08:30", 到点: true };
    (window as unknown as Record<string, unknown>).desktopReminders = {
      设置: async () => 设,
      改设置: async (s: typeof 设) => (设 = s),
      刷新: async () => true,
    };
  });
  return { ctx, page: await ctx.newPage() };
}

test.describe.configure({ mode: "serial" });

test("D-094 设置 → 桌面端的提醒说明按平台说：Windows 不说「关了窗口没关系」，Mac 照说", async ({ browser }) => {
  const 窗 = await 用UA开(browser, Windows的UA);
  try {
    await 进来(窗.page, "/settings?tab=desktop");
    const 栏 = 窗.page.getByRole("tabpanel", { name: /^桌面端/ });
    await expect(栏).toContainText("在 Windows 上关掉窗口应用就退出了");
    await expect(栏).not.toContainText("关了窗口没关系");
  } finally {
    await 窗.ctx.close();
  }
  const 苹果 = await 用UA开(browser, Mac的UA);
  try {
    await 进来(苹果.page, "/settings?tab=desktop");
    const 栏 = 苹果.page.getByRole("tabpanel", { name: /^桌面端/ });
    await expect(栏).toContainText("关了窗口没关系");
    await expect(栏).not.toContainText("在 Windows 上关掉窗口");
  } finally {
    await 苹果.ctx.close();
  }
});

test("D-113 数据页、首页、商机看板、计划页：卡片都从顶部拖动区下面开始，不落进去（按住卡片会拖动窗口）", async ({ page }) => {
  // 先有点数据，数据页才画卡片
  const db = 连库();
  try {
    const 我 = await db.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    if ((await db.customer.count()) === 0) await db.customer.create({ data: { name: "拖动区测试位", phone: "13855550113", salesOwnerId: 我.id } });
  } finally {
    await db.$disconnect();
  }
  await 进来(page, "/overview");
  for (const 去处 of ["/overview", "/dashboard", "/opportunities/pipeline", "/follow-ups/plans"]) {
    await page.goto(去处);
    await page.waitForLoadState("networkidle").catch(() => {});
    const 结果 = await page.evaluate(() => {
      const 条 = document.querySelector(".drag-strip");
      if (!条) return { 有条: false, 高: 0, 落进去的: [] as string[], 看过: [] as string[] };
      const 高 = 条.getBoundingClientRect().height;
      // 「卡」：类名里带 card / tile / stat / kpi 的、看得见的块。页头那一行本来就在拖动区里（.pane-h 高度就是 --drag-h），不算
      const 落进去的: string[] = [];
      const 看过: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("main [class*='card'], main [class*='tile'], main [class*='stat'], main [class*='kpi'], .pane [class*='card']")) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 24) continue;
        if (getComputedStyle(el).visibility === "hidden" || getComputedStyle(el).display === "none") continue;
        if (el.closest(".pane-h, .drag-strip, .ant-modal, .ant-drawer")) continue;
        看过.push(`${el.className.toString().slice(0, 40)}@${Math.round(r.top)}`);
        if (r.top < 高 - 0.5) 落进去的.push(`${el.className.toString().slice(0, 60)} top=${Math.round(r.top)}`);
      }
      return { 有条: true, 高, 落进去的, 看过 };
    });
    expect(结果.有条, `${去处} 没有 .drag-strip（桌面端外壳没认出来？）`).toBe(true);
    expect(结果.高).toBeGreaterThanOrEqual(40);
    // 扫得到卡片：选择器或页面结构改了以后整条变成「什么都没查」就是假绿
    // 数据页是出过事的那一页，一定有卡；别的页没数据时可能一张卡都没有
    if (去处 === "/overview") expect(结果.看过.length, `${去处} 一张卡都没扫到`).toBeGreaterThan(0);
    expect(结果.落进去的, `${去处} 有卡片落进了顶部 ${结果.高}px 的拖动区`).toEqual([]);
  }
});

test("D-097 单人库：新建线索不问负责人，列表不摆负责人列，页面上不出现一串 id", async ({ page }) => {
  await 进来(page, "/leads");
  const 名 = `单人线索${Date.now() % 100000}`;
  const 框 = page.getByRole("dialog", { name: "新建线索" });
  await expect(async () => {
    if (!(await 框.isVisible())) await page.getByRole("button", { name: /新建线索/ }).first().click();
    await expect(框).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(框.getByText("负责人", { exact: true })).toHaveCount(0);
  await 框.getByLabel(/^(线索名称|姓名|名称)/).first().fill(名);
  await 框.getByRole("button", { name: /确\s*定|保\s*存/ }).click();
  await expect(框).toBeHidden();
  await expect(page.getByText(名)).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "负责人" })).toHaveCount(0);
  const 正文 = await page.locator("main, .pane").first().innerText();
  // cuid：c 开头 20 多位小写字母数字。负责人显示成 id 就是这个样子
  expect(正文).not.toMatch(/\bc[a-z0-9]{20,}\b/);
  const db = 连库();
  try {
    const 线索 = await db.lead.findFirstOrThrow({ where: { name: 名 } });
    const 我 = await db.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    expect(线索.ownerId, "不问负责人，就该落在本人名下").toBe(我.id);
    await db.lead.delete({ where: { id: 线索.id } });
  } finally {
    await db.$disconnect();
  }
});

/** 装一个假的壳的更新桥：页面载入前就在，state() 回初值，推什么由 window.__推更新 决定 */
async function 装假更新桥(page: Page, 初值: Record<string, unknown>) {
  await page.addInitScript((初) => {
    const 听的: ((s: unknown) => void)[] = [];
    const w = window as unknown as Record<string, unknown>;
    w.__更新调用 = [] as string[];
    w.__推更新 = (s: unknown) => 听的.forEach((f) => f(s));
    w.desktopUpdate = {
      state: async () => 初,
      download: async () => void (w.__更新调用 as string[]).push("download"),
      install: async () => void (w.__更新调用 as string[]).push("install"),
      check: async () => void (w.__更新调用 as string[]).push("check"),
      openDownload: async () => void (w.__更新调用 as string[]).push("open"),
      onState: (f: (s: unknown) => void) => {
        听的.push(f);
        return () => 听的.splice(听的.indexOf(f), 1);
      },
    };
  }, 初值);
}

test("R-008 壳已经知道有新版（启动后自己查到的）：页面一打开左栏就是「更新到 x」，不用先点「检查更新」", async ({ page }) => {
  await 装假更新桥(page, { 阶段: "available", 版本: "9.9.9", 文字: "差量 2.3 MB" });
  await 进来(page, "/dashboard");
  await expect(page.getByRole("button", { name: /更新到 9\.9\.9/ })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __更新调用: string[] }).__更新调用)).toEqual([]);
});

test("R-006 「有新版」点开说明框又关掉、下载出错、再回到「有新版」：说明框不自己冒出来", async ({ page }) => {
  await 装假更新桥(page, { 阶段: "idle" });
  await 进来(page, "/dashboard");
  const 推 = (s: Record<string, unknown>) => page.evaluate((x) => (window as unknown as { __推更新: (s: unknown) => void }).__推更新(x), s);
  await 推({ 阶段: "available", 版本: "9.9.9", 文字: "整包 160 MB", 说明: "这一版改了些东西" });
  const 行 = page.getByRole("button", { name: /更新到 9\.9\.9/ });
  await expect(行).toBeVisible();
  // 点开「问一句」：说明框出来，然后点更新（开始下载 → 出错）
  await 行.click();
  const 框 = page.getByRole("dialog");
  await expect(框).toBeVisible();
  await 推({ 阶段: "downloading", 版本: "9.9.9", 进度: 10 });
  await 推({ 阶段: "error", 错误: "网络断了" });
  await expect(page.getByRole("button", { name: /更新失败，点击重试/ })).toBeVisible();
  await expect(框).toBeHidden();
  // 重试 → 壳重新查到 → 回到「有新版」：框不该自己弹出来
  await 推({ 阶段: "available", 版本: "9.9.9", 文字: "整包 160 MB" });
  await expect(行).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
