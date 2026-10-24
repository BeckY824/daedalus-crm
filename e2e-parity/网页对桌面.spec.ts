/**
 * 企业版网页 vs 桌面端截图对比（2026-10-24，结果「网页版和 Mac / Windows 桌面端长得一样」的裁判）。
 *
 * 桌面端连服务器时，页面就是这台服务器出的；和浏览器里打开的网页只差在壳：
 *   - UA 带 "Electron/" → (app)/layout.tsx 给 shell-desktop（顶上拖窗口那条、左栏几处桌面端才有的东西）
 *   - Windows 上 preload-app.js 再给 <html> 挂 os-win（让出右上角三个钮、压深字色）
 *   - preload 往 window 上挂 desktopUpdate / desktopShell 等几个口子（左栏「检查更新」那一行看它）
 * 这里四种身份（Mac 网页 / Mac 桌面端 / Windows 网页 / Windows 桌面端）登同一个账号、看同一批页面、同一个宽度，
 * 一块一块截图逐像素比：左栏各段、正文每个直接子块。桌面端那两种照壳的样子挂 os-win 和那几个口子。
 *
 *   npx playwright test -c playwright.parity.config.ts
 *
 * 判红：某块像素差超过 0.1%（每个通道差 > 16 才算一个点不一样），或者两边块的尺寸、块数不一样。
 * 字和线边上的抗锯齿毛边（两边各自渲染、亚像素位置差一点就不一样）按 pixelmatch 的认法剔掉，见 毛边()；
 * 剔掉的点数照样进报告，差图里标黄。阈值、容差都没动。
 * 有意的差别（e2e-parity/有意的差别.json）：设计上就只有桌面端有的那几块。不是放宽——照样比、照样进报告，
 * 只是不判红；某条一整轮都一样了，输出里提示「可以从清单删掉」。
 * 报告写进 E2E_SHOT_DIR（默认 test-results/parity）：报告.md、报告.json，差了的块存「网页 / 桌面 / 差」三张图
 */
import { test, expect, devices, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PrismaClient } from "../src/generated/prisma";
import { 灌真客户, 灌长商机 } from "../e2e-layout/种子";
import { 关掉弹窗 } from "../e2e-layout/外贸模版";
import { 库 } from "./global-setup";
import 有意的差别 from "./有意的差别.json";

test.describe.configure({ mode: "serial" });

const 出处 = path.resolve(process.env.E2E_SHOT_DIR ?? "test-results/parity");
/** CI 按宽度分三片并行跑（PARITY_WIDTHS=1024）；本机不设就三个宽度都量 */
const 宽们 = (process.env.PARITY_WIDTHS ?? "1024,1280,1440").split(",").map(Number);
const 高 = 1600;
/** 每个通道差多少以内算同一个颜色；超过阈值比例的块判红 */
const 容差 = 16;
const 阈值 = 0.001;

const 页们: { 名: string; 址: string }[] = [
  { 名: "首页", 址: "/" },
  { 名: "数据", 址: "/overview" },
  { 名: "线索", 址: "/leads" },
  { 名: "报表", 址: "/reports" },
  { 名: "反馈", 址: "/feedback" },
  { 名: "客户列表", 址: "/customers" },
  { 名: "客户记录页", 址: "/customers/gate-scandi" },
  { 名: "客户记录页-长英文名", 址: "/customers/gate-long-uk" },
  { 名: "客户记录页-无空格名", 址: "/customers/gate-nospace" },
  { 名: "商机列表", 址: "/opportunities" },
  { 名: "商机看板", 址: "/opportunities/pipeline" },
  { 名: "订单列表", 址: "/orders" },
  { 名: "订单详情", 址: "/orders/gate-scandi-t0" },
  { 名: "跟进记录", 址: "/follow-ups" },
  { 名: "计划", 址: "/follow-ups/plans" },
  { 名: "待跟名单", 址: "/follow-ups/watchlist" },
  { 名: "供应商", 址: "/suppliers" },
  { 名: "设置-业务配置", 址: "/settings?tab=business" },
  { 名: "设置-AI", 址: "/settings?tab=ai" },
  { 名: "设置-桌面端", 址: "/settings?tab=desktop" },
  { 名: "设置-团队", 址: "/settings?tab=team" },
  { 名: "设置-个人资料", 址: "/settings?tab=profile" },
  { 名: "设置-成员", 址: "/settings?tab=members" },
  { 名: "设置-快捷键", 址: "/settings?tab=keymap" },
  { 名: "设置-外观", 址: "/settings?tab=appearance" },
  { 名: "设置-密码", 址: "/settings?tab=password" },
  { 名: "设置-组织架构", 址: "/settings?tab=org" },
  { 名: "设置-导入记录", 址: "/settings?tab=imports" },
  { 名: "设置-企业版导入", 址: "/settings?tab=enterprise" },
  { 名: "设置-操作日志", 址: "/settings?tab=audit" },
];

