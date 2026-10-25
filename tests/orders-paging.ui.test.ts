/**
 * 订单一览企业版服务端分页（2026-10-25）在真浏览器里：分页的和原来整张发、浏览器里分页的看着一样。
 *   - 表头合计（共几单、各币种金额、未收、停在哪一步）一字不差
 *   - 第一页那 20 行、先后一样；分页条写「共 230 条」（全部，不是这一页的 20）
 *   - 点「订单确认时间」/「超期」表头：去服务端按这列排（网址带 sort），回到第一页
 *   - 800 宽不横向撑出页面
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser, bundle: string;
const plugin: Plugin = { name: "orders-paging-boundaries", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, (a) => ({ path: a.path, namespace: "nav" }));
  b.onLoad({ filter: /.*/, namespace: "nav" }, () => ({ contents: "export const useRouter=()=>({push(u){window.__pushes.push(u)},refresh(){}});" }));
  b.onResolve({ filter: /^next\/link$/ }, (a) => ({ path: a.path, namespace: "link" }));
  b.onLoad({ filter: /.*/, namespace: "link" }, () => ({ contents: "import React from 'react';export default ({href,children,...p})=>React.createElement('a',{href,...p},children);", resolveDir: process.cwd() }));
  b.onResolve({ filter: /^@\/lib\/features$/ }, (a) => ({ path: a.path, namespace: "features" }));
  b.onLoad({ filter: /.*/, namespace: "features" }, () => ({ contents: "export const 订单节点=window.__nodes;" }));
  b.onResolve({ filter: /EmptyState$/ }, (a) => ({ path: a.path, namespace: "empty" }));
  b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default ()=>null;" }));
} };

/** 230 单：确认时间只有几天、超期 0–2，币种三种，有走完的 */
const 名 = ["定金", "下单给工厂", "生产", "订舱"];
const rows = Array.from({ length: 230 }, (_, i) => {
  const 当前 = i % 7 === 0 ? null : { idx: 1 + (i % 4), name: 名[i % 4] };
  return {
    id: `r${i}`, no: `QA-${String(i).padStart(3, "0")}`, customerId: `c${i % 9}`, customerName: `客户${i % 9}`, customerCompany: null,
    ownerId: "u", ownerName: "QA", amount: 100 + (i * 37) % 900, currency: ["CNY", "USD", "EUR"][i % 3],
    incoterm: null, payment: i % 2 ? "T/T" : null, supplier: i % 3 ? `工厂${i % 5}` : null,
    confirmedAt: `2026-0${1 + (i % 5)}-0${1 + (i % 3)}T00:00:00.000Z`, createdAt: "2026-01-01T00:00:00.000Z",
    nodes: [], 当前, 超期: 当前 ? i % 3 : 0, 进度: 0, 未收: (i * 13) % 200,
  };
});

beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `
  import React from 'react';import{createRoot}from'react-dom/client';import{App,ConfigProvider}from'antd';import zhCN from'antd/locale/zh_CN';
  import View from'@/app/(app)/orders/OrdersView';import{切订单页}from'@/lib/orders-paging';
  const rows=window.__rows;
  const 这页=window.__paged?切订单页(rows,{节点:window.__nodes,sort:window.__sort}):null;
  createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App>{这页
    ?<View rows={这页.rows} users={[]} filters={{ownerId:''}} 分页={这页.分页}/>
    :<View rows={rows} users={[]} filters={{ownerId:''}}/>}</App></ConfigProvider>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });

async function open(o: { nodes: boolean; paged: boolean; sort?: string; width?: number }) {
  const page = await browser.newPage({ viewport: { width: o.width ?? 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://orders.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://orders.test");
  await page.evaluate((v) => Object.assign(window, { __nodes: v.nodes, __paged: v.paged, __sort: v.sort, __rows: v.rows, __pushes: [] }), { ...o, rows });
  await page.addScriptTag({ content: bundle });
  await page.locator(".list-sum").waitFor();
  return { page, errors };
}
const 看 = async (page: Page) => ({
  合计: await page.locator(".list-sum").innerText(),
  停: (await page.locator(".ord-stuck").count()) ? await page.locator(".ord-stuck").innerText() : "",
  行: await page.locator("tbody tr[data-row-key]").evaluateAll((trs) => trs.map((t) => t.getAttribute("data-row-key"))),
  共: await page.locator(".ant-pagination-total-text").innerText(),
});

for (const nodes of [false, true]) {
  it(`${nodes ? "节点版" : "轻量版"}：分页的合计、第一页、「共 230 条」和原来浏览器里分页的一样`, async () => {
    const 原来 = await open({ nodes, paged: false });
    const 分页 = await open({ nodes, paged: true });
    try {
      const a = await 看(原来.page), b = await 看(分页.page);
      expect(a.合计).toContain("共 230 单");
      expect(a.行).toHaveLength(20);
      if (nodes) expect(a.停).toContain("已走完");
      expect(b).toEqual(a);
      expect(b.共).toBe("共 230 条");
      expect([...原来.errors, ...分页.errors]).toEqual([]);
    } finally { await 原来.page.close(); await 分页.page.close(); }
  });

  it(`${nodes ? "节点版" : "轻量版"}：点能排的表头 → 去服务端按这列排、回第一页；已经排着的表头显示排着`, async () => {
    const 列 = nodes ? "超期" : "订单确认时间", k = nodes ? "late" : "confirmed";
    const { page, errors } = await open({ nodes, paged: true });
    try {
      await page.getByRole("columnheader", { name: 列, exact: true }).click();
      expect(await page.evaluate(() => (window as unknown as { __pushes: string[] }).__pushes)).toEqual([`/orders?pageSize=20&sort=${k}-asc`]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
    const 排着 = await open({ nodes, paged: true, sort: `${k}-desc` });
    try {
      await expect.poll(() => 排着.page.getByRole("columnheader", { name: 列, exact: true }).getAttribute("aria-sort")).toBe("descending");
      // 和原来浏览器里点两下（降序）看到的第一页一样
      const 原来 = await open({ nodes, paged: false });
      try {
        await 原来.page.getByRole("columnheader", { name: 列, exact: true }).click();
        await 原来.page.getByRole("columnheader", { name: 列, exact: true }).click();
        expect((await 看(排着.page)).行).toEqual((await 看(原来.page)).行);
      } finally { await 原来.page.close(); }
    } finally { await 排着.page.close(); }
  });
}

it("800 宽：分页的两种一览都不横向撑出页面", async () => {
  for (const nodes of [false, true]) {
    const { page, errors } = await open({ nodes, paged: true, width: 800 });
    try {
      await page.locator(".ant-pagination").waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }
});
