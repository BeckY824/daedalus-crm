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
import { 合成真实性 } from "@/lib/research/verify/rules";

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
    import ResearchRun, { ResearchPick } from '@/components/research/ResearchRun';
    import ResearchCard from '@/components/research/ResearchCard';
    import ResearchModeLine from '@/components/research/ResearchModeLine';
    import MailPaste from '@/components/research/MailPaste';
    import ResearchPerson, { PersonCard } from '@/components/research/ResearchPerson';
    const 模式 = window.__模式;
    createRoot(document.getElementById('root')).render(<App>{模式 === 'person'
      ? <PersonCard s={window.__状态} running={false} onPick={(c) => window.__选.push(c)} />
      : 模式 === 'person-confirm'
      ? <ResearchPerson jobKey="t:p" 名="Anna Beispiel" 电话="+49 40 0000 0000" onPick={() => {}} onAsCompany={(x) => window.__选.push(x)} onCancel={() => {}} />
      : 模式 === 'person-fake'
      ? <ResearchPerson jobKey="t:pf" 电话="+44 20 7946 0123" onPick={() => {}} onCancel={() => {}} />
      : 模式 === 'mail'
      ? <MailPaste open onCancel={() => {}} onOk={(x) => window.__邮件.push(x)} />
      : 模式 === 'direct-mail'
      ? <ResearchRun jobKey="t:3" company="abc-lighting.ae" 直接开跑 需求="查一下这家" 邮件={window.__带邮件} />
      : 模式 === 'run'
      ? <ResearchRun jobKey="t:1" company="Lumora Trading GmbH" />
      : 模式 === 'direct'
        ? <ResearchRun jobKey="t:2" company="Lumora Trading GmbH" 直接开跑 需求="帮我查 Lumora 适不适合我们" />
        : 模式 === 'pick'
          ? <ResearchPick 待选={window.__待选} onPick={(c) => window.__选.push(c)} />
          : 模式 === 'line'
            ? <ResearchModeLine 价={window.__价目} />
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
              export const 背调价目 = async () => (window.__价目 ?? { 可用: true, 扣次: 1, 还剩: 3, 模拟: false });
              export const 找同名客户 = async () => [{ id: 'c-9', name: 'Lumora GmbH' }];
              export const 认联系方式 = async () => ({ email: 'sales@lumora-trading.example', phone: '' });
              export const 存背调到客户 = async (id, s) => { window.__存.push([id, s.目标.name]); return { ok: true, id }; };
              export const 新建客户并存背调 = async () => ({ ok: true, id: 'new' });
              export const 最近背调 = async () => null;
              export const 认号码动作 = async (号) => 号.includes('7946')
                ? ({ 号: '+44 20 7946 0123', 本国: '020 7946 0123', 本体: '2079460123', 国家: 'GB', 国名: '英国', 类型: '固话', 有效: true, 虚构: 'Ofcom 留给影视剧的虚构号段（伦敦 020 7946 0xxx）' })
                : ({ 号: '+49 40 00000000', 本国: '040 00000000', 本体: '4000000000', 国家: 'DE', 国名: '德国', 类型: '固话', 有效: true });`,
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

async function open(模式: "run" | "done" | "running" | "direct" | "pick" | "line" | "mail" | "direct-mail" | "person" | "person-confirm" | "person-fake", opts: { reducedMotion?: boolean; 价目?: unknown; 待选?: unknown; 状态?: unknown; 带邮件?: unknown } = {}): Promise<Page> {
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
  await page.addScriptTag({ content: `window.process={env:{}}; window.__价目=${JSON.stringify(opts.价目 ?? null)} ?? undefined; window.__待选=${JSON.stringify(opts.待选 ?? null)}; window.__选=[]; window.__邮件=[]; window.__带邮件=${JSON.stringify(opts.带邮件 ?? null)} ?? undefined; window.__模式=${JSON.stringify(模式)}; window.__存=[]; window.__状态=${JSON.stringify(opts.状态 ?? (模式 === "running" ? 事件.slice(0, 3).reduce(归约, 初始状态({ name: "Lumora Trading GmbH" })) : 最终))};` });
  await page.addScriptTag({ content: bundle });
  return page;
}

it("开跑前先问扣几次；点「开始」才发请求，流式展开到完成；存进客户先列像的那几位", async () => {
  (globalThis as unknown as { __请求: unknown[] }).__请求 = [];
  const page = await open("run");
  const 确认 = page.getByRole("group", { name: "背调确认" });
  await 确认.waitFor();
  // 背调次数和问答次数分开（10-16 用户）：一次扣 1 次背调
  expect(await 确认.textContent()).toContain("背调用的是我们的搜索和分析服务，开始搜索后扣 1 次背调（你还剩 3 次背调）；还没开始搜就停了的不扣");
  expect((globalThis as unknown as { __请求: unknown[] }).__请求).toHaveLength(0);

  await page.getByRole("button", { name: "开始背调" }).click();
  await page.getByText("已完成").waitFor();
  expect((globalThis as unknown as { __请求: unknown[] }).__请求).toEqual([{ mode: "research", company: "Lumora Trading GmbH" }]);
  expect(await page.locator(".rs-stage-done").count()).toBe(6);
  expect(await page.locator(".rs-charge").textContent()).toBe("扣 6 次背调"); // 事件里 done.charge 写的 6：卡上照实显示服务器扣了几次（背调次数，和问答的 AI 次数分开）

  await page.getByRole("button", { name: "存进客户" }).click();
  await page.getByRole("button", { name: "存到「Lumora GmbH」" }).click();
  await page.getByRole("button", { name: "✓ 已存进「Lumora GmbH」" }).waitFor();
  expect(await page.evaluate(() => (window as unknown as { __存: unknown[] }).__存)).toEqual([["c-9", "Lumora Trading GmbH"]]);
  // 新建那一栏把查到的邮箱填好了
  await page.close();
}, 30_000);

it("背调次数用完：开始按钮是灰的，说清楚（背调是付费功能，问答次数再多也不顶用）", async () => {
  const page = await open("run", { 价目: { 可用: true, 扣次: 1, 还剩: 0, 模拟: false } });
  const 确认 = page.getByRole("group", { name: "背调确认" });
  await 确认.waitFor();
  expect(await 确认.textContent()).toContain("你还剩 0 次背调");
  expect(await 确认.textContent()).toContain("背调次数用完了");
  expect(await page.getByRole("button", { name: "开始背调" }).isDisabled()).toBe(true);
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

it("真实性块（程序直查、不进 100 分）：总灯、每一项的灯和事实、链接；分数旁一个小灯；进口记录一行；查得少出「信息少，谨慎」", async () => {
  const 真实性 = 合成真实性(
    [
      { key: "registry", 灯: "yellow", 态: "没查到", 事实: "GLEIF 里没查到「Ghost Trading」" },
      { key: "domain", 灯: "yellow", 态: "已核", 事实: "ghost-trading.example 注册于 2026-09-18（RDAP），才 30 天", 新域名: true, 链接: [{ title: "ghost-trading.example 的 RDAP 记录", url: "https://rdap.example/ghost" }] },
      { key: "sanctions", 灯: "green", 态: "已核", 事实: "美国 OFAC / 欧盟：未命中（名单更新于 10-18）" },
    ],
    { key: "footprint", 灯: "yellow", 态: "没查到", 事实: "Facebook 主页：未搜到；LinkedIn：我们用的网页搜索不收录，没法查（不扣分）" },
    { 名单更新于: "2026-10-18T01:00:00Z" },
  );
  const s = [...事件.slice(0, -1), { type: "verify", 真实性 }, { type: "verify-note", text: "域名很新、网上几乎没有足迹，先要营业执照。" }, { type: "import", 有: false }, 事件.at(-1)!]
    .reduce((a, e) => 归约(a, e as 研究事件), 初始状态({ name: "Ghost Trading" }));
  const page = await open("done", { 状态: s });
  const 块 = page.locator(".rs-trust");
  await 块.waitFor();
  const t = (await 块.textContent()) ?? "";
  for (const x of ["真实性", "高危", "域名注册不到 90 天", "程序直查 · 不经模型", "域名很新、网上几乎没有足迹", "工商登记", "才 30 天", "Facebook 主页：未搜到", "邮件头", "没贴询盘邮件原文", "制裁名单（美国 OFAC、欧盟、联合国、英国）更新于 2026-10-18"]) expect(t).toContain(x);
  expect(await 块.getAttribute("class")).toContain("rs-trust-red");
  expect(await page.locator(".rs-check").count()).toBe(9);
  expect(await page.getByRole("link", { name: "ghost-trading.example 的 RDAP 记录" }).getAttribute("href")).toBe("https://rdap.example/ghost");
  expect(await page.locator(".rs-fit-light").textContent()).toBe("真实性高危");
  expect(await page.locator(".rs-fields").textContent()).toContain("未查到公开进口记录");
  const 横幅 = page.getByRole("note");
  expect(await 横幅.textContent()).toContain("信息少，谨慎");
  expect(await 横幅.textContent()).toContain("建议先要营业执照、视频验厂");
  // 窄面板（首页右侧、记录页右栏）也不撑破
  await page.setViewportSize({ width: 380, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 380)).toBe(true);
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

it("背调模式发出来的（直接开跑）：不出确认卡，挂上就发请求，原话一起带上", async () => {
  (globalThis as unknown as { __请求: unknown[] }).__请求 = [];
  const page = await open("direct");
  await page.getByText("已完成").waitFor();
  expect(await page.getByRole("group", { name: "背调确认" }).count()).toBe(0);
  expect((globalThis as unknown as { __请求: unknown[] }).__请求).toEqual([{ mode: "research", company: "Lumora Trading GmbH", need: "帮我查 Lumora 适不适合我们" }]);
  await page.close();
}, 30_000);

it("认不准是哪家：点候选、或者补一句再开始；说清还没扣次数", async () => {
  const page = await open("pick", { 待选: { 种类: "候选", 候选: ["Rexel", "Sonepar"] } });
  const 卡 = page.getByRole("group", { name: "选要背调的公司" });
  await 卡.waitFor();
  expect(await 卡.textContent()).toContain("还没扣次数");
  await page.getByRole("button", { name: "背调「Sonepar」" }).click();
  await page.getByLabel("公司名或官网").fill("rexel.com");
  await page.getByRole("button", { name: "开始背调" }).click();
  expect(await page.evaluate(() => (window as unknown as { __选: string[] }).__选)).toEqual(["Sonepar", "rexel.com"]);
  await page.close();
}, 30_000);

it("背调模式那一行：剩几次；用完了说还差几次", async () => {
  let page = await open("line", { 价目: { 可用: true, 扣次: 1, 还剩: 4, 模拟: false } });
  await page.getByText("背调 · 开始搜索后扣 1 次 · 剩 4 次").waitFor();
  await page.close();
  page = await open("line", { 价目: { 可用: true, 扣次: 1, 还剩: 0, 模拟: false } });
  await page.getByText("还差 1 次，需要加次数请联系我们").waitFor();
  await page.close();
  page = await open("line", { 价目: { 可用: false, 原因: "背调要联网搜索，请先在桌面端登录账号" } });
  await page.getByText("背调用不了：背调要联网搜索，请先在桌面端登录账号").waitFor();
  await page.close();
}, 30_000);

const 询盘原文 = [
  "Received: from mail.abc-lighting.ae (mail.abc-lighting.ae [94.200.1.10]) by mx1.ourfactory.cn with ESMTP id 999",
  "Received: from DESKTOP-AHMED (unknown [192.168.1.23]) by mail.abc-lighting.ae with ESMTPA",
  "Authentication-Results: mx1.ourfactory.cn; spf=pass smtp.mailfrom=abc-lighting.ae; dkim=pass header.d=abc-lighting.ae",
  'From: "Ahmed" <ahmed@abc-lighting.ae>',
  "Reply-To: ahmed.abc@gmail.com",
  "Subject: Inquiry",
  "",
  "Dear Sir, we need 2000 pcs.",
  "Tel: +971 4 123 4567",
].join("\n");

it("粘贴询盘邮件（第二期）：粘原文当场认出发件人 / IP / 认证 / 电话，回复地址换了标出来；只粘正文给提示、按钮灰；手机宽度不横向滚", async () => {
  const page = await open("mail");
  const 框 = page.getByRole("textbox", { name: "询盘邮件原文" });
  await 框.waitFor();
  const 带上 = page.getByRole("button", { name: "带上这封邮件" });
  await 框.fill("Dear Sir, we need 2000 pcs LED street light.");
  expect(await page.textContent(".mp-warn")).toContain("不像邮件原文");
  expect(await 带上.isDisabled()).toBe(true);
  await 框.fill(询盘原文);
  const 认 = page.getByRole("definition");
  expect(await 认.allTextContents()).toEqual([
    "ahmed@abc-lighting.ae",
    "ahmed.abc@gmail.com（和发件人不是一个域名，留意）",
    "94.200.1.10（最早一跳，背调时在本机查国家）",
    "SPF 通过、DKIM 通过",
    "+971 4 123 4567",
  ]);
  expect(await page.textContent(".mp-note")).toContain("原文不上传");
  await page.setViewportSize({ width: 380, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 380)).toBe(true);
  await 带上.click();
  const 交 = (await page.evaluate(() => (window as unknown as { __邮件: unknown[] }).__邮件)) as Record<string, unknown>[];
  expect(交).toHaveLength(1);
  expect(交[0]).toMatchObject({ 发件人: "ahmed@abc-lighting.ae", 回复到: "ahmed.abc@gmail.com", 发件IP: "94.200.1.10", spf: "pass", dkim: "pass" });
  expect(JSON.stringify(交[0])).not.toContain("Dear Sir");
  await page.close();
});

it("带着邮件开跑：请求里只有认出来的那几样，没有原文", async () => {
  (globalThis as unknown as { __请求: unknown[] }).__请求 = [];
  const 信 = { 发件人: "ahmed@abc-lighting.ae", 发件IP: "94.200.1.10", IP来源: "最早一跳", spf: "pass", 电话: ["+971 4 123 4567"], 跳数: 2 };
  const page = await open("direct-mail", { 带邮件: 信 });
  await expect.poll(() => (globalThis as unknown as { __请求: unknown[] }).__请求.length).toBe(1);
  const 体 = (globalThis as unknown as { __请求: Record<string, unknown>[] }).__请求[0];
  expect(体.mail).toEqual(信);
  await page.close();
});

it("10-18 新加的几块：结论和封顶、风险必查四项、公开联系人、在卖型号、型号对比、英文开发信（能复制）", async () => {
  const 加: 研究事件[] = [
    { type: "contacts", items: [{ 岗位: "采购负责人", 姓名: "Jan Beispiel", 电话: "+49 40 0000 0000", source: 官网 }] },
    { type: "models", items: [{ 型号: "HB-150", 是什么: "工矿灯", source: 官网 }] },
    {
      type: "checks",
      项: [
        { key: "母公司", 结论: "独立公司", 级别: "none", source: 官网 },
        { key: "财务", 结论: "查不到（材料里没有）", 级别: "none" },
        { key: "同行", 结论: "母公司自己有工厂", 级别: "mid", source: 官网, 是: "部分" },
        { key: "市场", 结论: "在德奥瑞", 级别: "none", source: 官网 },
      ],
    },
    { type: "score", 评分: 算相关性([{ 维度: "category", 档: "high", 证据: "主营户外照明", 来源: 官网 }, { 维度: "buyerType", 档: "high", 证据: "分销" }], [], {}, { 同行: "部分" }) },
    { type: "compare", items: [{ 对方: "HB-150", 我们: "UFO 工矿灯 150W", 怎么比: "同功率，我们有 ENEC 版" }] },
    { type: "email", 主题: "High-bays for Lumora", 正文: "Dear Mr Beispiel,\n\nWe make high-bay fixtures." },
  ];
  const s = [...事件.slice(0, -1), ...加, 事件.at(-1)!].reduce(归约, 初始状态({ name: "Lumora Trading GmbH" }));
  const page = await open("done", { 状态: s });
  const 卡 = page.getByRole("region", { name: "背调 Lumora Trading GmbH" });
  await 卡.waitFor();
  const t = (await 卡.textContent()) ?? "";
  for (const x of ["公开联系人", "采购负责人 · Jan Beispiel · +49 40 0000 0000", "在卖的型号", "HB-150", "风险必查", "母公司 / 股东", "近两年财务", "查不到（材料里没有）", "是不是同行", "母公司自己有工厂", "型号对比", "UFO 工矿灯 150W", "英文开发信", "Subject: High-bays for Lumora"]) expect(t).toContain(x);
  // 可信度 40%、部分同行：按权重算 100，封顶 50；结论跟着分数走
  expect(await page.locator(".rs-cap").textContent()).toContain("按权重算 100 分，封顶 50 分");
  expect(await page.locator(".rs-verdict").textContent()).toContain("可以试");
  await expect.poll(async () => page.locator(".rs-score-num").textContent()).toBe("50");
  // 查不到的那一行没有来源角标
  expect(await page.locator(".rs-must").nth(1).locator(".rs-ref").count()).toBe(0);
  // card.test 不是安全来源，没有真剪贴板：换个桩，看写进去的是什么
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async (x: string) => void ((window as unknown as { __剪: string }).__剪 = x) } }));
  await page.getByRole("button", { name: "复制开发信" }).click();
  await page.getByRole("button", { name: "已复制" }).waitFor();
  expect(await page.evaluate(() => (window as unknown as { __剪: string }).__剪)).toBe("Subject: High-bays for Lumora\n\nDear Mr Beispiel,\n\nWe make high-bay fixtures.");
  await page.close();
}, 30_000);

it("只有人名 + 电话：开跑前先判号码、写明「开始搜索后扣 1 次」，可以改说是公司名", async () => {
  const page = await open("person-confirm");
  const 确认 = page.getByRole("group", { name: "找这个人所在的公司" });
  await 确认.waitFor();
  const t = (await 确认.textContent()) ?? "";
  expect(t).toContain("（德国固话）");
  expect(t).toContain("判号码不扣次数；开始搜索后扣 1 次背调");
  expect(t).toContain("找不到公司也照扣");
  await page.getByRole("button", { name: "「Anna Beispiel」其实是公司名，直接背调" }).click();
  expect(await page.evaluate(() => (window as unknown as { __选: unknown[] }).__选)).toEqual(["Anna Beispiel"]);
  await page.close();
}, 30_000);

it("只有一个虚构号码（Ofcom 影视剧号段）：写明是虚构号码、不拿它找公司，「开始找公司」点不了", async () => {
  const page = await open("person-fake");
  const 确认 = page.getByRole("group", { name: "找这个人所在的公司" });
  await 确认.waitFor();
  const t = (await 确认.textContent()) ?? "";
  expect(t).toContain("这是虚构号码（Ofcom 留给影视剧的虚构号段（伦敦 020 7946 0xxx））");
  expect(t).toContain("只有这个号码，没法找公司");
  expect(t).not.toContain("先上网搜这个号码");
  expect(await page.getByRole("button", { name: "开始找公司" }).isDisabled()).toBe(true);
  await page.close();
}, 30_000);

it("只有人名 + 电话：候选公司点选接着背调；「都不是」出「只有人」简版，带「信息少，谨慎」和 WhatsApp 说明", async () => {
  const 号 = { 号: "+49 40 00000000", 本国: "040 00000000", 本体: "4000000000", 国家: "DE", 国名: "德国", 类型: "固话", 有效: true };
  const 名录 = { title: "Lumora Trading GmbH — Kontakt", url: "https://directory.example/lumora-trading-gmbh" };
  const 候选 = { 公司: "Lumora Trading GmbH", 官网: "https://lumora-trading.example", 依据: "号码出现在名录里这家的联系方式上", 来源: 名录, 号码对上: true, 名字对上: false };
  const s = ([
    { type: "person", 名: "Anna Beispiel", 号 },
    { type: "tool", stage: "person", id: "p1", kind: "search", label: "搜索「\"+49 40 0000 0000\"」", status: "done", result: "2 条结果", ms: 500, sources: [名录] },
    { type: "person-found", 候选: [候选], 出现: { 号码: [名录], 名字: [] }, 建议: ["回邮件问一句公司全名和官网"] },
    { type: "usage", searches: 3, pages: 0 },
  ] as 研究事件[]).reduce(归约, 初始状态({ name: "Anna Beispiel" }));
  const page = await open("person", { 状态: s });
  await page.getByText("认出的公司（点一家接着背调，不另扣）").waitFor();
  expect(await page.locator(".rs-cand").textContent()).toContain("号码对上");
  await page.getByRole("button", { name: "背调这家" }).click();
  expect(await page.evaluate(() => (window as unknown as { __选: { 公司: string }[] }).__选.map((c) => c.公司))).toEqual(["Lumora Trading GmbH"]);
  await page.getByRole("button", { name: "都不是，只看这个人" }).click();
  const 简 = page.locator(".rs-thin");
  await 简.waitFor();
  expect(await 简.textContent()).toContain("信息少，谨慎");
  const 全 = (await page.locator(".rs-card").textContent()) ?? "";
  expect(全).toContain("在 1 个公开页面上出现过");
  expect(全).toContain("回邮件问一句公司全名和官网");
  expect(全).toContain("没有登录、没有抓取");
  await page.close();
}, 30_000);