/** 左栏各段 + 正文；正文按直接子块一块一块比（Windows 桌面端正文多让出标题栏那条，整块高度本来就不一样） */
const 左栏 = [".rail-top", ".rail-nav", ".rail-more", ".rail-fav", ".rail-foot"];
const 正文 = "main.main > *";

const Mac = devices["Desktop Chrome"].userAgent.replace(/\(Windows[^)]*\)/, "(Macintosh; Intel Mac OS X 10_15_7)");
const Win = devices["Desktop Chrome"].userAgent.replace(/\([^)]*\)/, "(Windows NT 10.0; Win64; x64)");
const 壳 = (ua: string) => ua.replace(/ Safari\//, " daedalus-crm/0.46.27 Electron/38.2.0 Safari/");

/** 壳的 preload 在页面脚本之前挂的东西；口子只给到左栏「检查更新」那一行能画出来的程度 */
function 假壳(win: boolean) {
  return `(() => {
    ${win ? `const 挂 = () => document.documentElement && document.documentElement.classList.add("os-win"); 挂(); addEventListener("DOMContentLoaded", 挂);` : ""}
    const 空 = new Proxy({}, { get: (_, k) => String(k).startsWith("on") ? () => () => {} : async () => null });
    for (const n of ["desktopAttachments", "desktopNotify", "desktopReminders", "desktopNav", "desktopTeam"]) window[n] = 空;
    window.desktopUpdate = new Proxy({ state: async () => ({ 阶段: "idle" }) }, { get: (o, k) => k in o ? o[k] : 空[k] });
    window.desktopShell = new Proxy({ version: async () => "0.46.27" }, { get: (o, k) => k in o ? o[k] : 空[k] });
  })();`;
}

type 身份 = { 名: string; ua: string; 壳?: "mac" | "win" };
const 对们: [身份, 身份][] = [
  [{ 名: "Mac 网页", ua: Mac }, { 名: "Mac 桌面端", ua: 壳(Mac), 壳: "mac" }],
  [{ 名: "Windows 网页", ua: Win }, { 名: "Windows 桌面端", ua: 壳(Win), 壳: "win" }],
];

type 结果 = { 宽: number; 页: string; 对: string; 块: string; 差: number; 毛边?: number; 说明?: string; 有意?: string };
const 结果们: 结果[] = [];
const 有意 = new Map(有意的差别.map((x) => [x.块, x.原因]));
const 见过的有意 = new Set<string>();

async function 登录(page: Page) {
  for (let i = 0; i < 3; i++) {
    await page.goto("/login");
    await page.getByPlaceholder("用户名").fill("admin");
    await page.getByPlaceholder("登录密码").fill(process.env.INIT_PASSWORD ?? "admin123");
    await page.getByRole("button", { name: /登\s*录/ }).click();
    try {
      await page.waitForURL(/\/(dashboard|start)/, { timeout: 30_000 });
      return;
    } catch {
      /* dev 模式下第一次点击可能落空，再试 */
    }
  }
  throw new Error("登录失败");
}

/** 和排版闸门同一份「外贸出口」；网页模式没有桌面端的进门，走登录 */
async function 切外贸(page: Page) {
  await page.goto("/settings?tab=business");
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  if (await page.getByRole("heading", { name: "你主要做哪一类生意？" }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /用外贸出口开始/ }).click();
    await expect(page).not.toHaveURL(/\/start/);
    await 关掉弹窗(page, 4_000);
    return;
  }
  await 关掉弹窗(page, 4_000);
  const 面板 = page.getByRole("tabpanel", { name: /^业务配置/ });
  await expect(面板).toBeVisible();
  await 面板.getByRole("button", { name: "外贸出口", exact: true }).click();
  const 存 = 面板.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ });
  if (await 存.isVisible().catch(() => false)) {
    await 存.click();
    await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
  }
}

