/**
 * 跟进计划页分批（2026-10-24 企业版压测）在真浏览器里和「全取回来画」对拍：
 * 同一份数据，左边照分批的做法（lib/plans-page.ts 取计划页 + 「再看 50 条」换 n= 重取），
 * 右边把全部详情一次给 PlansView（原来的做法）。库换成内存里的假库，取数代码本身照跑。
 *
 *   - 组头条数一样、每组摆出来的是右边那组的前 50 条（「我的」「全部成员」都看）
 *   - 「再看 50 条」/「再看剩下 N 条」一直点到底：整页和右边一模一样，没去补过详情
 *   - 要摆的那条手里没详情：先占一行「正在取…」，补到了换成和右边一样的那一行
 *   - 每组不到 50 条（个人版）：两边一模一样，没有「再看」
 *   - 摆出来的都是我的、后头没摆的有别人的：照样有「我的 / 全部成员」（看全部，不看已摆的）
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "plans-pager-ui", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "stub", pluginData: code }));
  // 「再看」换 URL：交给测试里的假服务端重取（和 Next 一样，新的一版整份到了才换）
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){},push(){},replace(u){window.__replace(u)}});export const usePathname=()=>'/follow-ups/plans';");
  stub(/^@\/app\/\(app\)\/demo-data$/, "export const 查演示数据状态=async()=>({可灌:false,可清:false}),灌一套演示数据=async()=>({ok:true}),清除演示数据=灌一套演示数据;");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/(customers\/\[id\]\/|^\.\/)actions$/, "export const toggleTask=async()=>({ok:true}),completePlan=toggleTask,deletePlan=toggleTask,deleteTask=toggleTask,saveFollowUp=toggleTask,撤销记一笔=toggleTask;");
  stub(/customers\/\[id\]\/(PlanForm|TaskForm)$/, "export default function C(){return null}");
  b.onLoad({ filter: /.*/, namespace: "stub" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };

beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React, {useEffect, useState} from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import {BusinessProvider} from '@/lib/business-client';import {DEFAULT_BUSINESS} from '@/lib/business-config';
    import {dayjs} from '@/lib/utils';
    import {取计划页, 取详情} from '@/lib/plans-page';import {读每组} from '@/lib/plans-groups';
    import PlansView from '@/app/(app)/follow-ups/plans/PlansView';
    const cfg = window.__cfg;
    let s = cfg.种子 >>> 0;
    const r = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const 人 = cfg.人.map((id) => ({ id, name: '成员' + id }));
    const 客户 = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, name: '客户' + i, extra: i % 3 ? null : { whatsapp: '+86138' } }));
    const now = dayjs();
    const 同刻 = { 逾期: now.subtract(2, 'day'), 今天: now.startOf('day').add(30, 'minute'), 本周: now.endOf('week').subtract(3, 'hour'), 以后: now.add(20, 'day') };
    function 时间(g) {
      if (r() < 0.25) return 同刻[g];
      if (g === '逾期') return now.subtract(1 + Math.floor(r() * 30), 'day');
      if (g === '今天') return now.startOf('day').add(Math.floor(r() * 1380), 'minute');
      if (g === '本周') return now.endOf('day').add(1 + Math.floor(r() * (now.endOf('week').diff(now.endOf('day'), 'hour') - 1)), 'hour');
      return now.add(8 + Math.floor(r() * 50), 'day');
    }
    const 计划 = [], 待办 = [];
    let i = 0;
    for (const [g, [几计划, 几待办]] of Object.entries(cfg.每组)) {
      for (let j = 0; j < 几计划; j++) {
        const d = 时间(g), 只日期 = r() < 0.2, c = 客户[Math.floor(r() * 客户.length)], o = 人[Math.floor(r() * 人.length)];
        计划.push({ id: 'p' + (i++ * 7919 % 100003), subject: '计划' + i, plannedAt: (只日期 ? d.startOf('day') : d).toDate(), plannedOn: 只日期 ? d.format('YYYY-MM-DD') : null, plannedHasTime: 只日期 ? false : true, method: ['电话沟通', 'WhatsApp', '上门拜访'][j % 3], updatedAt: new Date('2026-10-01T00:00:00Z'), customer: c, owner: o, ownerId: o.id });
      }
      for (let j = 0; j < 几待办; j++) {
        const 没时间 = g === '以后' && r() < 0.4, d = 时间(g), c = 客户[Math.floor(r() * 客户.length)], o = 人[Math.floor(r() * 人.length)];
        待办.push({ id: 't' + (i++ * 7919 % 100003), title: '待办' + i, dueAt: 没时间 ? null : d.toDate(), dueOn: null, dueHasTime: 没时间 ? null : true, updatedAt: new Date('2026-10-01T00:00:00Z'), customer: c, owner: o, ownerId: o.id });
      }
    }
    // 外人：不在名单里的负责人，计划排在「以后」最末（300 天后），前 50 条里没有他的
    for (let k = 0; k < (cfg.外人 ?? 0); k++) 计划.push({ id: 'zz' + k, subject: '外人计划' + k, plannedAt: now.add(300 + k, 'day').toDate(), plannedOn: null, plannedHasTime: true, method: '电话沟通', updatedAt: new Date('2026-10-01T00:00:00Z'), customer: 客户[0], owner: { id: 'u9', name: '成员u9' }, ownerId: 'u9' });
    // 假库：只认 取计划页 / 取详情 用到的那几样（done:false、id in、按时间排、同一刻按 id）
    const 排 = (行, 键) => [...行].sort((a, c) => { const x = a[键] ? a[键].getTime() : Infinity, y = c[键] ? c[键].getTime() : Infinity; return x - y || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0); });
    const 表 = (行, 键) => ({ findMany: async ({ where }) => { const 要 = where.id?.in && new Set(where.id.in); return 排(行.filter((x) => !要 || 要.has(x.id)), 键); } });
    const db = { followPlan: 表(计划, 'plannedAt'), task: 表(待办, 'dueAt') };
    window.__补 = [];
    let 放行; window.__放行 = new Promise((ok) => { 放行 = ok; }); window.__开闸 = () => 放行();
    // 补失败：前几次补详情直接失败（断网、服务端出错）
    let 还要失败 = cfg.补失败 ?? 0;
    async function 补详情(keys) {
      window.__补.push(keys);
      if (还要失败 > 0) { 还要失败--; throw new Error('补详情失败'); }
      if (cfg.缺一条 && !cfg.补失败) await window.__放行;
      return 取详情(db, keys);
    }
    function 分批() {
      const [页, set页] = useState(null);
      const 取 = (n) => 取计划页(db, n, cfg.我).then((p) => {
        // 缺一条：服务端漏给了「今天」组第一条的详情（浏览器和服务器时区不同时会这样），页面得自己补
        if (cfg.缺一条 && p.轻) { const k = window.__缺 = p.plans.find((x) => dayjs(x.plannedAt).isSame(now, 'day') && x.ownerId === cfg.我)?.id; p = { ...p, plans: p.plans.filter((x) => x.id !== k) }; }
        set页({ ...p, n });
      });
      useEffect(() => {
        window.__replace = (u) => { const n = 读每组(new URL(u, location.href).searchParams.get('n')); history.replaceState(null, '', u); window.__翻 = (window.__翻 ?? 0) + 1; return 取(n); };
        取(读每组(null));
      }, []);
      if (!页) return null;
      return <PlansView plans={页.plans} tasks={页.tasks} done={[]} meId={cfg.我} 预选客户={null} 直接新建={false} {...(页.轻 ? { 轻: 页.轻, 负责人: 页.负责人, 每组: 页.n, 补详情 } : {})} />;
    }
    function 全取() {
      const [页, set页] = useState(null);
      useEffect(() => { 取详情(db, '全部', true).then(set页); }, []);
      return 页 && <PlansView plans={页.plans} tasks={页.tasks} done={[]} meId={cfg.我} 预选客户={null} 直接新建={false} />;
    }
    const 包 = (x) => <ConfigProvider locale={zhCN}><App><BusinessProvider value={DEFAULT_BUSINESS} timeZone={null}>{x}</BusinessProvider></App></ConfigProvider>;
    createRoot(document.getElementById('paged')).render(包(<分批 />));
    createRoot(document.getElementById('full')).render(包(<全取 />));
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

type 配置 = { 种子: number; 我: string; 人: string[]; 每组: Record<string, [number, number]>; 缺一条?: boolean; 补失败?: number; 外人?: number };

