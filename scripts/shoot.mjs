/**
 * 抓取各功能页面截图，供 README 使用。用 Playwright 自带的 Chromium。
 *
 *   BASE_URL=http://localhost:3300 node scripts/shoot.mjs
 *
 * 只对演示库拍：截图会进公开仓库，不能带任何真实客户数据。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve("docs/shots");

mkdirSync(OUT, { recursive: true });

/** 顺序即文档中的呈现顺序 */
const PAGES = [
  { file: "01-login", url: "/login", auth: false, label: "登录页", viewport: { width: 1080, height: 860 } },
  { file: "02-dashboard", url: "/dashboard", label: "数据首页", settle: 2500 },
  { file: "03-leads", url: "/leads", label: "线索管理" },
  { file: "04-customers", url: "/customers", label: "客户列表" },
  { file: "05-customer-detail", url: null, label: "客户详情·跟进记录", settle: 1500 },
  { file: "06-contacts", url: "/contacts", label: "联系人" },
  { file: "06b-channels", url: "/channels", label: "渠道管理·转介绍雷达" },
  { file: "07-opportunities", url: "/opportunities", label: "商机列表" },
  { file: "08-pipeline", url: "/opportunities/pipeline", label: "商机管道" },
  { file: "09-follow-ups", url: "/follow-ups", label: "跟进记录" },
  { file: "10-plans", url: "/follow-ups/plans", label: "跟进计划" },
  { file: "10b-reports", url: "/reports", label: "数据复盘", settle: 2500 },
  { file: "11-settings", url: "/settings", label: "设置管理" },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1680, height: 1050 },
  deviceScaleFactor: 2,
  locale: "zh-CN",
});
const page = await ctx.newPage();

// 隐藏 Next.js 开发环境浮标
await page.addInitScript(() => {
  const css = "nextjs-portal,[data-nextjs-toast],#__next-build-watcher{display:none !important}";
  const inject = () => {
    const s = document.createElement("style");
    s.textContent = css;
    document.head?.appendChild(s);
  };
  if (document.head) inject();
  else document.addEventListener("DOMContentLoaded", inject);
});

async function login() {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="用户名"]', process.env.SHOT_USER ?? "zhangsan");
  await page.fill('input[placeholder="登录密码"]', process.env.SHOT_PASSWORD ?? "crm@2026");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  await page.waitForLoadState("networkidle");
}

async function shoot(name, settle = 900) {
  // 等图表等异步绘制完成
  await page.waitForTimeout(settle);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log("✓", name);
}

// 未登录页先拍
for (const p of PAGES.filter((p) => p.auth === false)) {
  if (p.viewport) await page.setViewportSize(p.viewport);
  await page.goto(`${BASE}${p.url}`, { waitUntil: "networkidle" });
  await shoot(p.file);
}
await page.setViewportSize({ width: 1680, height: 1050 });

await login();

// 取一个跟进记录最丰富的客户做详情页样本
const detailHref = await page.evaluate(async () => {
  const r = await fetch("/customers", { headers: { accept: "text/html" } });
  const html = await r.text();
  const m = html.match(/\/customers\/(c[a-z0-9]{20,})/);
  return m ? m[0] : null;
});

for (const p of PAGES.filter((p) => p.auth !== false)) {
  const url = p.url ?? detailHref;
  if (!url) {
    console.warn("跳过（未取到客户 id）:", p.file);
    continue;
  }
  await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  await shoot(p.file, p.settle);
}

await browser.close();
console.log("\n截图已输出到", OUT);
