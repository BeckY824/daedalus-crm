import { beforeAll, afterAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";

declare global { interface Window { __kind: string; __calls: unknown[]; __fail: boolean; __saved: number; __reminderRefreshes: number } }

let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "form-actions", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "stub", pluginData: code }));
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){},push(){}});");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/^\.\/CustomerPick$/, "export default function C(){return null}");
  stub(/^\.\/ReferralRadar$/, "export default function C(){return null}");
  stub(/^@\/components\/DataList$/, "export default function C(){return null}");
  stub(/orders\/actions$/, "export const 供应商候选=async()=>[];");
  stub(/^(\.\/|\.\.\/)actions$/, `
    const save=async x=>{window.__calls.push(x);if(window.__fail)throw Error('network');return {ok:true,id:'saved'}};
    export const savePlan=save,saveContact=save,saveUnassignedContact=save,saveChannel=save,改我的资料=save;
    export const saveContract=async x=>window.__duplicate&&!x.force?{duplicate:{amount:123,currency:'CNY',signedAt:new Date().toISOString()}}:save(x);
    export const listContractLinks=async()=>({商机:[],计划:[],待办:[]});
    export const toggleChannel=save,deleteChannel=save;
  `);
  b.onLoad({ filter: /.*/, namespace: "stub" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };
beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';
    import Plan from '@/app/(app)/customers/[id]/PlanForm';
    import Contact from '@/app/(app)/customers/[id]/ContactForm';
    import Contract from '@/app/(app)/customers/[id]/ContractForm';
    import Profile from '@/app/(app)/settings/ProfileTab';
    import Channels from '@/app/(app)/channels/ChannelsView';
    const done=()=>window.__saved++;
    const forms={plan:<Plan open customerId="c1" record={null} onSaved={done} onClose={()=>{}}/>,
      contact:<Contact open customerId="c1" record={null} onSaved={done} onClose={()=>{}}/>,
      contract:<Contract open customerId="c1" editing={null} onClose={done}/>,
      profile:<Profile me={{name:'原名',title:'',email:'qa@example.invalid'}}/>,
      channel:<Channels rows={[]} users={[{id:'u1',name:'我',role:'ADMIN',active:true}]} radar={{topReferrers:[],inviteCandidates:[]}} aiEnabled={false}/>};
    createRoot(document.getElementById('root')).render(<App>{forms[window.__kind]}</App>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

it.each([
  ["plan", "subject", "请填写跟进主题"], ["contact", "name", "请填写姓名"],
  ["contract", "amount", "请输入签约金额"], ["profile", "name", "名字不能为空"],
  ["channel", "name", "请输入渠道姓名"],
])("%s 校验不产生未处理拒绝，网络失败后保留内容并可重试", async (kind, field, warning) => {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("http://forms.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://forms.test");
  await page.evaluate(kind => Object.assign(window, { __kind: kind, __calls: [], __fail: true, __saved: 0 }), kind);
  await page.evaluate(() => Object.assign(window, { __reminderRefreshes: 0, desktopReminders: { 刷新: async () => { window.__reminderRefreshes++; } } }));
  await page.addScriptTag({ content: bundle });
  if (kind === "channel") await page.getByRole("button", { name: /新建渠道/ }).click();
  const input = page.locator(`#${field}`);
  await input.fill("");
  const save = page.getByRole("button", { name: /保\s*存/ });
  await save.click();
  await page.getByText(warning, { exact: true }).waitFor();
  expect(await page.evaluate(() => window.__calls.length)).toBe(0);
  await expect.poll(() => save.isEnabled()).toBe(true);
  const value = kind === "contract" ? "123" : "可重试内容👨‍👩‍👧";
  await input.fill(value);
  await save.click();
  await page.getByText("保存失败，请刷新确认结果后重试", { exact: true }).waitFor();
  if (kind === "plan") expect(await page.evaluate(() => window.__reminderRefreshes)).toBe(0);
  expect(await input.inputValue()).toBe(value);
  await expect.poll(() => save.isEnabled()).toBe(true);
  await page.evaluate(() => { window.__fail = false; });
  await save.click();
  await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(2);
  if (kind === "plan") await expect.poll(() => page.evaluate(() => window.__reminderRefreshes)).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
});


it("重复签约确认后的网络失败不会产生未处理拒绝，原表单仍可重试", async () => {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("http://forms.test/**", r => r.fulfill({contentType:"text/html",body:"<meta charset='utf-8'><div id='root'></div>"}));
  await page.goto("http://forms.test");
  await page.evaluate(() => Object.assign(window,{__kind:"contract",__calls:[],__fail:true,__duplicate:true,__saved:0}));
  await page.addScriptTag({content:bundle});
  await page.locator("#amount").fill("123");
  await page.getByRole("button",{name:/保\s*存/}).click();
  await page.getByRole("button",{name:"确实是另一笔，继续录入"}).click();
  await page.getByText("保存失败，请刷新确认结果后重试",{exact:true}).waitFor();
  expect(await page.locator("#amount").inputValue()).toBe("123");
  await page.evaluate(() => {window.__fail=false});
  await page.getByRole("button",{name:/保\s*存/}).click();
  await page.getByRole("button",{name:"确实是另一笔，继续录入"}).click();
  await expect.poll(() => page.evaluate(()=>window.__saved)).toBe(1);
  expect(await page.evaluate(()=>window.__calls.length)).toBe(2);
  expect(errors).toEqual([]);
  await page.close();
});
