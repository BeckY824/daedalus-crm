import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser, bundle: string;
const plugin: Plugin = { name: "opportunity-link-boundaries", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "fixture", pluginData: code }));
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){window.__refresh++},push(p){window.__route=p}});");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/(^|\/)(ContractForm|CompareDrawer)$/, "export default function Empty(){return null}");
  stub(/^\.\.\/customers\/actions$/, "export const saveContract=async()=>({ok:false});");
  stub(/^@\/app\/\(app\)\/demo-data$/, "export const 查演示数据状态=async()=>({可灌:false,可清:false}),灌一套演示数据=async()=>({ok:true}),清除演示数据=灌一套演示数据;");
  stub(/^\.\/actions$/, `export const saveOpportunity=async x=>{window.__saved=x;return {ok:true}};export const 读报价=async()=>[],上次报价=async()=>null;export const deleteOpportunities=async()=>({ok:false}),restoreOpportunities=deleteOpportunities,删商机前清点=async()=>({跟进:0,赢单:0}),moveStage=deleteOpportunities,setOppStatus=deleteOpportunities;`);
  b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };
beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import View from '@/app/(app)/opportunities/OpportunitiesView';import {BusinessProvider} from '@/lib/business-client';import {DEFAULT_BUSINESS} from '@/lib/business-config';
    window.__refresh=0;const focused={id:'closed-target',name:'同名商机',amount:123,currency:'CNY',stage:'赢单成交',status:'WON',probability:100,expectedDealAt:null,createdAt:'2020-01-01T00:00:00.000Z',remark:'选中的是旧单',customerId:'c1',customerName:'QA客户',ownerId:'u1',ownerName:'QA',updatedAt:'2026-01-01T00:00:00.000Z'};
    createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={DEFAULT_BUSINESS}><View focusedOpportunity={window.__missing?null:focused} focusMissing={window.__missing} 总数={1} rows={[{...focused,id:'different-same-name',status:'OPEN'}]} 汇总={{单数:1,合计:[],预测:[]}} users={[{id:'u1',name:'QA',email:'qa'}]} customers={[{id:'c1',name:'QA客户'}]} filters={{keyword:'同名商机',stage:'',status:'OPEN',ownerId:''}}/></BusinessProvider></App></ConfigProvider>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
it.each(["cancel", "save"])("%s唯一ID打开的已赢同名旧商机，关闭消费地址参数且不误重新打开", async mode => {
  const page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    await page.route("http://opp-link.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
    await page.goto("http://opp-link.test/opportunities?opportunity=closed-target&keyword=同名商机&status=OPEN"); await page.addScriptTag({ content: bundle });
    const dialog = page.getByRole("dialog"); await dialog.waitFor();
    expect(await dialog.locator("#name").inputValue()).toBe("同名商机"); expect(await dialog.locator("#remark").inputValue()).toBe("选中的是旧单");
    await dialog.getByRole("button", { name: mode === "cancel" ? /取\s*消/ : /保\s*存/ }).click();
    await expect.poll(() => dialog.count()).toBe(0);
    const url = new URL(page.url()); expect(url.searchParams.has("opportunity")).toBe(false); expect(url.searchParams.get("status")).toBe("OPEN");
    if (mode === "save") {
      expect(await page.evaluate(() => Reflect.get(window, "__saved"))).toMatchObject({ id: "closed-target", status: "WON", 版本: "2026-01-01T00:00:00.000Z" });
      expect(await page.evaluate(() => Reflect.get(window, "__refresh"))).toBe(1);
    } else expect(await page.evaluate(() => Reflect.get(window, "__saved"))).toBeUndefined();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});
it("关联商机不存在或不可见显示明确提示，不能自动开成新建", async () => {
  const page = await browser.newPage();
  try {
    await page.route("http://opp-link.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
    await page.goto("http://opp-link.test/opportunities?opportunity=missing"); await page.evaluate(() => Reflect.set(window, "__missing", true)); await page.addScriptTag({ content: bundle });
    await page.getByText("关联商机已删除或当前账号无权查看，请返回原客户核对", { exact: true }).waitFor(); expect(await page.getByRole("dialog").count()).toBe(0);
  } finally { await page.close(); }
});