async function 开(cfg: 配置) {
  const page = await browser.newPage({ timezoneId: "Asia/Shanghai" }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://plans.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='paged'></div><div id='full'></div>" }));
  await page.goto("http://plans.test/follow-ups/plans");
  // 周三上午：四组都有
  await page.clock.setFixedTime(new Date("2026-10-21T02:00:00Z"));
  await page.evaluate((c) => Object.assign(window, { __cfg: c }), cfg);
  await page.addScriptTag({ content: bundle });
  await page.locator("#paged .plans").waitFor(); await page.locator("#full .plans").waitFor();
  return { page, errors };
}

/** 一边每组的组头条数、摆出来的行（整行文字）、底下那个按钮 */
const 读 = (page: Page, 边: "paged" | "full") => page.locator(`#${边} .plan-g`).evaluateAll((gs) => gs.map((g) => ({
  名: g.querySelector(".plan-g-h b")!.textContent,
  共: Number(g.querySelector(".plan-g-n")!.textContent),
  行: [...g.querySelectorAll(".plan-row")].map((x) => (x as HTMLElement).innerText),
  按钮: (g.querySelector(".pipe-more") as HTMLElement | null)?.innerText.replace(/\s+/g, " ") ?? null,
})));

async function 看(page: Page, 范围: "我的" | "全部成员") {
  for (const 边 of ["paged", "full"]) await page.locator(`#${边} .ant-segmented-item`, { hasText: new RegExp(`^${范围}$`) }).click();
}

/** 一直点「再看」直到没有按钮，每点一下都等新的一版到了 */
async function 翻到底(page: Page) {
  for (let 次 = 0; ; 次++) {
    expect(次).toBeLessThan(20);
    const 按钮 = page.locator("#paged .pipe-more");
    if (!(await 按钮.count())) return 次;
    const 前 = await page.evaluate(() => (window as unknown as { __翻?: number }).__翻 ?? 0);
    const 前行 = await page.locator("#paged .plan-row").count();
    await 按钮.first().click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __翻?: number }).__翻)).toBe(前 + 1);
    // 新的一版到了（多摆了行），按钮不在转圈了才点下一下：转圈时点按钮不算数
    await expect.poll(() => page.locator("#paged .plan-row").count()).toBeGreaterThan(前行);
    await expect.poll(() => page.locator("#paged .pipe-more.ant-btn-loading").count(), { timeout: 5000 }).toBe(0);
  }
}

const 团队: 配置 = { 种子: 11, 我: "u1", 人: ["u1", "u2", "u3"], 每组: { 逾期: [90, 40], 今天: [30, 25], 本周: [60, 21], 以后: [70, 60] } };

it("组头条数 = 全部，每组摆前 50 条，和全取的那份一致（我的、全部成员）", async () => {
  const { page, errors } = await 开(团队);
  for (const 范围 of ["我的", "全部成员"] as const) {
    await 看(page, 范围);
    const [分, 全] = [await 读(page, "paged"), await 读(page, "full")];
    expect(分.map((g) => [g.名, g.共])).toEqual(全.map((g) => [g.名, g.共]));
    let 有分批 = false;
    for (const [k, g] of 分.entries()) {
      expect(g.行).toEqual(全[k].行.slice(0, 50));
      const 剩 = g.共 - 50;
      expect(g.按钮).toBe(剩 <= 0 ? null : 剩 > 50 ? `再看 50 条 还有 ${剩}` : `再看剩下 ${剩} 条`);
      if (剩 > 0) 有分批 = true;
    }
    expect(有分批).toBe(true);
    expect(全.every((g) => g.按钮 === null)).toBe(true);
  }
  expect(await page.locator("#paged .plan-row-wait").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __补: unknown[] }).__补)).toEqual([]);
  expect(errors).toEqual([]); await page.close();
});

it("「再看 50 条」一直点到底：整页和全取的一模一样，中途不用补详情", async () => {
  const { page, errors } = await 开(团队);
  await 看(page, "全部成员");
  expect(await 翻到底(page)).toBeGreaterThan(2);
  for (const 范围 of ["全部成员", "我的"] as const) {
    await 看(page, 范围);
    expect(await 读(page, "paged")).toEqual(await 读(page, "full"));
    expect(await page.locator("#paged .plans").innerText()).toBe(await page.locator("#full .plans").innerText());
  }
  // 翻到底了服务端就不带轻列表了；URL 里记着每组几条，刷新还在原处
  expect(await page.evaluate(() => location.search)).toMatch(/^\?n=\d+%2C\d+%2C\d+%2C\d+$/);
  expect(await page.evaluate(() => (window as unknown as { __补: unknown[] }).__补)).toEqual([]);
  expect(errors).toEqual([]); await page.close();
});

