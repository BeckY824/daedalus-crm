import { afterAll, beforeAll, expect, it } from "vitest";
import {build,type Plugin} from "esbuild";
import path from "node:path";
import {chromium,type Browser} from "playwright";
let bundle:string,browser:Browser;
const plugin:Plugin={name:"solo-page-boundaries",setup(b){
 const stub=(filter:RegExp,code:string)=>b.onResolve({filter},a=>({path:a.path,namespace:"fixture",pluginData:code}));
 stub(/^next\/navigation$/,"export const useRouter=()=>({push(){},refresh(){}})");
 stub(/^next\/link$/,"export default function Link(p){return <a {...p}/>}");
 stub(/(^|\/)demo-data$/,"export const 查演示数据状态=async()=>null,灌一套演示数据=async()=>({ok:false}),清除演示数据=灌一套演示数据;");
 stub(/(^|\/)(TaskForm|PlanForm|OpportunityForm|ContractForm)$/,"export default function Form(){return null}");
 stub(/(^|\/)actions$/,"export const moveStage=async()=>({ok:true}),toggleTask=moveStage,completePlan=moveStage,deletePlan=moveStage,deleteTask=moveStage;");
 b.onLoad({filter:/.*/,namespace:"fixture"},a=>({contents:a.pluginData,loader:"jsx",resolveDir:process.cwd()}));
}};
beforeAll(async()=>{
 bundle=(await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';
 import Pipeline from '@/app/(app)/opportunities/pipeline/PipelineView';import Plans from '@/app/(app)/follow-ups/plans/PlansView';
 import {BusinessProvider} from '@/lib/business-client';import {DEFAULT_BUSINESS} from '@/lib/business-config';
 const root=createRoot(document.getElementById('root'));
 window.__render=(mode,history=false,unknown=false)=>{
 const ownerId=history?'inactive-same-name':unknown?undefined:'qa';
 const item={id:'qa-row',name:'QA商机',amount:100,currency:'CNY',stage:'初步沟通',status:'OPEN',probability:20,expectedDealAt:null,customerId:'c',customerName:'客户',ownerId,ownerName:'QA成员'};
 const task={...item,title:'QA待办',dueAt:null,updatedAt:new Date().toISOString()};
 const done={key:'task:done',kind:'task',标题:'QA已完成',计划时间:null,完成时间:null,customerId:'c',customerName:'客户',ownerId,ownerName:'QA成员'};
 root.render(<App><BusinessProvider value={DEFAULT_BUSINESS}>{mode==='pipeline'?<Pipeline rows={[item]} users={[{id:'qa',name:'QA成员'}]} customers={[]} 赢单天数={30}/>:<Plans key={history+'-'+unknown} plans={[]} tasks={[task]} done={[done]} meId="qa" 预选客户={null} 直接新建={false} 全员/>}</BusinessProvider></App>);
 };window.__render('pipeline');`,loader:"tsx",resolveDir:process.cwd()},bundle:true,write:false,format:"iife",jsx:"automatic",alias:{"@":path.resolve("src")},define:{"process.env.NODE_ENV":'"production"'},plugins:[plugin],logLevel:"silent"})).outputFiles[0].text;
 browser=await chromium.launch();
},120000);
afterAll(async()=>{await browser?.close()});
async function open(){const page=await browser.newPage();page.setDefaultTimeout(5000);await page.route("http://solo.test/**",r=>r.fulfill({contentType:"text/html",body:"<meta charset='utf-8'><div id='root'></div>"}));await page.goto("http://solo.test");await page.addScriptTag({content:bundle});await page.locator(".pipe-card").waitFor();return page}
it("单人管道卡不重复姓名，同名历史成员和未知身份仍展示",async()=>{
 const p=await open();try{
 await expect.poll(()=>p.locator(".pipe-card-o").count()).toBe(0);
 for(const args of [["pipeline",true,false],["pipeline",false,true]]){await p.evaluate(a=>Reflect.get(window,"__render")(...a),args);await expect.poll(()=>p.locator(".pipe-card-o").innerText()).toBe("QA成员")}
 }finally{await p.close()}
});
it("scope=all在单人待办及已完成不露头像，历史成员保留筛选与姓名",async()=>{
 const p=await open();try{
 await p.evaluate(()=>Reflect.get(window,"__render")("plans"));await p.getByText("QA待办",{exact:true}).waitFor();
 expect(await p.locator(".plan-row .ant-avatar").count()).toBe(0);
 await p.getByText("已完成 1",{exact:true}).click();await p.getByText("QA已完成",{exact:true}).waitFor();expect(await p.locator(".plan-row .ant-avatar").count()).toBe(0);
 await p.evaluate(()=>Reflect.get(window,"__render")("plans",true));await p.getByText("QA待办",{exact:true}).waitFor();expect(await p.locator(".plan-row .ant-avatar").count()).toBe(1);expect(await p.getByText("全部成员",{exact:true}).count()).toBe(1);
 await p.getByText("已完成 1",{exact:true}).click();await p.getByText("QA已完成",{exact:true}).waitFor();expect(await p.locator(".plan-row .ant-avatar").count()).toBe(1);
 }finally{await p.close()}
});
