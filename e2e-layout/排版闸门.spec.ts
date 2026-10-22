/**
 * 发版前必过的排版闸门（2026-10-19 团队版主动排查）。
 *
 * 10-19 客户连报的几个显示 bug（Windows 上客户详情左栏商机小行溢出卡片、时间线跟进头一行被长商机名挤到 AI 栏底下点不动、
 * 跟进记录页右上按钮被切一半、毛玻璃中栏白线）全是客户先发现的。这一份让同一类问题在 CI 里先红：
 *
 *   - 数据：e2e-layout/种子.ts，照真客户的样子（一整句英文商机名、英国公司全大写长名、长供应商名、T/T 30/70、US$ 1,234,567.89、一位客户挂好几个商机 / 订单）；
 *     e2e-layout/长选项.ts 起服务前写好外贸模版 + 二十多个长来源 / 职级 / 行业选项 + 长字段名（10-22 排版普查）
 *   - 窗口：Windows 常见的 1024 / 1280 / 1366 宽（高 680：任务栏 + 标题栏之后剩的），每个宽度三种摆法：默认、右边 AI 栏常驻、左栏拖到最宽
 *   - 页面：首页、客户列表、客户记录页（名单 + 详情）、商机列表 / 看板、订单列表 / 详情、跟进记录、计划、待跟名单、供应商、设置各页、团队页
 *   - 每页量（e2e/layout-audit.ts）：盒子里有东西伸出去（撑出 / 被裁，有意横滚的区域不算）、按钮链接被切一半（出界）、
 *     不折行的字冲出自己的盒子（字溢出）、可点的东西中心点上是别人（被盖住）、短字被挤成竖排（折行）、整页横滚。顶上量一次，滚到底再量一次
 *
 *   npx playwright test -c playwright.layout.config.ts               # 有问题就红，失败说明里列出每一条
 *   TEAM_QA_REPORT=1 E2E_SHOT_DIR=… npx playwright test -c playwright.layout.config.ts   # 只记：JSON + 有问题那屏截图，不判红
 *
 * 不许为了变绿放宽检查：真有意横滚的区域在页面上就是 overflow-x: auto，检查自己会跳过；被误伤的先查是不是真问题
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { 连库, 我的id, 进门 } from "../e2e-desktop/helpers";
import { 查排版, 说问题, type 排版问题 } from "../e2e/layout-audit";
import { 灌真客户 } from "./种子";
import { 关掉弹窗, 切外贸 } from "./外贸模版";
import 现存问题 from "./现存问题.json";

test.describe.configure({ mode: "serial" });

const 只记 = process.env.TEAM_QA_REPORT === "1";
const 出处 = process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, "闸门") : null;
const 记录: { 宽: number; 摆法: string; 屏: string; 问题: 排版问题[] }[] = [];

/*
  现存问题清单（e2e-layout/现存问题.json）：第一次跑出来、在别的会话负责的文件里（10-19 时是 #39 外贸功能会话的客户记录页、商机列表、跟进记录）的问题。
  不是放宽：清单里的每一条照样量、照样记进报告；清单外**新**冒出来的任何一条都判红。
  清单里的修好了（一整轮都没再出现）会在输出里提示「可以从清单删掉」——删掉之后它再回来就红。
  键 = 页面 | 类 | 位置最后两层；不含宽度和像素数，同一处问题在哪个宽度出现都算同一条
*/
const 已知 = new Map(现存问题.map((x) => [x.键, x.归属]));
const 键 = (页: string, x: 排版问题) => `${页} | ${x.类} | ${x.在哪.split(" > ").slice(-2).join(" > ")}`;
const 见过的已知 = new Set<string>();

const 宽们 = [1024, 1280, 1366];
const 摆法们 = ["默认", "AI栏常驻", "左栏最宽"] as const;
type 摆法 = (typeof 摆法们)[number];

const 页们: { 名: string; 址: string }[] = [
  { 名: "首页", 址: "/" },
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
  // 10-22 排版普查 #6：种子里有长来源、长行业的线索
  { 名: "线索", 址: "/leads" },
  { 名: "设置-业务配置", 址: "/settings?tab=business" },
  { 名: "设置-AI", 址: "/settings?tab=ai" },
  { 名: "设置-桌面端", 址: "/settings?tab=desktop" },
  { 名: "设置-团队", 址: "/settings?tab=team" },
  // 10-22 排版普查 #13：导入记录定宽列加起来超过设置页正文，空表就横滚。「登录与密码」桌面端不显示，这里量不到
  { 名: "设置-导入记录", 址: "/settings?tab=imports" },
];

