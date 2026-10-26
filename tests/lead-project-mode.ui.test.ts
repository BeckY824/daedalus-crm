/**
 * 企业版项目模式下的线索页（10-25 企业版实测 F1、F6）。
 *
 *   F1 项目模式开着点「新建线索」跳建档向导，市场、渠道建不了单条线索。企业版改成照常弹线索表单；
 *      不是企业版照旧跳 /projects/new
 *   F6 线索只能转客户。企业版行上按钮叫「转项目」，转好去项目页
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "leads-ui", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "stub", pluginData: code }));
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/^next\/navigation$/, "export const useRouter=()=>({push(u){window.__去.push(u)},refresh(){},replace(){}});");
  stub(/components\/DataList$/, "export default function D(p){const 动=p.列.find(c=>c.key==='act');return <div data-testid='rows'>{p.行.map(r=><div key={r.id}>{动.render(null,r)}</div>)}</div>}");
  stub(/^\.\/actions$/, "export const saveLead=async()=>({ok:true});export const deleteLeads=async()=>({ok:true});export const mergeLeadInto=async()=>({ok:true});export const convertLead=async()=>window.__转;");
  stub(/^\.\/assign-actions$/, "export const 自动分配线索=async()=>({});export const 批量自动分配=async()=>({});export const 分配线索=async()=>({});export const 本月分配情况=async()=>[];export const 我分出去的线索=async()=>[];export const 关满额提醒=async()=>({ok:true});");
  b.onLoad({ filter: /.*/, namespace: "stub" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };
beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';
    import Leads from '@/app/(app)/leads/LeadsView';
    import {BusinessProvider} from '@/lib/business-client';
    import {DEFAULT_BUSINESS} from '@/lib/business-config';
    window.__去=[];
    const row={id:'l1',name:'甲线索',contact:null,phone:null,email:null,industry:null,source:'其他',status:'待跟进',remark:null,ownerId:'me',ownerName:'我',customerId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    window.__画=(企业版项目)=>createRoot(document.getElementById('root')).render(<App><BusinessProvider value={{...DEFAULT_BUSINESS,projectMode:true}}>
      <Leads rows={[row]} 总数={1} users={[{id:'me',name:'我',email:'me'}]} filters={{keyword:'',status:'',ownerId:'',source:''}} 来源们={['其他']} me="me" 企业版项目={企业版项目}/>
    </BusinessProvider></App>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function 打开(企业版项目: boolean) {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("http://leads.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://leads.test"); await page.addScriptTag({ content: bundle });
  await page.evaluate((v) => (window as unknown as { __画: (v: boolean) => void }).__画(v), 企业版项目);
  await expect.poll(() => page.locator("#root").innerText()).not.toBe("");
  const 去了 = () => page.evaluate(() => (window as unknown as { __去: string[] }).__去);
  return { page, errors, 去了 };
}

it("企业版项目模式：点「新建线索」弹线索表单，不跳建档向导（F1）", async () => {
  const { page, errors, 去了 } = await 打开(true);
  await page.getByRole("button", { name: /新建线索/ }).click();
  await expect.poll(() => page.locator(".ant-modal-title").filter({ hasText: "新建线索" }).count()).toBe(1);
  expect(await 去了()).toEqual([]);
  expect(errors).toEqual([]); await page.close();
});

it("不是企业版的项目模式照旧：点「新建线索」去 /projects/new（F1 开关关和 main 一样）", async () => {
  const { page, errors, 去了 } = await 打开(false);
  await page.getByRole("button", { name: /新建线索/ }).click();
  await expect.poll(去了).toEqual(["/projects/new"]);
  expect(await page.locator(".ant-modal-title").filter({ hasText: "新建线索" }).count()).toBe(0);
  expect(errors).toEqual([]); await page.close();
});

it("企业版项目模式：行上是「转项目」，转好去项目页（F6）", async () => {
  const { page, errors, 去了 } = await 打开(true);
  await page.evaluate(() => { (window as unknown as { __转: unknown }).__转 = { ok: true, customerId: "c1", projectId: "p1" }; });
  await page.getByTestId("rows").getByRole("button", { name: /转项目/ }).click();
  // 10-26 #13：转项目先记首条跟进，内容没填按钮是灰的
  await expect.poll(() => page.locator(".ant-modal-title").innerText()).toBe("将「甲线索」转为项目");
  const 转 = page.getByTestId("lead-convert-follow").getByRole("button", { name: "转为项目" });
  expect(await 转.isDisabled()).toBe(true);
  await page.getByLabel("沟通内容").fill("电话聊了需求");
  await 转.click();
  await expect.poll(去了).toEqual(["/projects/p1"]);
  expect(errors).toEqual([]); await page.close();
});

it("不是企业版：行上还是「转客户」，转好去客户页", async () => {
  const { page, errors, 去了 } = await 打开(false);
  await page.evaluate(() => { (window as unknown as { __转: unknown }).__转 = { ok: true, customerId: "c1" }; });
  expect(await page.getByTestId("rows").getByRole("button", { name: /转项目/ }).count()).toBe(0);
  await page.getByTestId("rows").getByRole("button", { name: /转客户/ }).click();
  await page.getByRole("button", { name: "转为客户" }).click();
  await expect.poll(去了).toEqual(["/customers/c1"]);
  expect(errors).toEqual([]); await page.close();
});
