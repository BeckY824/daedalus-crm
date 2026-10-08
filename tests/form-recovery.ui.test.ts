import { beforeAll, afterAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";

declare global { interface Window { __kind: string; __calls: unknown[]; __fail: boolean; __saved: number; __reminderRefreshes: number; __wasPrimary: boolean | null } }

let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "form-actions", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "stub", pluginData: code }));
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){},push(){}});");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/^\.\/CustomerPick$/, "export default function C(){return null}");
  stub(/^\.\/ReferralRadar$/, "export default function C(){return null}");
  stub(/^@\/components\/DataList$/, "export default function C(){return null}");
  stub(/orders\/actions$/, "export const 供应商候选=async()=>[];");
  stub(/^\.\.\/channels\/actions$/, "export const saveChannel=async()=>({ok:true});");
  stub(/^(\.\/|\.\.\/)actions$/, `
    const save=async x=>{window.__calls.push(x);if(window.__fail)throw Error('network');return {ok:true,id:'saved'}};
    export const savePlan=save,saveTask=save,saveContact=save,saveUnassignedContact=save,saveChannel=save,改我的资料=save;
    export const saveCustomer=save,checkDuplicate=async()=>null;
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
    import Task from '@/app/(app)/customers/[id]/TaskForm';
    import Contact from '@/app/(app)/customers/[id]/ContactForm';
    import Customer from '@/app/(app)/customers/CustomerForm';
    import Contract from '@/app/(app)/customers/[id]/ContractForm';
    import Profile from '@/app/(app)/settings/ProfileTab';
    import Channels from '@/app/(app)/channels/ChannelsView';
    const done=()=>window.__saved++;
    const forms={calendarPlan:<Plan open customerId="c1" record={window.__calendarRecord} onSaved={done} onClose={()=>{}}/>,
      calendarTask:<Task open customerId="c1" record={window.__calendarRecord} onSaved={done} onClose={()=>{}}/>,
      plan:<Plan open customerId="c1" record={null} onSaved={done} onClose={()=>{}}/>,
      contact:<Contact open customerId="c1" record={null} onSaved={done} onClose={()=>{}}/>,
      detached:<Contact open 未归属 record={{id:'detached',name:'QA联系人',isPrimary:false,wasPrimary:window.__wasPrimary,fromCustomerId:'original',updatedAt:'2026-10-08T08:00:00Z'}} 学员们={[{id:'original',name:'原客户'},{id:'new',name:'新客户'}]} onSaved={done} onClose={()=>{}}/>,
      customer:<Customer open editing={{id:'self',name:'我自己',phone:'',salesOwnerId:'u',salesOwnerName:'QA',followStatus:'待跟进',decisionStatus:'了解中',referrerCustomerId:'other',updatedAt:'2026-10-08T08:00:00Z'}} users={[{id:'u',name:'QA',email:'qa',role:'ADMIN',active:true}]} channels={[]} customers={[{id:'self',name:'我自己'},{id:'other',name:'推荐人甲'}]} onClose={()=>{}}/>,
      contract:<Contract open customerId="c1" editing={null} onClose={done}/>,
      profile:<Profile me={{name:'原名',title:'',email:'qa@example.invalid'}}/>,
      channel:<Channels rows={[]} users={[{id:'u1',name:'我',role:'ADMIN',active:true}]} radar={{topReferrers:[],inviteCandidates:[]}} aiEnabled={false}/>};
    createRoot(document.getElementById('root')).render(<App>{forms[window.__kind]}</App>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

it.each([true, null])("J-022 挂回原客户预选关键身份=%s，换客户不预选，明确取消可保存", async wasPrimary => {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.route("http://forms.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://forms.test"); await page.evaluate(wasPrimary => Object.assign(window, { __kind: "detached", __calls: [], __fail: false, __saved: 0, __wasPrimary: wasPrimary }), wasPrimary);
  await page.addScriptTag({ content: bundle });
  await page.locator("#customerId").click(); await page.locator(".ant-select-item-option-content").getByText("原客户", { exact: true }).click();
  const toggle = page.getByRole("switch"); await toggle.waitFor(); expect(await toggle.getAttribute("aria-checked")).toBe(String(wasPrimary === true));
  if (wasPrimary === null) expect(await page.getByText("移出前是否关键未记录，请核对后选择").count()).toBe(1);
  await page.locator("#customerId").click(); await page.locator(".ant-select-item-option-content").getByText("新客户", { exact: true }).click();
  expect(await toggle.getAttribute("aria-checked")).toBe("false");
  await page.locator("#customerId").click(); await page.locator(".ant-select-item-option-content").getByText("原客户", { exact: true }).click();
  if (wasPrimary === true) await toggle.click();
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(1);
  expect(await page.evaluate(() => window.__calls[0])).toMatchObject({ customerId: "original", isPrimary: false }); await page.close();
});
it("J-006 客户编辑的推荐人下拉排除自己，其他已有客户仍可选", async () => {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.route("http://forms.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://forms.test"); await page.evaluate(() => Object.assign(window, { __kind: "customer", __calls: [], __fail: false, __saved: 0 }));
  await page.addScriptTag({ content: bundle }); await page.locator("#referrerCustomerId").click();
  const options = page.locator(".ant-select-dropdown:visible .ant-select-item-option-content");
  await expect.poll(() => options.allTextContents()).toEqual(["推荐人甲"]); await page.close();
});

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

it.each(["America/New_York", "America/Santiago"])("日期表单在%s保留日历日且仅日期不显示钟点", async timezoneId => {
  for (const kind of ["calendarPlan", "calendarTask"]) {
    const page = await browser.newPage({ timezoneId }); page.setDefaultTimeout(5000);
    await page.route("http://forms.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
    await page.goto("http://forms.test");
    await page.evaluate(kind => Object.assign(window, { __kind: kind, __calls: [], __fail: false, __saved: 0, __calendarRecord: { id: "qa-date", subject: "核对日期", title: "核对日期", method: "电话沟通", plannedAt: "2026-09-06", dueAt: "2026-09-06", plannedHasTime: false, dueHasTime: false } }), kind);
    await page.addScriptTag({ content: bundle }); const picker = page.locator(kind === "calendarPlan" ? "#plannedAt" : "#dueAt");
    await expect.poll(() => picker.inputValue()).toBe("2026-09-06");
    expect(await page.getByRole("checkbox", { name: "指定钟点并到点提醒" }).isChecked()).toBe(false);
    await page.getByRole("button", { name: /保\s*存|创\s*建/ }).click();
    await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(1);
    expect(await page.evaluate(() => window.__calls[0])).toMatchObject(kind === "calendarPlan" ? { plannedAt: "2026-09-06", plannedHasTime: false } : { dueAt: "2026-09-06", dueHasTime: false });
    await page.close();
  }
});
it("旧记录仅改标题不把未知时间强制改为明确钟点，显式修改模式才交新语义", async () => {
  const page = await browser.newPage({ timezoneId: "America/New_York" }); page.setDefaultTimeout(5000);
  await page.route("http://forms.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://forms.test"); await page.evaluate(() => Object.assign(window, { __kind: "calendarPlan", __calls: [], __fail: false, __saved: 0, __calendarRecord: { id: "legacy", subject: "旧计划", method: "电话沟通", plannedAt: "2026-10-08T04:00:00Z", plannedHasTime: null } }));
  await page.addScriptTag({ content: bundle }); await page.getByText(/旧记录未保存是否选了钟点/).waitFor();
  await page.locator("#subject").fill("只改标题"); await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(1);
  const first = await page.evaluate(() => window.__calls[0]) as { plannedAt: string; plannedHasTime?: boolean };
  expect(first.plannedAt).toBe("2026-10-08T04:00:00.000Z"); expect(first.plannedHasTime).toBeUndefined();
  await page.getByRole("checkbox", { name: "指定钟点并到点提醒" }).click(); await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(2);
  expect(await page.evaluate(() => window.__calls[1])).toMatchObject({ plannedAt: "2026-10-08", plannedHasTime: false }); await page.close();
});