/** 和默认 e2e 同一套语言、时区、地址；UA 和窗口按身份给 */
const 底 = () => {
  const u = test.info().project.use;
  return { baseURL: u.baseURL, locale: u.locale, timezoneId: u.timezoneId, deviceScaleFactor: 1 };
};

const 上下文: Map<string, { ctx: BrowserContext; page: Page }> = new Map();

async function 开(browser: Browser, 谁: 身份, 状态: Awaited<ReturnType<BrowserContext["storageState"]>>) {
  const ctx = await browser.newContext({ ...底(), userAgent: 谁.ua, viewport: { width: 宽们[0], height: 高 }, reducedMotion: "reduce", storageState: 状态 });
  if (谁.壳) await ctx.addInitScript(假壳(谁.壳 === "win"));
  const page = await ctx.newPage();
  上下文.set(谁.名, { ctx, page });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const db = new PrismaClient({ datasourceUrl: `file:${库}` });
  try {
    const 我 = (await db.user.findFirstOrThrow({ where: { email: "admin" } })).id;
    await 灌真客户(db, 我);
    await 灌长商机(db, 我);
  } finally {
    await db.$disconnect();
  }
  const ctx = await browser.newContext({ ...底(), userAgent: Mac });
  const page = await ctx.newPage();
  await 登录(page);
  await 切外贸(page);
  // 新库第一次进主界面会弹「已更新到 …」：点过一次服务端记住，四种身份都不再弹
  await page.goto("/dashboard");
  await 关掉弹窗(page, 4_000);
  const 状态 = await ctx.storageState();
  await ctx.close();
  for (const 对 of 对们) for (const 谁 of 对) await 开(browser, 谁, 状态);
});

test.afterAll(async () => {
  for (const { ctx } of 上下文.values()) await ctx.close();
  mkdirSync(出处, { recursive: true });
  writeFileSync(path.join(出处, "报告.json"), JSON.stringify(结果们, null, 2));
  const 红 = 结果们.filter((r) => !r.有意 && (r.差 > 阈值 || r.说明));
  const 行 = (r: 结果) => `| ${r.宽} | ${r.页} | ${r.对} | \`${r.块}\` | ${(r.差 * 100).toFixed(2)}% | ${r.说明 ?? ""}${r.有意 ? `有意：${r.有意}` : ""} |`;
  const 不同 = 结果们.filter((r) => r.差 > 阈值 || r.说明);
  writeFileSync(
    path.join(出处, "报告.md"),
    [
      `# 网页 vs 桌面端截图对比`,
      ``,
      `比了 ${结果们.length} 块，判红 ${红.length} 块，有意的差别 ${不同.length - 红.length} 块。阈值：像素差 > ${阈值 * 100}%（每通道容差 ${容差}）或尺寸 / 块数不同。`,
      ``,
      `| 宽 | 页 | 对 | 块 | 差 | 说明 |`,
      `|---|---|---|---|---|---|`,
      ...不同.map(行),
    ].join("\n"),
  );
  for (const k of 有意.keys()) if (!见过的有意.has(k)) console.log(`有意的差别「${k}」这一轮两边一样了，可以从清单删掉`);
});

async function 去(page: Page, 址: string) {
  await page.goto(址);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await 关掉弹窗(page);
  // 字体、懒加载的图、动画落定
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await 等布局稳(page);
}

/**
 * 等布局连续 10 帧不动再拍（10-24 #143 第一轮：「记一笔」输入框按 scrollHeight 自己长高，没长完就截了，Mac 1440 差 9.4%）。
 * 量的是左栏和正文里每个元素的位置尺寸、整页高度；最多等 5 秒，到点还在动就照拍（真在动的页面本来就该红）
 */
async function 等布局稳(page: Page) {
  await page.evaluate(async () => {
    const 样 = () => {
      const 们 = document.querySelectorAll("main.main *, .rail-top, .rail-nav, .rail-more, .rail-fav, .rail-foot");
      let s = `${document.documentElement.scrollHeight}`;
      for (const el of 们) {
        const r = el.getBoundingClientRect();
        s += `|${r.x},${r.y},${r.width},${r.height}`;
      }
      return s;
    };
    const 帧 = () => new Promise((r) => requestAnimationFrame(r));
    const 止 = performance.now() + 5_000;
    let 上 = 样();
    for (let 连 = 0; 连 < 10 && performance.now() < 止; ) {
      await 帧();
      const 这 = 样();
      连 = 这 === 上 ? 连 + 1 : 0;
      上 = 这;
    }
  });
}

