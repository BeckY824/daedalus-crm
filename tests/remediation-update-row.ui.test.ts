import {beforeAll,afterAll,it,expect} from "vitest";
import {build} from "esbuild";
import path from "node:path";
import {chromium,type Browser} from "playwright";
let browser:Browser,bundle:string;
beforeAll(async()=>{bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';import UpdateRow from '@/components/UpdateRow';
 window.__calls=[];window.__listeners=new Set();window.__state=new Promise((resolve,reject)=>{window.__resolve=resolve;window.__reject=reject});
 window.desktopShell={version:async()=>'0.46.15'};window.desktopUpdate={state:()=>window.__state,onState:cb=>{window.__listeners.add(cb);return()=>window.__listeners.delete(cb)},check:async()=>{window.__calls.push('check');for(const cb of window.__listeners)cb({阶段:'available',版本:'0.46.16'})},download:async()=>{window.__calls.push('download')},install:async()=>{},openDownload:async()=>{}};
 window.__send=s=>{for(const cb of window.__listeners)cb(s)};const root=createRoot(document.getElementById('root'));window.__render=(show=true)=>root.render(<App>{show&&<UpdateRow/>}</App>);window.__render();`,resolveDir:process.cwd(),loader:"tsx"},bundle:true,write:false,format:"iife",jsx:"automatic",alias:{"@":path.resolve("src")},define:{"process.env.NODE_ENV":'"production"'},logLevel:"silent"})).outputFiles[0].text;browser=await chromium.launch()},120000);
afterAll(()=>browser?.close());
async function open(){const p=await browser.newPage();p.setDefaultTimeout(5000);await p.route("http://update.test/**",r=>r.fulfill({contentType:"text/html",body:"<meta charset='utf-8'><div id='root'></div>"}));await p.goto("http://update.test");await p.addScriptTag({content:bundle});await expect.poll(()=>p.evaluate(()=>Reflect.get(window,"__listeners").size)).toBe(1);return p}
it("无需手动检查即可显示已有新版，晚到的旧idle快照不能盖掉实时更新状态",async()=>{
 const p=await open();try{
 await p.evaluate(()=>{Reflect.get(window,"__send")({阶段:"available",版本:"0.46.16"});Reflect.get(window,"__resolve")({阶段:"idle"})});
 await expect.poll(()=>p.locator(".rail-upd-t").innerText()).toBe("更新到 0.46.16");expect(await p.evaluate(()=>Reflect.get(window,"__calls"))).toEqual([]);
 await p.evaluate(()=>Reflect.get(window,"__send")({阶段:"ready",版本:"0.46.16"}));await expect.poll(()=>p.locator(".rail-upd-t").innerText()).toBe("重启以更新到 0.46.16");
 }finally{await p.close()}
});
it("首读IPC失败显示可重试状态，重试可恢复且卸载移除监听",async()=>{
 const p=await open();try{
 await p.evaluate(()=>Reflect.get(window,"__reject")(Error("QA IPC断开")));await p.getByRole("button",{name:/更新失败，点击重试/}).waitFor();
 // 与主进程一样：无下载计划时download重新检查。
 await p.evaluate(()=>Reflect.get(window,"desktopUpdate")!.download=Reflect.get(window,"desktopUpdate")!.check);await p.getByRole("button",{name:/更新失败，点击重试/}).click();await p.getByRole("button",{name:/更新到 0.46.16/}).waitFor();
 expect(await p.evaluate(()=>Reflect.get(window,"__calls"))).toEqual(["check"]);await p.evaluate(()=>Reflect.get(window,"__render")(false));await expect.poll(()=>p.evaluate(()=>Reflect.get(window,"__listeners").size)).toBe(0);
 }finally{await p.close()}
});
