/**
 * 商机看板分批（2026-10-24 企业版压测）在真浏览器里和「全取回来画」对拍：
 * 同一份数据，左边照分批的做法（lib/pipeline-page.ts 取管道 + 「再看 50 条」换 n= 重取），
 * 右边把全部卡片一次给 PipelineView、不带列头（原来的做法：列头在卡片上算）。库换成内存里的假库，取数代码本身照跑。
 *
 *   - 每列列头的条数、按币种合计和全取的一样；每列摆的是全取那列的前 50 张
 *   - 「再看 50 条」/「再看剩下 N 条」一直点到底：整个看板和全取的一模一样
 *   - 每列不到 50 张、只有自己（个人版）：两边一模一样，没有「再看」
 *   - 摆出来的卡都是一个人的、后头还有别人的：照样写负责人（看全部，不看已摆的）
 *   - 把一张卡挪进超过 50 张的列、金额又排不进那列前 50：挪完还在看板上，撤销后回原列
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { OPP_STAGES } from "@/lib/constants";

let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "pipeline-pager-ui", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "stub", pluginData: code }));
  // 「再看」换 URL：交给测试里的假服务端重取（和 Next 一样，新的一版整份到了才换）
  // refresh 也照当前 URL 重取：挪卡片以后只 refresh 的话，排不进前 50 的那张会从看板上消失，测试要能看出来
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){window.__replace(location.pathname+location.search)},push(){},replace(u){window.__replace(u)}});export const usePathname=()=>'/opportunities/pipeline';");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/(^|\/)demo-data$/, "export const 查演示数据状态=async()=>null,灌一套演示数据=async()=>({ok:false}),清除演示数据=灌一套演示数据;");
  stub(/(^|\/)(OpportunityForm|ContractForm)$/, "export default function F(){return null}");
  stub(/(^|\/)actions$/, "export const moveStage=async(id,到)=>(window.__挪(id,到),{ok:true});");
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
    // 外人：不在成员名单里的负责人（比如走了的人），金额 0、id 排最后，前 50 张里没有他的
    for (let k = 0; k < (cfg.外人 ?? 0); k++) 行.push({ id: 'zz' + k, name: '外人商机' + k, amount: 0, stage: OPP_STAGES[0], status: 'OPEN', probability: 10, expectedDealAt: null, customer: { id: 'c0', name: '客户0' }, owner: { name: '成员u9' }, ownerId: 'u9', money: null });
    // 假库：只认 取管道 用到的那几样（金额从大到小、同金额按 id、id in）
    const 排 = (xs) => [...xs].sort((a, c) => c.amount - a.amount || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
    window.__行 = 行;
    window.__挪 = (id, 到) => { const x = 行.find((o) => o.id === id); x.stage = 到; x.status = 到 === '赢单成交' ? 'WON' : 'OPEN'; };
    const db = { opportunity: { findMany: async ({ where }) => { const 要 = where.AND?.[1]?.id?.in && new Set(where.AND[1].id.in); return 排(行.filter((x) => !要 || 要.has(x.id))); } } };
    const 起 = new Date('2026-09-21T00:00:00Z');
    function 分批() {
      const [页, set页] = useState(null);
      const 取 = (n, 新) => 取管道(db, 起, n, 新).then((p) => set页({ ...p, n }));
      useEffect(() => {
        window.__replace = (u) => { const sp = new URL(u, location.href).searchParams; history.replaceState(null, '', u); window.__翻 = (window.__翻 ?? 0) + 1; return 取(读每列(sp.get('n')), sp.get('new')); };
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

type 配置 = { 种子: number; 人: string[]; 每列: number[]; 外人?: number };

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

it("卡片挪进超过 50 张的列、金额排不进那列前 50：挪完还在看板上，撤销后回原列", async () => {
  const { page, errors } = await 开(团队);
  // 别的列摆出来的里头，挑一张挪进第四列（75 张）后排不进前 50 的（金额小的列优先）
  const 选 = await page.evaluate((阶段) => {
    type 行 = { id: string; name: string; amount: number; stage: string };
    const 全 = (window as unknown as { __行: 行[] }).__行;
    const 排 = (xs: 行[]) => [...xs].sort((a, c) => c.amount - a.amount || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
    const 底 = 排(全.filter((x) => x.stage === 阶段[3]))[49];
    for (const k of [4, 2, 1, 0]) {
      const 卡 = 排(全.filter((x) => x.stage === 阶段[k])).slice(0, 50).find((x) => x.amount < 底.amount || (x.amount === 底.amount && x.id > 底.id));
      if (卡) return { 名: 卡.name, 从: k, 原条数: 全.filter((x) => x.stage === 阶段[k]).length };
    }
  }, [...OPP_STAGES]);
  expect(选).toBeTruthy();
  const { 名, 从, 原条数 } = 选!;
  const 列 = (k: number) => page.locator("#paged .pipe-col").nth(k);
  const 卡 = (k: number) => 列(k).locator(`.pipe-card[aria-label^="${名}，"]`);
  const 条数 = async (k: number) => Number(await 列(k).locator(".pipe-h .pipe-n").textContent());

  // 和 e2e/remediation-members-undo 一样：菜单可交互了再点（卡片在列里滚进来时菜单会先关一下）
  const 项 = page.getByRole("menuitem", { name: `推进到 ${OPP_STAGES[3]}`, exact: true });
  await 卡(从).scrollIntoViewIfNeeded();
  await expect.poll(async () => {
    if (!(await 项.isVisible())) await 卡(从).click({ button: "right" });
    await page.waitForTimeout(300);
    return 项.isVisible();
  }, { timeout: 8_000 }).toBe(true);
  await 项.click();
  await expect.poll(() => 卡(3).count()).toBe(1);
  expect(await 卡(从).count()).toBe(0);
  expect([await 条数(从), await 条数(3)]).toEqual([原条数 - 1, 76]);
  // 第四列：前 50 张 + 刚挪进来的这张；原来那列超过 50 张的补上第 51 张
  expect(await 列(3).locator(".pipe-card").count()).toBe(51);
  expect(await 列(从).locator(".pipe-card").count()).toBe(Math.min(原条数 - 1, 50));

  await page.locator(".ant-message").getByRole("button", { name: "撤销" }).click();
  await expect.poll(() => 卡(从).count()).toBe(1);
  expect(await 卡(3).count()).toBe(0);
  expect([await 条数(从), await 条数(3)]).toEqual([原条数, 75]);
  expect(await 列(3).locator(".pipe-card").count()).toBe(50);
  expect(await 列(从).locator(".pipe-card").count()).toBe(Math.min(原条数, 50));
  expect(errors).toEqual([]); await page.close();
});

it("连挪两张进不同的大列、都排不进前 50：先挪的那张也还在（new= 记着几张，不是只记最后一张）", async () => {
  const { page, errors } = await 开(团队);
  // 挑一张挪进 到 列后排不进前 50 的，不从 不要 那几列里挑
  const 挑 = (到: number, 不要: number[], 除了?: string) => page.evaluate(({ 阶段, 到, 不要, 除了 }) => {
    type 行 = { id: string; name: string; amount: number; stage: string };
    const 全 = (window as unknown as { __行: 行[] }).__行;
    const 排 = (xs: 行[]) => [...xs].sort((a, c) => c.amount - a.amount || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
    const 底 = 排(全.filter((x) => x.stage === 阶段[到]))[49];
    for (const k of [4, 2, 1, 0, 3]) {
      if (k === 到 || 不要.includes(k)) continue;
      const 卡 = 排(全.filter((x) => x.stage === 阶段[k])).slice(0, 50).find((x) => x.name !== 除了 && (x.amount < 底.amount || (x.amount === 底.amount && x.id > 底.id)));
      if (卡) return { 名: 卡.name, 从: k };
    }
  }, { 阶段: [...OPP_STAGES], 到, 不要, 除了 });
  const 列 = (k: number) => page.locator("#paged .pipe-col").nth(k);
  const 卡 = (k: number, 名: string) => 列(k).locator(`.pipe-card[aria-label^="${名}，"]`);
  const 挪 = async (名: string, 从: number, 到: number) => {
    const 项 = page.getByRole("menuitem", { name: `推进到 ${OPP_STAGES[到]}`, exact: true });
    await 卡(从, 名).scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      if (!(await 项.isVisible())) await 卡(从, 名).click({ button: "right" });
      await page.waitForTimeout(300);
      return 项.isVisible();
    }, { timeout: 8_000 }).toBe(true);
    await 项.click();
    await expect.poll(() => 卡(到, 名).count()).toBe(1);
  };

  const A = await 挑(3, [0]);
  expect(A).toBeTruthy();
  await 挪(A!.名, A!.从, 3);
  const B = await 挑(0, [3], A!.名);
  expect(B).toBeTruthy();
  await 挪(B!.名, B!.从, 0);
  // 第二次重取完：A 还在第四列、B 在第一列；两列都是前 50 张 + 挪进来的那张
  await expect.poll(() => 列(0).locator(".pipe-card").count()).toBe(51);
  expect(await 卡(3, A!.名).count()).toBe(1);
  expect(await 列(3).locator(".pipe-card").count()).toBe(51);
  expect(new URL(page.url()).searchParams.get("new")!.split(",")).toHaveLength(2);
  expect(errors).toEqual([]); await page.close();
});

it("摆出来的卡都是我的、后头没摆的有别人的：卡上照样写负责人，和全取的一样", async () => {
  const { page, errors } = await 开({ 种子: 4, 人: ["u1"], 每列: [60, 3, 3, 3, 3], 外人: 2 });
  const 卡数 = await page.locator("#paged .pipe-card").count();
  expect(卡数).toBe(50 + 12);
  expect(await page.locator("#paged .pipe-card", { hasText: "外人商机" }).count()).toBe(0);
  expect(await page.locator("#paged .pipe-card-o").count()).toBe(卡数);
  expect(await page.locator("#full .pipe-card-o").count()).toBe(60 + 2 + 12);
  expect(errors).toEqual([]); await page.close();
});