/**
 * Windows 桌面端正文顶上那条盖住系统三颗按钮的带子（globals.css `html.os-win .shell-desktop .main::before`）是窗口的边框，
 * 不是页面内容：它 sticky 在窗口最上面、占位净为 0。元素截图会把块滚到窗口顶上，带子就盖住块的头一截（10-24 第一轮：
 * 记录页标题整条被判红）。拍的时候只把它藏起来，不动排版
 */
const 拍时藏 = ".main::before { visibility: hidden !important; }";
const 拍法 = { animations: "disabled", caret: "hide", style: 拍时藏 } as const;

/** 一个身份这一页的所有块：键 → 截图 */
async function 拍(page: Page): Promise<Map<string, Buffer>> {
  const 图 = new Map<string, Buffer>();
  for (const 选 of 左栏) {
    const el = page.locator(选).first();
    if (await el.isVisible().catch(() => false)) 图.set(选, await el.screenshot(拍法));
  }
  const 子 = page.locator(正文);
  const n = await 子.count();
  for (let i = 0; i < n; i++) {
    const el = 子.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox();
    if (!box || box.width < 1 || box.height < 1) continue;
    图.set(`${正文}:nth(${i})`, await el.screenshot(拍法));
  }
  return 图;
}

/** 亮度（YIQ 的 Y），pixelmatch 判毛边用的就是它 */
const 亮 = (d: Buffer, i: number) => d[i] * 0.29889531 + d[i + 1] * 0.58662247 + d[i + 2] * 0.11448223;

/** (x, y) 周围 8 格里和它一模一样的超过 2 格：在平的一片里，不是边 */
function 平(d: Buffer, x: number, y: number, w: number, h: number) {
  const c = (y * w + x) * 4;
  let 同 = x === 0 || x === w - 1 || y === 0 || y === h - 1 ? 1 : 0;
  for (let yy = Math.max(y - 1, 0); yy <= Math.min(y + 1, h - 1); yy++) {
    for (let xx = Math.max(x - 1, 0); xx <= Math.min(x + 1, w - 1); xx++) {
      if (xx === x && yy === y) continue;
      const n = (yy * w + xx) * 4;
      if (d[c] === d[n] && d[c + 1] === d[n + 1] && d[c + 2] === d[n + 2] && d[c + 3] === d[n + 3]) 同++;
      if (同 > 2) return true;
    }
  }
  return false;
}

/**
 * 这一点在 甲 里像抗锯齿的毛边（pixelmatch 的认法，Vyšniauskas 2009）：周围最多 2 格和它一样亮，
 * 同时有更亮和更暗的邻居（夹在两种颜色中间），而且最亮或最暗的那个邻居在两张图里都处在平的一片里——
 * 也就是字、线的边缘，两边底色和字色一样，只是边上那一圈过渡色没对齐
 */
function 毛边(甲: Buffer, 乙: Buffer, x: number, y: number, w: number, h: number) {
  const c = (y * w + x) * 4;
  const 中 = 亮(甲, c);
  let 零 = x === 0 || x === w - 1 || y === 0 || y === h - 1 ? 1 : 0;
  let 最暗 = 0, 最亮 = 0, 暗x = 0, 暗y = 0, 亮x = 0, 亮y = 0;
  for (let yy = Math.max(y - 1, 0); yy <= Math.min(y + 1, h - 1); yy++) {
    for (let xx = Math.max(x - 1, 0); xx <= Math.min(x + 1, w - 1); xx++) {
      if (xx === x && yy === y) continue;
      const d = 中 - 亮(甲, (yy * w + xx) * 4);
      if (d === 0) {
        if (++零 > 2) return false;
      } else if (d < 最暗) {
        最暗 = d; 暗x = xx; 暗y = yy;
      } else if (d > 最亮) {
        最亮 = d; 亮x = xx; 亮y = yy;
      }
    }
  }
  if (最暗 === 0 || 最亮 === 0) return false;
  return (平(甲, 暗x, 暗y, w, h) && 平(乙, 暗x, 暗y, w, h)) || (平(甲, 亮x, 亮y, w, h) && 平(乙, 亮x, 亮y, w, h));
}

