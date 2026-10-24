/**
 * 商机看板分批（2026-10-24 企业版压测）在真浏览器里和「全取回来画」对拍：
 * 同一份数据，左边照分批的做法（lib/pipeline-page.ts 取管道 + 「再看 50 条」换 n= 重取），
 * 右边把全部卡片一次给 PipelineView、不带列头（原来的做法：列头在卡片上算）。库换成内存里的假库，取数代码本身照跑。
 *
 *   - 每列列头的条数、按币种合计和全取的一样；每列摆的是全取那列的前 50 张
 *   - 「再看 50 条」/「再看剩下 N 条」一直点到底：整个看板和全取的一模一样
 *   - 每列不到 50 张、只有自己（个人版）：两边一模一样，没有「再看」
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "pipeline-pager-ui", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "stub", pluginData: code }));
  // 「再看」换 URL：交给测试里的假服务端重取（和 Next 一样，新的一版整份到了才换）
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){},push(){},replace(u){window.__replace(u)}});export const usePathname=()=>'/opportunities/pipeline';");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/(^|\/)demo-data$/, "export const 查演示数据状态=async()=>null,灌一套演示数据=async()=>({ok:false}),清除演示数据=灌一套演示数据;");
  stub(/(^|\/)(OpportunityForm|ContractForm)$/, "export default function F(){return null}");
  stub(/(^|\/)actions$/, "export const moveStage=async()=>({ok:true});");
  b.onLoad({ filter: /.*/, namespace: "stub" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };

beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React, {useEffect, useState} from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import {BusinessProvider} from '@/lib/business-client';import {DEFAULT_BUSINESS} from '@/lib/business-config';
    import {OPP_STAGES} from '@/lib/constants';
    import {取管道} from '@/lib/pipeline-page';import {读每列} from '@/lib/pipeline-columns';
    import PipelineView from '@/app/(app)/opportunities/pipeline/PipelineView';
    const cfg = window.__cfg;
    let s = cfg.种子 >>> 0;
    const r = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const 人 = cfg.人.map((id) => ({ id, name: '成员' + id }));
    const 行 = [];
    let i = 0;
    OPP_STAGES.forEach((stage, k) => {
      for (let j = 0; j < cfg.每列[k]; j++) {
        const o = 人[Math.floor(r() * 人.length)];
        // 同金额一大片；币种有人民币、美元、小写欧元、没有币种行的老数据
        const amount = r() < 0.4 ? 50000 : Math.round(r() * 200) * 1000;
        const money = [null, { currency: 'CNY' }, { currency: 'USD' }, { currency: 'eur' }][Math.floor(r() * 4)];
        行.push({ id: 'o' + (i++ * 7919 % 100003), name: '商机' + i, amount, stage, status: stage === '赢单成交' ? 'WON' : 'OPEN', probability: 10 + (j % 9) * 10, expectedDealAt: null, customer: { id: 'c' + (j % 7), name: '客户' + (j % 7) }, owner: { name: o.name }, ownerId: o.id, money });
      }
    });
    // 假库：只认 取管道 用到的那几样（金额从大到小、同金额按 id、id in）
    const 排 = (xs) => [...xs].sort((a, c) => c.amount - a.amount || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
    const db = { opportunity: { findMany: async ({ where }) => { const 要 = where.AND?.[1]?.id?.in && new Set(where.AND[1].id.in); return 排(行.filter((x) => !要 || 要.has(x.id))); } } };
    const 起 = new Date('2026-09-21T00:00:00Z');
    function 分批() {
      const [页, set页] = useState(null);
      const 取 = (n) => 取管道(db, 起, n).then((p) => set页({ ...p, n }));
      useEffect(() => {
        window.__replace = (u) => { const n = 读每列(new URL(u, location.href).searchParams.get('n')); history.replaceState(null, '', u); window.__翻 = (window.__翻 ?? 0) + 1; return 取(n); };
        取(读每列(null));
      }, []);
      return 页 && <PipelineView 赢单天数={30} users={人} customers={[]} rows={页.rows} 列={页.列} 总条数={页.总条数} 全部负责人={页.负责人} 每列={页.n} />;
    }
    function 全取() {
      const [rows, set] = useState(null);
      useEffect(() => { 取管道(db, 起, Object.fromEntries(OPP_STAGES.map((s) => [s, 1e6]))).then((p) => set(p.rows)); }, []);
      return rows && <PipelineView 赢单天数={30} users={人} customers={[]} rows={rows} />;
    }
    const 包 = (x) => <ConfigProvider locale={zhCN}><App><BusinessProvider value={DEFAULT_BUSINESS} timeZone={null}>{x}</BusinessProvider></App></ConfigProvider>;
    createRoot(document.getElementById('paged')).render(包(<分批 />));
    createRoot(document.getElementById('full')).render(包(<全取 />));
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

type 配置 = { 种子: number; 人: string[]; 每列: number[] };

async function 开(cfg: 配置) {
  const page = await browser.newPage(); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://pipe.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='paged'></div><div id='full'></div>" }));
  await page.goto("http://pipe.test/opportunities/pipeline");
  await page.evaluate((c) => Object.assign(window, { __cfg: c }), cfg);
  await page.addScriptTag({ content: bundle });
  await page.locator("#paged .pipe").waitFor(); await page.locator("#full .pipe").waitFor();
  return { page, errors };
}

/** 一边每列的列头（名字、条数、合计）、摆出来的卡（名字、金额、负责人、读屏文字）、底下那个按钮 */
const 读 = (page: Page, 边: "paged" | "full") => page.locator(`#${边} .pipe-col`).evaluateAll((cs) => cs.map((c) => ({
  名: c.querySelector(".pipe-h b")!.textContent,
  条数: Number(c.querySelector(".pipe-h .pipe-n")!.textContent),
  合计: c.querySelector(".pipe-h .pipe-sum")!.textContent,
  卡: [...c.querySelectorAll(".pipe-card")].map((x) => `${(x as HTMLElement).innerText} | ${x.getAttribute("aria-label")}`),
  按钮: (c.querySelector(".pipe-more") as HTMLElement | null)?.innerText.replace(/\s+/g, " ") ?? null,
})));

/** 一直点「再看」直到没有按钮，每点一下都等新的一版到了 */
async function 翻到底(page: Page) {
  for (let 次 = 0; ; 次++) {
    expect(次).toBeLessThan(20);
    const 按钮 = page.locator("#paged .pipe-more");
    if (!(await 按钮.count())) return 次;
    const 前 = await page.evaluate(() => (window as unknown as { __翻?: number }).__翻 ?? 0);
    const 前张 = await page.locator("#paged .pipe-card").count();
    await 按钮.first().click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __翻?: number }).__翻)).toBe(前 + 1);
    // 新的一版到了（多摆了卡），按钮不在转圈了才点下一下：转圈时点按钮不算数
    await expect.poll(() => page.locator("#paged .pipe-card").count()).toBeGreaterThan(前张);
    await expect.poll(() => page.locator("#paged .pipe-more.ant-btn-loading").count(), { timeout: 5000 }).toBe(0);
  }
}

