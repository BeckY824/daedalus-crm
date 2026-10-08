import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser, bundle: string;
const plugin: Plugin = { name: "history-server-boundaries", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "fixture", pluginData: code }));
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){window.__refresh++},push(){}});");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/(^|\/)(TaskForm|PlanForm|ContactForm|ContractForm|CustomerForm|InlineField|AiPanel|StarButton|CustomerPick)$/, "export default function Empty(){return null}");
  stub(/^\.\/useContactRemoval$/, "export const useContactRemoval=()=>({问怎么拿掉(){}});");
  stub(/^\.\/ai$/, "export const parseFollowUpDraft=async()=>({ok:false,error:'no AI'});");
  stub(/(^|\/)pool-actions$/, "export const 放进公海=async()=>({ok:false}),领取=放进公海,撤销公海=放进公海;");
  stub(/^\.\.\/actions$/, "export const deleteContract=async()=>({ok:false}),删签约前清点=async()=>({退回商机:[]});");
  stub(/^\.\/follow-history-actions$/, `
    export async function loadFollowHistory(customerId,before){window.__requests.push({customerId,before});if(window.__fail){window.__fail=false;throw Error('QA网络中断，请重试')};
      if(window.__delay){window.__delay=false;await new Promise(r=>window.__resolve=r)};
      const rows=window.__rows[customerId].filter(x=>!before||x.occurredAt<before.occurredAt||(x.occurredAt===before.occurredAt&&x.id<before.id));return {ok:true,rows:rows.slice(0,50),hasMore:rows.length>50};}
    export const readFollowHistoryRow=async(customerId,id)=>({ok:true,row:window.__rows[customerId].find(x=>x.id===id)??null});
  `);
  stub(/^\.\/actions$/, `
    export const toggleTask=async()=>({ok:true}),deleteTask=toggleTask,completePlan=toggleTask;
    export async function saveFollowUp(x){window.__saved=x;const row=window.__rows[x.customerId].find(r=>r.id===x.id);Object.assign(row,x,{updatedAt:'2026-10-08T12:00:00.000Z'});return {ok:true,id:x.id}}
    export async function deleteFollowUp(id,customerId){const rows=window.__rows[customerId],i=rows.findIndex(r=>r.id===id);return {ok:true,快照:{...rows.splice(i,1)[0],customerId}}}
    export async function restoreFollowUp(snapshot){window.__rows[snapshot.customerId].push(snapshot);window.__rows[snapshot.customerId].sort((a,b)=>b.id.localeCompare(a.id));return {ok:true}}
  `);
  b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };
beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import Record from '@/app/(app)/customers/[id]/RecordView';import {BusinessProvider} from '@/lib/business-client';import {DEFAULT_BUSINESS} from '@/lib/business-config';
    window.__rows={};window.__refresh=0;window.__requests=[];
    for(const customer of ['a','b'])window.__rows[customer]=Array.from({length:153},(_,n)=>({id:customer+'-'+String(152-n).padStart(4,'0'),type:n%2?'PHONE':'EMAIL',title:customer+'记录'+(152-n),content:customer+'内容'+(152-n),status:'已完成',duration:null,occurredAt:'2026-01-01T02:00:00.000Z',dueAt:null,participants:null,sourceText:null,ownerName:'QA',contactName:null,contactPosition:null,contactId:null,opportunityId:null,updatedAt:'2026-01-01T02:00:00.000Z'}));
    const root=createRoot(document.getElementById('root'));
    window.__render=(id='a')=>root.render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={DEFAULT_BUSINESS}><Record customer={{id,name:'客户'+id,phone:'',school:null,grade:null,major:null,followStatus:'跟进中',decisionStatus:'了解中',expectedSignAt:null,lastFollowAt:null,remark:null,referrerCustomerId:null,channelId:null,channelOwnerId:null,salesOwnerId:'qa',salesOwnerName:'QA',signedAmount:0,updatedAt:'2026-01-01T02:00:00.000Z'}} contacts={[]} contracts={[]} opportunities={[]} tasks={[]} plan={null} users={[]} channels={[]} referrableCustomers={[]} aiEnabled={false} followUps={window.__rows[id].slice(0,50)} followUpsHasMore={window.__rows[id].length>50}/></BusinessProvider></App></ConfigProvider>);
    window.__render();
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
async function open() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); page.setDefaultTimeout(5000);
  await page.route("http://history.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://history.test"); await page.addScriptTag({ content: bundle }); await page.locator("#fu-a-0152").waitFor(); return page;
}
it("真实详情页加载第51条及153条，旧记录表单编辑/删除/撤销及时更新，筛选与重载可用", async () => {
  const page = await open(); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    expect(await page.locator(".rec-tl-item[id^='fu-']").count()).toBe(50);
    await page.getByRole("button", { name: "加载更早的跟进" }).click(); await page.locator("#fu-a-0102").waitFor();
    const row = page.locator("#fu-a-0102"); await row.getByRole("button", { name: "编辑跟进" }).click();
    const dialog = page.getByRole("dialog"); await dialog.locator("#content").fill("第51条已改好"); await dialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect.poll(() => row.locator(".rec-tl-content").innerText()).toBe("第51条已改好");
    expect(await page.evaluate(() => (Reflect.get(window, "__saved") as unknown as { 版本: string }).版本)).toBe("2026-01-01T02:00:00.000Z");
    await row.getByRole("button", { name: "删除跟进" }).click(); await row.locator(".inlc-yes").click();
    await expect.poll(() => row.count()).toBe(0);
    await page.getByRole("button", { name: /撤\s*销/ }).click();
    await expect.poll(() => row.locator(".rec-tl-content").innerText()).toBe("第51条已改好");
    await page.getByRole("button", { name: "加载更早的跟进" }).click(); await page.locator("#fu-a-0003").waitFor();
    await page.getByRole("button", { name: "加载更早的跟进" }).click(); await page.locator("#fu-a-0000").waitFor();
    expect(await page.locator(".rec-tl-item[id^='fu-']").count()).toBe(153); expect(await page.getByRole("button", { name: "加载更早的跟进" }).count()).toBe(0);
    await page.locator(".rec-chip").filter({ hasText: /邮件/ }).click(); await expect.poll(() => page.locator(".rec-tl-item[id^='fu-']").count()).toBe(77);
    await page.getByRole("button", { name: "重新加载历史" }).click();
    await expect.poll(() => page.locator(".rec-tl-item[id^='fu-']").count()).toBe(25);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});
it("加载失败可重试且不推进游标，切换客户后旧在途响应不混入新客户", async () => {
  const page = await open();
  try {
    await page.evaluate(() => Object.assign(window, { __fail: true })); await page.getByRole("button", { name: "加载更早的跟进" }).click(); await page.getByText("QA网络中断，请重试", { exact: true }).waitFor();
    expect(await page.locator(".rec-tl-item[id^='fu-']").count()).toBe(50);
    await page.getByRole("button", { name: "加载更早的跟进" }).click(); await page.locator("#fu-a-0102").waitFor();
    expect(await page.evaluate(() => Reflect.get(window, "__requests").slice(0,2).map((x: {before: unknown})=>x.before))).toEqual([{ id: "a-0103", occurredAt: "2026-01-01T02:00:00.000Z" }, { id: "a-0103", occurredAt: "2026-01-01T02:00:00.000Z" }]);
    await page.evaluate(() => Object.assign(window, { __delay: true })); await page.getByRole("button", { name: "加载更早的跟进" }).click();
    await page.evaluate(() => Reflect.get(window, "__render")("b")); await page.locator("#fu-b-0152").waitFor();
    await page.evaluate(() => Reflect.get(window, "__resolve")());
    await page.getByRole("button", { name: "加载更早的跟进" }).click(); await page.locator("#fu-b-0102").waitFor();
    await expect.poll(() => page.locator("[id^='fu-a-']").count()).toBe(0); expect(await page.locator("[id^='fu-b-']").count()).toBe(100);
  } finally { await page.close(); }
});