async function 比(甲: Buffer, 乙: Buffer): Promise<{ 差: number; 毛边: number; 说明?: string; 差图?: Buffer }> {
  const [a, b] = await Promise.all([甲, 乙].map((x) => sharp(x).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    return { 差: 1, 毛边: 0, 说明: `尺寸不同：网页 ${a.info.width}×${a.info.height}，桌面端 ${b.info.width}×${b.info.height}` };
  }
  const { width: w, height: h } = a.info;
  const 差图 = Buffer.alloc(w * h * 4);
  let 点 = 0;
  let 边 = 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    let 不同 = Math.abs(a.data[i] - b.data[i]) > 容差 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 容差 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 容差;
    let 是毛边 = false;
    if (不同) {
      const x = (i / 4) % w;
      const y = Math.floor(i / 4 / w);
      是毛边 = 毛边(a.data, b.data, x, y, w, h) || 毛边(b.data, a.data, x, y, w, h);
      if (是毛边) {
        边++;
        不同 = false;
      } else 点++;
    }
    // 一样的地方淡灰底，不一样的标红，认成毛边的标黄
    const 灰 = 255 - Math.round((255 - (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3) * 0.25);
    差图.set(不同 ? [255, 0, 0, 255] : 是毛边 ? [255, 200, 0, 255] : [灰, 灰, 灰, 255], i);
  }
  const 差 = 点 / (w * h);
  return { 差, 毛边: 边, 差图: 差 > 0 ? await sharp(差图, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer() : undefined };
}

const 文件名 = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, "_");

// 一条用例、每个宽度一步：串行模式下用例红了后面的会被跳过，拆成多条用例就看不到别的宽度
test("网页对桌面", async () => {
  test.setTimeout(宽们.length * 15 * 60_000);
  for (const 宽 of 宽们) await test.step(`宽 ${宽}`, async () => {
    for (const { page } of 上下文.values()) await page.setViewportSize({ width: 宽, height: 高 });
    const 红: string[] = [];
    for (const 页 of 页们) {
      for (const [网, 桌] of 对们) {
        const 对 = `${网.名} / ${桌.名}`;
        const 甲页 = 上下文.get(网.名)!.page;
        const 乙页 = 上下文.get(桌.名)!.page;
        await 去(甲页, 页.址);
        await 去(乙页, 页.址);
        const [甲, 乙] = [await 拍(甲页), await 拍(乙页)];
        const 键们 = new Set([...甲.keys(), ...乙.keys()]);
        for (const 块 of 键们) {
          const 类 = 块.startsWith(正文) ? 正文 : 块;
          const 原因 = 有意.get(类);
          const 记 = (r: Omit<结果, "宽" | "页" | "对" | "块">) => {
            const 一条 = { 宽, 页: 页.名, 对, 块, ...r, ...(原因 ? { 有意: 原因 } : {}) };
            结果们.push(一条);
            if (原因 && (r.差 > 阈值 || r.说明)) 见过的有意.add(类);
            if (!原因 && (r.差 > 阈值 || r.说明)) 红.push(`${页.名} ${对} ${块}：${r.说明 ?? `像素差 ${(r.差 * 100).toFixed(2)}%`}`);
          };
          const a = 甲.get(块);
          const b = 乙.get(块);
          if (!a || !b) {
            记({ 差: 1, 说明: a ? "桌面端没有这一块" : "网页没有这一块" });
            continue;
          }
          const r = await 比(a, b);
          记({ 差: r.差, 说明: r.说明, ...(r.毛边 ? { 毛边: r.毛边 } : {}) });
          if (r.差 > 阈值 || r.说明) {
            const 目录 = path.join(出处, String(宽), 文件名(页.名), 文件名(`${桌.壳}-${块}`));
            mkdirSync(目录, { recursive: true });
            writeFileSync(path.join(目录, "网页.png"), a);
            writeFileSync(path.join(目录, "桌面.png"), b);
            if (r.差图) writeFileSync(path.join(目录, "差.png"), r.差图);
          }
        }
      }
    }
    // 软断言：一个宽度红了，后面的宽度照样比完、照样进报告
    expect.soft(红, `宽 ${宽}：网页和桌面端不一样的块（截图在 ${出处}/${宽}/）\n${红.join("\n")}`).toEqual([]);
  });
});
