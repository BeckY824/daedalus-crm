import { beforeAll, afterAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "actions", setup(b) {
  const stub = (filter: RegExp, code: string) => { b.onResolve({ filter }, a => ({ path: a.path, namespace: "stub", pluginData: code })); };
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){},push(){}});");
  stub(/^\.\/actions$/, "export const saveFollowUp=async x=>{window.__calls.push(x);return {ok:true,id:'f1',待办id:'t1'}}; export const completePlan=async()=>({ok:true});");
  stub(/^\.\/ai$/, "export const parseFollowUpDraft=async()=>({ok:false,error:'no'});");
  stub(/^\.\/CustomerPick$/, "export default function C(){return null}");
  b.onLoad({ filter: /.*/, namespace: "stub" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };
beforeAll(async () => {
  const r = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {App} from 'antd'; import C from '@/app/(app)/customers/[id]/FollowUpForm'; createRoot(document.getElementById('root')).render(<App><C open={true} onClose={()=>{}} onSaved={()=>{}} customerId="c1" record={{type:'REMIND'}} aiEnabled={false}/></App>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
it("真实表单未确认历史提醒不提交，确认后明确携带允许标记", async () => {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.route("http://date-form.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://date-form.test");
  await page.addScriptTag({ content: "window.__calls=[];" });
  await page.addScriptTag({ content: bundle });
  await page.locator("#content").fill("补录历史提醒");
  await page.locator("#status").click(); await page.getByTitle("待处理", { exact: true }).click();
  await page.locator("#dueAt").fill("2020-01-02 09:00"); await page.locator("#dueAt").press("Enter");
  await page.getByRole("checkbox", { name: "我确认仍要创建过期待办" }).waitFor();
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await page.getByText("请确认创建过期待办，或修改提醒时间/状态", { exact: true }).waitFor();
  expect(await page.evaluate(() => (window as any).__calls)).toEqual([]);
  await page.getByRole("checkbox", { name: "我确认仍要创建过期待办" }).check();
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__calls.length)).toBe(1);
  expect((await page.evaluate(() => (window as any).__calls))[0]).toMatchObject({ 确认过期待办: true, type: "REMIND", status: "待处理" });
  await page.close();
});
