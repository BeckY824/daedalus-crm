/**
 * 背调卡在真浏览器里（components/research，2026-10-16）。打包法照 workspace-picker.ui.test：esbuild 打成一个 iife，
 * Playwright 的 Chromium 里挂上，服务端动作换成桩、/api/ai/stream 由页面路由拦下来回一串写好的事件。
 *
 * 钉的是：
 *   1. 开跑前先问：说清扣几次、还剩几次；点「开始」才发请求
 *   2. 流式事件一条条展开：6 步、档案格、分数、信号 / 风险、老客户、来源；[n] 角标指向那一页
 *   3. 跑完「存进客户」先列库里像的那几位，点了才存；存好以后变成「已存进」
 *   4. Windows 那三个坑：减弱动态时转圈不停（放慢）、扫光撤掉；数字不用等宽字体；没有 500 字重
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { 初始状态, 归约 } from "@/lib/research/state";
import { 算相关性 } from "@/lib/research/score";
import type { 研究事件 } from "@/lib/research/types";

let browser: Browser;
let bundle: string;
const css = [fs.readFileSync(path.resolve("src/app/globals.css"), "utf8"), fs.readFileSync(path.resolve("src/components/research/research.css"), "utf8")].join("\n");

const 官网 = "https://lumora-trading.example/about";
const 事件: 研究事件[] = [
  { type: "stage", stage: "identify", status: "running" },
  { type: "thought", stage: "identify", text: "先找官网，排除同名公司" },
  { type: "tool", stage: "identify", id: "t1", kind: "search", label: "搜索「Lumora Trading GmbH」", status: "done", result: "5 条结果", ms: 900, sources: [{ title: "Lumora — About us", url: 官网 }] },
  { type: "field", key: "site", value: "lumora-trading.example", source: 官网 },
  { type: "field", key: "country", value: "德国·汉堡", source: 官网 },
  { type: "stage", stage: "identify", status: "done", summary: "官网和登记对上了" },
  { type: "stage", stage: "basics", status: "running" },
  { type: "field", key: "contact", value: "sales@lumora-trading.example", source: 官网 },
  { type: "stage", stage: "basics", status: "done", summary: "照明进口分销" },
  { type: "stage", stage: "fit", status: "running" },
  { type: "similar", items: [{ id: "c-1", name: "Nordlicht Elektro", 档: "high", 像在哪: "同在德国、都做电气批发" }], 比了: 2 },
  { type: "score", 评分: 算相关性([{ 维度: "category", 档: "high", 证据: "主营户外照明", 来源: 官网 }, { 维度: "buyerType", 档: "mid", 证据: "分销" }]) },
  { type: "stage", stage: "fit", status: "done", summary: "对口" },
  { type: "stage", stage: "signals", status: "running" },
  { type: "tag", tone: "signal", text: "在招户外照明品类经理" },
  { type: "stage", stage: "signals", status: "done" },
  { type: "stage", stage: "risks", status: "running" },
  { type: "tag", tone: "risk", level: "low", text: "一次付款延迟" },
  { type: "stage", stage: "risks", status: "done" },
  { type: "stage", stage: "approach", status: "running" },
  { type: "approach", points: ["找品类经理", "主推工矿灯"] },
  { type: "stage", stage: "approach", status: "done" },
  { type: "usage", searches: 1, pages: 0 },
  { type: "done", charge: 6, 不完整: false },
];
const 最终 = 事件.reduce(归约, 初始状态({ name: "Lumora Trading GmbH" }));

beforeAll(async () => {
  const 入口 = `
    import React from 'react'; import { createRoot } from 'react-dom/client'; import { App } from 'antd';
    import ResearchRun from '@/components/research/ResearchRun';
    import ResearchCard from '@/components/research/ResearchCard';
    const 模式 = window.__模式;
    createRoot(document.getElementById('root')).render(<App>{模式 === 'run'
      ? <ResearchRun jobKey="t:1" company="Lumora Trading GmbH" />
      : <ResearchCard s={window.__状态} running={模式 === 'running'} />}</App>);`;
  const r = await build({
    stdin: { contents: 入口, loader: "tsx", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { "@": path.resolve("src") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "stubs",
        setup(b) {
          b.onResolve({ filter: /\.css$/ }, () => ({ path: "css", namespace: "stub" }));
          b.onResolve({ filter: /^@\/lib\/research\/actions$/ }, () => ({ path: "actions", namespace: "stub" }));
          b.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "stub" }));
          b.onLoad({ filter: /^css$/, namespace: "stub" }, () => ({ contents: "", loader: "js" }));
          b.onLoad({ filter: /^link$/, namespace: "stub" }, () => ({
            contents: "import React from 'react'; export default function Link({href, children, ...p}) { return React.createElement('a', {href, ...p}, children); }",
            loader: "js",
            resolveDir: process.cwd(),
          }));
          b.onLoad({ filter: /^actions$/, namespace: "stub" }, () => ({
            contents: `
              export const 背调价目 = async () => ({ 可用: true, 扣次: 6, 还剩: 23, 模拟: false });
              export const 找同名客户 = async () => [{ id: 'c-9', name: 'Lumora GmbH' }];
              export const 认联系方式 = async () => ({ email: 'sales@lumora-trading.example', phone: '' });
              export const 存背调到客户 = async (id, s) => { window.__存.push([id, s.目标.name]); return { ok: true, id }; };
              export const 新建客户并存背调 = async () => ({ ok: true, id: 'new' });
              export const 最近背调 = async () => null;`,
            loader: "js",
          }));
        },
      },
    ],
    logLevel: "silent",
  });
  bundle = r.outputFiles[0].text;
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function open(模式: "run" | "done" | "running", opts: { reducedMotion?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage({ reducedMotion: opts.reducedMotion ? "reduce" : "no-preference" });
  // 打包出来的组件在页面里崩了的话，测试只会表现成「等不到」超时：把页面报错打出来
  page.on("pageerror", (e) => console.error("[页面报错]", e.message));
  await page.route("http://card.test/", (r) => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.route("http://card.test/api/ai/stream", (r) => {
    const 体 = JSON.parse(r.request().postData() ?? "{}");
    (globalThis as unknown as { __请求: unknown[] }).__请求.push(体);
    const sse = [{ type: "research-start", 扣次: 6 }, ...事件.map((e) => ({ type: "research", e })), { type: "result", ok: true, answer: { text: "报告", records: [], customers: [], proposals: [], research: 最终 } }]
      .map((x) => `data: ${JSON.stringify(x)}\n\n`)
      .join("");
    return r.fulfill({ contentType: "text/event-stream", body: sse });
  });
  await page.goto("http://card.test/");
  await page.addStyleTag({ content: css });
  // 组件里有读 process.env 的（业务配置那一层），Next 会把它编进去，这里打的包没有：给一个空的
  await page.addScriptTag({ content: `window.process={env:{}}; window.__模式=${JSON.stringify(模式)}; window.__存=[]; window.__状态=${JSON.stringify(模式 === "running" ? 事件.slice(0, 3).reduce(归约, 初始状态({ name: "Lumora Trading GmbH" })) : 最终)};` });
  await page.addScriptTag({ content: bundle });
  return page;
}

it("开跑前先问扣几次；点「开始」才发请求，流式展开到完成；存进客户先列像的那几位", async () => {
  (globalThis as unknown as { __请求: unknown[] }).__请求 = [];
  const page = await open("run");
  const 确认 = page.getByRole("group", { name: "背调确认" });
  await 确认.waitFor();
  expect(await 确认.textContent()).toContain("扣 6 次 AI，你还剩 23 次");
  expect((globalThis as unknown as { __请求: unknown[] }).__请求).toHaveLength(0);

  await page.getByRole("button", { name: "开始背调" }).click();
  await page.getByText("已完成").waitFor();
  expect((globalThis as unknown as { __请求: unknown[] }).__请求).toEqual([{ mode: "research", company: "Lumora Trading GmbH" }]);
  expect(await page.locator(".rs-stage-done").count()).toBe(6);
  expect(await page.locator(".rs-charge").textContent()).toBe("扣 6 次 AI");

  await page.getByRole("button", { name: "存进客户" }).click();
  await page.getByRole("button", { name: "存到「Lumora GmbH」" }).click();
  await page.getByRole("button", { name: "✓ 已存进「Lumora GmbH」" }).waitFor();
  expect(await page.evaluate(() => (window as unknown as { __存: unknown[] }).__存)).toEqual([["c-9", "Lumora Trading GmbH"]]);
  // 新建那一栏把查到的邮箱填好了
  await page.close();
}, 30_000);

it("跑完的卡：档案、[n] 来源角标、分数、老客户、信号 / 风险、来源表都在", async () => {
  const page = await open("done");
  const 卡 = page.getByRole("region", { name: "背调 Lumora Trading GmbH" });
  await 卡.waitFor();
  const t = (await 卡.textContent()) ?? "";
  for (const x of ["德国·汉堡", "sales@lumora-trading.example", "像你的老客户", "Nordlicht Elektro", "在招户外照明品类经理", "风险·低", "一次付款延迟", "找品类经理", "Lumora — About us"]) expect(t).toContain(x);
  expect(await page.locator(".rs-ref").first().getAttribute("href")).toBe(官网);
  expect(await page.locator(".rs-ref").first().getAttribute("target")).toBe("_blank");
  await expect.poll(async () => page.locator(".rs-score-num").textContent()).toBe(String(最终.评分!.分));
  // 做完的那一步折成一行，点开看过程
  await page.getByRole("button", { name: /认准公司/ }).click();
  await page.getByText("搜索「Lumora Trading GmbH」").waitFor();
  await page.close();
}, 30_000);

it("系统开了「减弱动态」：转圈照转（放慢），扫光撤掉——不然 Windows 关了动画的机器看着像卡死", async () => {
  const page = await open("running", { reducedMotion: true });
  await page.locator(".rs-node-ring").waitFor();
  const 圈 = await page.locator(".rs-node-ring").evaluate((el) => getComputedStyle(el));
  expect(圈.animationIterationCount).toBe("infinite");
  expect(圈.animationDuration).toBe("1.6s");
  const 扫光 = await page.locator(".rs-shimmer").first().evaluate((el) => getComputedStyle(el, "::after").display);
  expect(扫光).toBe("none");
  await page.close();
}, 30_000);

it("Windows 字体：卡上不用等宽字体栈（中文会落到宋体），样式表里没有 500 字重", async () => {
  const page = await open("done");
  await page.locator(".rs-stage-sum").first().waitFor();
  const 字体 = await page.locator(".rs-status .rs-num").first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(字体).not.toMatch(/Mono|Menlo|Consolas|monospace/);
  await page.close();
  const 样式 = fs.readFileSync(path.resolve("src/components/research/research.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(样式).not.toMatch(/font-weight:\s*500/);
  expect(样式).not.toMatch(/--font-mono/);
}, 30_000);
