import {afterAll,beforeAll,expect,it} from "vitest";
import {build,type Plugin} from "esbuild";
import path from "node:path";
import {chromium,type Browser} from "playwright";
let browser:Browser,bundle:string;
const plugin:Plugin={name:"business-config-boundaries",setup(b){
 const stub=(filter:RegExp,contents:string)=>b.onResolve({filter},a=>({path:a.path,namespace:"stub",pluginData:contents}));
 stub(/^next\/navigation$/,"export const useRouter=()=>({refresh(){}});");stub(/^\.\/actions$/,"export const saveBusinessSettings=async()=>({ok:true});");stub(/components\/EmptyState$/,"export const DemoDataSection=()=>null;");
 b.onLoad({filter:/.*/,namespace:"stub"},a=>({contents:a.pluginData,loader:"jsx",resolveDir:process.cwd()}));
}};
beforeAll(async()=>{bundle=(await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{App}from'antd';import Business from'@/app/(app)/settings/BusinessSettingsTab';import{BUSINESS_PRESETS}from'@/lib/business-config';const root=createRoot(document.getElementById('root'));window.__render=(preset)=>root.render(<App><Business key={preset} value={{...BUSINESS_PRESETS[preset],grades:[],sources:[],industries:[]}}/></App>);`,loader:"tsx",resolveDir:process.cwd()},bundle:true,write:false,format:"iife",jsx:"automatic",alias:{"@":path.resolve("src")},define:{"process.env.NODE_ENV":'"production"'},plugins:[plugin],logLevel:"silent"})).outputFiles[0].text;browser=await chromium.launch()});
afterAll(async()=>{await browser?.close()});
it.each([
 ["通用销售","创始人 / 老板、高管、部门负责人…"],
 ["外贸出口","老板 / 创始人、采购负责人、项目经理…"],
 ["教培招生","大一、大二、大三…"],
])("%s空选项给出当前行业示例，切模板整组联动",async(preset,example)=>{const page=await browser.newPage();page.setDefaultTimeout(5000);try{
 await page.setContent("<meta charset='utf-8'><div id='root'></div>");await page.addScriptTag({content:bundle});await page.evaluate(p=>Reflect.get(window,"__render")(p),preset);await expect.poll(()=>page.getByText(example,{exact:true}).isVisible()).toBe(true);
 if(preset==="外贸出口"){expect(await page.getByText("外贸 / 进出口、跨境电商、代理经销…",{exact:true}).isVisible()).toBe(true);expect(await page.getByText("阿里国际站、独立站询盘、谷歌搜索…",{exact:true}).isVisible()).toBe(true)}
 await page.getByText(preset==="外贸出口"?"通用":"外贸",{exact:true}).click();await expect.poll(()=>page.locator("#statusLabels_已签约").inputValue()).toBe(preset==="外贸出口"?"":"已下单");expect(await page.getByText(/还没保存/).isVisible()).toBe(true);
}finally{await page.close()}});