it("要摆的那条手里没详情：先占「正在取…」，补到了和全取的一样", async () => {
  const { page, errors } = await 开({ ...团队, 种子: 23, 缺一条: true });
  await 看(page, "我的");
  const 占位 = page.locator("#paged .plan-row-wait");
  await expect.poll(() => 占位.count()).toBe(1);
  expect(await 占位.getAttribute("aria-busy")).toBe("true");
  expect(await 占位.innerText()).toContain("正在取…");
  const 缺 = await page.evaluate(() => (window as unknown as { __缺: string }).__缺);
  expect(await page.evaluate(() => (window as unknown as { __补: string[][] }).__补)).toEqual([[`plan:${缺}`]]);
  await page.evaluate(() => (window as unknown as { __开闸: () => void }).__开闸());
  await expect.poll(() => 占位.count()).toBe(0);
  const [分, 全] = [await 读(page, "paged"), await 读(page, "full")];
  for (const [k, g] of 分.entries()) expect(g.行).toEqual(全[k].行.slice(0, 50));
  expect(errors).toEqual([]); await page.close();
});

it("补详情失败：占位不再一直转「正在取」，写「没取到」给重试；重试补到了和全取的一样", async () => {
  const { page, errors } = await 开({ ...团队, 种子: 23, 缺一条: true, 补失败: 1 });
  await 看(page, "我的");
  const 占位 = page.locator("#paged .plan-row-wait");
  await expect.poll(() => 占位.innerText()).toContain("没取到");
  expect(await 占位.getAttribute("aria-busy")).toBe("false");
  expect(await page.evaluate(() => (window as unknown as { __补: string[][] }).__补)).toHaveLength(1);
  await 占位.getByRole("button", { name: "重试" }).click();
  await expect.poll(() => 占位.count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __补: string[][] }).__补)).toHaveLength(2);
  const [分, 全] = [await 读(page, "paged"), await 读(page, "full")];
  for (const [k, g] of 分.entries()) expect(g.行).toEqual(全[k].行.slice(0, 50));
  expect(errors).toEqual([]); await page.close();
});

it("每组不到 50 条、只有自己（个人版）：和全取的一模一样，没有「再看」", async () => {
  const { page, errors } = await 开({ 种子: 5, 我: "u1", 人: ["u1"], 每组: { 逾期: [20, 10], 今天: [12, 8], 本周: [30, 15], 以后: [25, 20] } });
  expect(await page.locator("#paged .pipe-more").count()).toBe(0);
  expect(await page.locator("#paged .ant-segmented-item", { hasText: /^全部成员$/ }).count()).toBe(0);
  // 两棵树各自的 useId（_r_2_ / _r_8r_）不算
  const 去id = (h: string) => h.replace(/_r_\w+?_/g, "_r_");
  expect(去id(await page.locator("#paged").innerHTML())).toBe(去id(await page.locator("#full").innerHTML()));
  expect(await page.evaluate(() => (window as unknown as { __补: unknown[] }).__补)).toEqual([]);
  expect(errors).toEqual([]); await page.close();
});

it("摆出来的都是我的、后头没摆的有别人的：照样有「我的 / 全部成员」，翻到底和全取的一样", async () => {
  const { page, errors } = await 开({ 种子: 6, 我: "u1", 人: ["u1"], 每组: { 逾期: [10, 0], 今天: [5, 0], 本周: [5, 0], 以后: [60, 0] }, 外人: 3 });
  expect(await page.locator("#paged .plan-row", { hasText: "外人计划" }).count()).toBe(0);
  expect(await page.locator("#paged .ant-segmented-item", { hasText: /^全部成员$/ }).count()).toBe(1);
  await 看(page, "全部成员");
  expect((await 读(page, "paged")).find((g) => g.名 === "以后")?.共).toBe(63);
  await 翻到底(page);
  expect(await 读(page, "paged")).toEqual(await 读(page, "full"));
  expect(await page.locator("#paged .plan-row", { hasText: "外人计划" }).count()).toBe(3);
  expect(errors).toEqual([]); await page.close();
});