// 五列：一列 120 张、一列正好 51、一列正好 50、一列 75、赢单 8
const 团队: 配置 = { 种子: 3, 人: ["u1", "u2", "u3"], 每列: [120, 51, 50, 75, 8] };

it("列头条数、按币种合计 = 全部；每列摆全取那列的前 50 张", async () => {
  const { page, errors } = await 开(团队);
  const [分, 全] = [await 读(page, "paged"), await 读(page, "full")];
  expect(分.map((c) => [c.名, c.条数, c.合计])).toEqual(全.map((c) => [c.名, c.条数, c.合计]));
  expect(全.map((c) => c.条数)).toEqual(团队.每列);
  // 合计里真有几种币种：不是只比了一个空串
  expect(全.some((c) => (c.合计 ?? "").includes("$"))).toBe(true);
  for (const [k, c] of 分.entries()) {
    expect(c.卡).toEqual(全[k].卡.slice(0, 50));
    const 剩 = c.条数 - 50;
    expect(c.按钮).toBe(剩 <= 0 ? null : 剩 > 50 ? `再看 50 条 还有 ${剩}` : `再看剩下 ${剩} 条`);
  }
  expect(全.every((c) => c.按钮 === null)).toBe(true);
  expect(errors).toEqual([]); await page.close();
});

it("「再看 50 条」一直点到底：整个看板和全取的一模一样", async () => {
  const { page, errors } = await 开(团队);
  expect(await 翻到底(page)).toBe(4);
  expect(await 读(page, "paged")).toEqual(await 读(page, "full"));
  expect(await page.locator("#paged .pipe").innerText()).toBe(await page.locator("#full .pipe").innerText());
  expect(await page.evaluate(() => location.search)).toBe("?n=150%2C100%2C50%2C100%2C50");
  expect(errors).toEqual([]); await page.close();
});

it("每列不到 50 张、只有自己（个人版）：和全取的一模一样，没有「再看」", async () => {
  const { page, errors } = await 开({ 种子: 9, 人: ["u1"], 每列: [30, 12, 49, 5, 0] });
  expect(await page.locator("#paged .pipe-more").count()).toBe(0);
  expect(await page.locator("#paged .pipe-card-o").count()).toBe(0);
  // 两棵树各自的 useId 不算
  const 去id = (h: string) => h.replace(/_r_\w+?_/g, "_r_");
  expect(去id(await page.locator("#paged").innerHTML())).toBe(去id(await page.locator("#full").innerHTML()));
  expect(errors).toEqual([]); await page.close();
});
