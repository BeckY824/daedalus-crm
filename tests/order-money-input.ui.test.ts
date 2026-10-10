import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser, bundle: string;
const plugin: Plugin = { name: "order-money-actions", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, a => ({ path: a.path, namespace: "fixture", pluginData: "export const useRouter=()=>({refresh(){},push(){}});" }));
  b.onResolve({ filter: /^\.\/actions$/ }, a => ({ path: a.path, namespace: "fixture", pluginData: "export const saveOrder=async(id,value)=>{window.__saved=value;return {ok:true}};export const createOrder=saveOrder;" }));
  b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };
beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import Form from '@/app/(app)/orders/OrderForm';import {BusinessProvider} from '@/lib/business-client';import {DEFAULT_BUSINESS} from '@/lib/business-config';
    createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={DEFAULT_BUSINESS}><Form open editing={{id:'qa-order',no:'QA-ORDER',amount:1200,currency:'USD',incoterm:'FOB',payment:null,depositDue:100,remark:null}} onClose={()=>{}}/></BusinessProvider></App></ConfigProvider>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
it.each([['订单金额','订单金额不能为负数'],['定金应收','定金应收不能为负数']])("B5 %s 负数失焦不改为零，保存被拦截", async (label,message) => {
  const page = await browser.newPage();page.setDefaultTimeout(5000);
  try {
    await page.route('http://order-money.test/**',r=>r.fulfill({contentType:'text/html',body:"<meta charset='utf-8'><div id='root'></div>"}));
    await page.goto('http://order-money.test/orders/qa-order');await page.addScriptTag({content:bundle});
    const dialog=page.getByRole('dialog');const input=dialog.getByRole('spinbutton',{name:label,exact:true});
    await input.fill('-5');await dialog.locator('#no').click();expect(await input.inputValue()).toBe('-5');
    await dialog.getByRole('button',{name:/保\s*存/}).click();await dialog.getByText(message,{exact:true}).waitFor();
    expect(await page.evaluate(()=>Reflect.get(window,'__saved'))).toBeUndefined();
  }finally{await page.close()}
});

it("合法金额失焦格式化，按原数保存，定金不被改变",async()=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);try{
  await page.route('http://order-money.test/**',r=>r.fulfill({contentType:'text/html',body:"<meta charset='utf-8'><div id='root'></div>"}));await page.goto('http://order-money.test/orders/qa-order');await page.addScriptTag({content:bundle});
  const dialog=page.getByRole('dialog');const amount=dialog.getByRole('spinbutton',{name:'订单金额',exact:true});await amount.fill('12000.50');await dialog.locator('#no').click();expect(await amount.inputValue()).toBe('12,000.5');
  await dialog.getByRole('button',{name:/保\s*存/}).click();await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'__saved'))).toMatchObject({amount:12000.5,depositDue:100,currency:'USD'});
 }finally{await page.close()}
});