/** antd 的提示、通知是浮在最上面一会儿就走的；水合时 Next 的开发提示也不算 */
const 忽略 = [".ant-message", ".ant-notification", "nextjs-portal"];

/** 新库第一次进主界面会在页面出来之后自己弹「已更新到 …」：等一下，弹了就关（点过一次服务端记住，后面不再弹） */
async function 去(page: Page, 址: string, 摆: 摆法) {
  await page.goto(址);
  // networkidle 最多等 5 秒：订单详情页在 CI 上一直等不到（10-19 #40 第一次跑卡了 583 秒），落定靠下面那 500ms
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await 关掉弹窗(page);
  // 首页（/ → /dashboard）本身就是宽模式的 AI 对话，那里没有右栏（AiDock 在 /dashboard 不画）
  if (摆 === "AI栏常驻" && !new URL(page.url()).pathname.startsWith("/dashboard")) {
    // 不到 1600 宽默认收着；用户「保持常驻」时是 ⌘J / Ctrl+J 打开的
    const 栏 = page.getByRole("complementary", { name: "AI 面板" });
    if (!(await 栏.isVisible().catch(() => false))) await page.keyboard.press("Control+j");
    await expect(栏).toBeVisible();
  }
  // 动画、图表、骨架屏落定
  await page.waitForTimeout(500);
}

async function 滚到(page: Page, 比例: number) {
  await page.evaluate((f) => {
    for (const e of document.querySelectorAll<HTMLElement>("*")) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === "auto" || oy === "scroll") && e.scrollHeight > e.clientHeight + 1) e.scrollTop = (e.scrollHeight - e.clientHeight) * f;
    }
    window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f);
  }, 比例);
  await page.waitForTimeout(200);
}

test.beforeAll(async ({ browser }) => {
  const db = 连库();
  try {
    await 灌真客户(db, await 我的id(db));
  } finally {
    await db.$disconnect();
  }
  await 切外贸(browser);
});

test.afterAll(() => {
  // 单跑某一组时别的组才有的问题本来就看不到：整轮九组都跑完再信这份名单
  const 好了 = [...已知.keys()].filter((k) => !见过的已知.has(k));
  if (好了.length) console.log(`\n排版闸门：现存问题清单里这 ${好了.length} 条这一轮没再出现，整轮确认修好后从 e2e-layout/现存问题.json 删掉：\n${好了.map((k) => `  - ${k}`).join("\n")}`);
  if (出处) { mkdirSync(出处, { recursive: true }); writeFileSync(path.join(出处, "闸门排版问题.json"), JSON.stringify(记录, null, 2)); }
});

for (const 宽 of 宽们) {
  for (const 摆 of 摆法们) {
    test(`${宽} 宽 · ${摆}：主要页面不撑破、不被切、不被盖住`, async ({ page }) => {
      test.setTimeout(10 * 60_000);
      await page.setViewportSize({ width: 宽, height: 680 });
      await 进门(page);
      await page.evaluate((m) => {
        try {
          localStorage.setItem("rail-w", m === "左栏最宽" ? "360" : "220");
          localStorage.setItem("dock-w", "380");
        } catch { /* 存不下就是默认 */ }
      }, 摆);
      const 这一组: string[] = [];
      for (const p of 页们) {
        await 去(page, p.址, 摆);
        for (const [比例, 段] of [[0, "顶"], [1, "底"]] as const) {
          await 滚到(page, 比例);
          const 问题 = await 查排版(page, { 忽略 });
          if (!问题.length) continue;
          const 屏 = `${p.名}-${段}`;
          记录.push({ 宽, 摆法: 摆, 屏, 问题 });
          for (const x of 问题) if (已知.has(键(p.名, x))) 见过的已知.add(键(p.名, x));
          const 新的 = 问题.filter((x) => !已知.has(键(p.名, x)));
          if (新的.length) 这一组.push(`「${屏}」\n${说问题(新的)}`);
          if (出处) { mkdirSync(出处, { recursive: true }); await page.screenshot({ path: path.join(出处, `${宽}-${摆}-${屏}.png`) }); }
        }
      }
      if (!只记) expect(这一组, `${宽} 宽 · ${摆}：\n${这一组.join("\n\n")}`).toEqual([]);
    });
  }
}
