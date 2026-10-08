import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser, bundle: string;
const plugin: Plugin = { name: "import-batch-boundary", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, a => ({ path: a.path, namespace: "navigation" }));
  b.onLoad({ filter: /.*/, namespace: "navigation" }, () => ({ contents: "export const useRouter=()=>({refresh(){}});" }));
  b.onResolve({ filter: /^@\/app\/\(app\)\/customers\/import-actions$/ }, a => ({ path: a.path, namespace: "stub" }));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
    export const 最近批次=async()=>window.__rows;
    export async function 撤销批次(id){window.__undo.push(id);window.__rows.find(r=>r.id===id).revertedAt='2026-10-08T12:00:00.000Z';return {ok:true,删掉:1,还原:2,没动:[]}}
  ` }));
} };
beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import Tab from '@/app/(app)/settings/ImportsTab';import {页脚} from '@/app/(app)/customers/import-steps';import {BusinessProvider} from '@/lib/business-client';import {DEFAULT_BUSINESS} from '@/lib/business-config';
    window.__undo=[];window.__rows=[{id:'zero',fileName:'zero.csv',userName:'原导入者',at:'2026-10-08T11:00:00.000Z',created:0,updated:0,recordedRows:0,revertedAt:null},{id:'written',fileName:'written.csv',userName:'另一位历史操作者',at:'2026-10-08T10:00:00.000Z',created:1,updated:2,recordedRows:3,revertedAt:null},{id:'interrupted',fileName:'interrupted.csv',userName:'第三位',at:'2026-10-08T09:00:00.000Z',created:0,updated:0,recordedRows:1,revertedAt:null}];
    const root=createRoot(document.getElementById('root'));
    window.__render=(footer=false,counts={新建:0,补空:0})=>root.render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={DEFAULT_BUSINESS}>{footer?<页脚 步={4} 忙={false} 认人列={0} 看={null} set步={()=>{}} 去预览={()=>{}} 落库={()=>{}} 撤={()=>window.__undo.push('footer')} 重来={()=>{}} 完成={()=>{}} 这一批={counts} 客户叫法='客户'/>:<Tab/>}</BusinessProvider></App></ConfigProvider>);window.__render();
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '\"production\"' }, plugins: [plugin], logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });
async function open() {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  page.on("pageerror", e => console.log("QA导入页面异常", e.message));
  await page.route("http://batches.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://batches.test"); await page.addScriptTag({ content: bundle }); await page.getByText("zero.csv",{exact:true}).waitFor(); return page;
}
it("历史操作者可见；零写入不挂撤销，补空确认写清还原且取消不执行", async () => {
  const page = await open();
  try {
    const zero=page.locator('[data-row-key="zero"]'); expect(await zero.getByRole('button',{name:/撤\s*销/}).count()).toBe(0); await zero.getByText('无写入，无需撤销').waitFor();
    await page.locator('[data-row-key="written"]').getByText('另一位历史操作者').waitFor();
    await page.locator('[data-row-key="written"]').getByRole('button',{name:/撤\s*销/}).click();
    await page.getByText(/还原 2 位补过空的/).waitFor(); await page.getByRole('button',{name:/不\s*了/}).click();
    expect(await page.evaluate(()=>Reflect.get(window,'__undo'))).toEqual([]);
    const row=page.locator('[data-row-key="written"]'); await row.getByRole('button',{name:/撤\s*销/}).click();
    await page.locator('.ant-popconfirm').getByRole('button',{name:/撤\s*销/}).click(); await row.getByText('已撤销',{exact:true}).waitFor();
    expect(await page.evaluate(()=>Reflect.get(window,'__undo'))).toEqual(['written']);
  } finally { await page.close(); }
});
it("中断计数未完成仍有撤销入口，抽屉零写入不提供假撤销", async () => {
  const page = await open();
  try {
    const row=page.locator('[data-row-key="interrupted"]'); await row.getByText('计数未完成，已记录 1 条写入，可撤销').waitFor(); await row.getByRole('button',{name:/撤\s*销/}).click();
    await page.getByText(/将按 1 条写入记录删除新建客户、还原补空字段/).waitFor(); await page.getByRole('button',{name:/不\s*了/}).click();
    await page.evaluate(()=>Reflect.get(window,'__render')(true)); await page.getByText('本批无写入，无需撤销').waitFor(); expect(await page.getByRole('button',{name:'撤销这一批',exact:true}).count()).toBe(0);
    await page.evaluate(()=>Reflect.get(window,'__render')(true,{新建:0,补空:2})); await page.getByRole('button',{name:'撤销这一批',exact:true}).click(); await page.getByText(/还原 2 位补过空的/).waitFor();
    expect(await page.evaluate(()=>Reflect.get(window,'__undo'))).toEqual([]);
  } finally { await page.close(); }
});
