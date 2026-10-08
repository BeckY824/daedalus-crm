import { beforeAll, afterAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "members-ui", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "stub", pluginData: code }));
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/^next\/navigation$/, "export const useRouter=()=>({push(){},refresh(){}});");
  stub(/components\/DataList$/, "export default function D(p){return <><div data-testid='rows'>{p.行.map(x=><div key={x.id}>{x.name}</div>)}</div>{p.筛选}</>}");
  stub(/\/ContactForm$/, "export default function F(){return null}");
  stub(/\/useContactRemoval$/, "export const useContactRemoval=()=>({彻底删(){}});");
  b.onLoad({ filter: /.*/, namespace: "stub" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };
beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';
    import Contacts from '@/app/(app)/contacts/ContactsView';
    const base={position:null,phone:null,email:null,wechat:null,isPrimary:false,remark:null,updatedAt:new Date().toISOString(),未归属:false,原来:null,customerId:'c',customerName:'QA',school:null,ownerName:'同名'};
    const rows=[{...base,id:'ca',name:'甲联系人',ownerId:'a',ownerEmail:'sales-a'}, {...base,id:'cb',name:'乙联系人',ownerId:'b',ownerEmail:'sales-b'}];
    createRoot(document.getElementById('root')).render(<App><Contacts rows={rows} 总数={2} keyword="" 学员们={[]} users={[{id:'a',name:'同名',email:'sales-a'}]}/></App>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
it("同名负责人下拉显示不同登录名，各自只筛出自己的联系人", async () => {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("http://members.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://members.test"); await page.addScriptTag({ content: bundle });
  await expect.poll(() => page.locator("#root").innerText()).not.toBe("");
  await page.locator(".ant-select").filter({ has: page.getByText("全部负责人", { exact: true }) }).getByRole("combobox").click();
  await page.locator(".ant-select-item-option-content").getByText("同名（sales-a）", { exact: true }).click();
  expect(await page.getByTestId("rows").innerText()).toBe("甲联系人");
  await page.locator('.ant-select').filter({ hasText: '同名（sales-a）' }).getByRole("combobox").click();
  await page.locator('.ant-select-item-option-content').getByText("同名（sales-b）", { exact: true }).click();
  expect(await page.getByTestId("rows").innerText()).toBe("乙联系人");
  expect(errors).toEqual([]); await page.close();
});
