import {beforeAll,afterAll,it,expect} from "vitest";
import {build,type Plugin} from "esbuild";
import path from "node:path";
import {readFileSync} from "node:fs";
import {chromium,type Browser} from "playwright";
let browser:Browser,bundle:string;
const css=["globals.css","skins/shared.css","skins/ledger.css","skins/tech.css","skins/pixel.css","skins/luxe.css"].map(p=>readFileSync(path.join("src/app",p),"utf8")).join("\n");
const plugin:Plugin={name:"chart-next-link",setup(b){b.onResolve({filter:/^next\/navigation$/},()=>({path:"navigation",namespace:"nav"}));b.onLoad({filter:/.*/,namespace:"nav"},()=>({contents:"export const useRouter=()=>({push(){},refresh(){}});export const usePathname=()=>'/dashboard';"}));b.onResolve({filter:/^next\/link$/},()=>({path:"link",namespace:"fixture"}));b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"export default function Link(p){return <a {...p}/>}",loader:"jsx",resolveDir:process.cwd()}))}};
beforeAll(async()=>{
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';import Chart from '@/components/Chart';import {StageTag,FollowStatusTag} from '@/components/ui';import {palette,alpha} from '@/lib/palette';import {getInstanceByDom} from 'echarts/core';
 const option={animation:false,legend:{data:['#2f6bff']},grid:{left:45,right:20,top:20,bottom:35},tooltip:{backgroundColor:palette.panel,textStyle:{color:palette.ink}},xAxis:{type:'category',data:['#2f6bff'],axisLabel:{color:palette.textMuted}},yAxis:{type:'value',splitLine:{lineStyle:{color:palette.lineSoft}}},series:[{name:'#2f6bff',type:'line',data:[10],lineStyle:{color:palette.brand},areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:alpha(palette.brand,.25)},{offset:1,color:alpha(palette.brand,0)}]}}}]};
 window.__toggle=()=>getInstanceByDom(document.querySelector('#chart>div'))?.dispatchAction({type:'legendToggleSelect',name:'#2f6bff'});window.__original=option;window.__options=()=>getInstanceByDom(document.querySelector('#chart>div'))?.getOption();
 const root=createRoot(document.getElementById('root'));window.__render=(show=true)=>root.render(<App>{show&&<><div id="chart"><Chart option={option}/></div><div id="stage"><StageTag stage="初步沟通"/></div><div id="follow"><FollowStatusTag status="意向较高"/><FollowStatusTag status="已签约"/></div></>}</App>);window.__render();`,loader:"tsx",resolveDir:process.cwd()},bundle:true,write:false,format:"iife",jsx:"automatic",alias:{"@":path.resolve("src")},define:{"process.env.NODE_ENV":'"production"'},plugins:[plugin],logLevel:"silent"})).outputFiles[0].text;
 browser=await chromium.launch();
},120000);
afterAll(async()=>{await browser?.close()});
async function open(){const p=await browser.newPage({viewport:{width:900,height:600}});p.setDefaultTimeout(5000);const errors:string[]=[];p.on("pageerror",e=>errors.push(e.stack??e.message));await p.route("http://chart.test/**",r=>r.fulfill({contentType:"text/html",body:"<meta charset='utf-8'><div id='root'></div>"}));await p.goto("http://chart.test");await p.addStyleTag({content:css});await p.addScriptTag({content:bundle});try{await p.locator("canvas").waitFor()}catch(e){console.log("chart-debug",errors,await p.locator("#root").innerHTML());throw e}return p}
it("真实ECharts原地切换五主题与底色，主色/文字/背景即时跟随且不改业务数据",async()=>{
 const p=await open();try{
 await p.evaluate(()=>Reflect.get(window,"__toggle")());
 for(const skin of ["ledger","tech","pixel","luxe","now"]){await p.evaluate(s=>{document.documentElement.dataset.skin=s;document.documentElement.dataset.paper='tone'},skin);
 await expect.poll(()=>p.evaluate(()=>{const opts=Reflect.get(window,"__options")();const css=getComputedStyle(document.documentElement);return [opts.series[0].lineStyle.color,css.getPropertyValue('--brand').trim()]})).toSatisfy(v=>v[0].toLowerCase()===v[1].toLowerCase());
 const opts=await p.evaluate(()=>Reflect.get(window,"__options")());expect(opts.series[0].name).toBe("#2f6bff");expect(opts.xAxis[0].data).toEqual(["#2f6bff"]);expect(opts.series[0].data).toEqual([10]);expect(opts.legend[0].selected["#2f6bff"]).toBe(false);
 }
 await p.evaluate(()=>{document.documentElement.dataset.skin='tech';document.documentElement.dataset.paper='white'});
 await expect.poll(()=>p.evaluate(()=>{const o=Reflect.get(window,"__options")();return [o.tooltip[0].backgroundColor,getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()]})).toSatisfy(v=>v[0].toLowerCase()===v[1].toLowerCase());
 const original=await p.evaluate(()=>Reflect.get(window,"__original"));expect(original.series[0].lineStyle.color).toBe("#2f6bff");
 }finally{await p.close()}
});
it("阶段标签随主题分类色更新，图表渐变透明度保留，卸载后重建正常",async()=>{
 const p=await open();try{
 await p.evaluate(()=>document.documentElement.dataset.skin='ledger');
 await expect.poll(()=>p.locator("#stage .ant-tag").evaluate(el=>getComputedStyle(el).color)).not.toBe("rgb(37, 99, 235)");
 await expect.poll(()=>p.evaluate(()=>Reflect.get(window,"__options")().series[0].areaStyle.color.colorStops[0].color)).not.toBe("#2f6bff40");
 const colors=await p.evaluate(()=>Reflect.get(window,"__options")().series[0].areaStyle.color.colorStops.map((x:{color:string})=>x.color));expect(colors[0]).toMatch(/40$|0\.25098/);expect(colors[1]).toMatch(/00$|,\s*0\)$/);
 await p.evaluate(()=>Reflect.get(window,"__render")(false));await expect.poll(()=>p.locator("canvas").count()).toBe(0);await p.evaluate(()=>Reflect.get(window,"__render")());await p.locator("canvas").waitFor();
 await expect.poll(()=>p.evaluate(()=>Reflect.get(window,"__options")().series[0].lineStyle.color)).toBe("#1f5a44");
 }finally{await p.close()}
});

it("J-118 同义正向状态使用同一种绿，账簿警示棕与朱印色明确分开",async()=>{
 const p=await open();try{
 for(const skin of ["now","ledger","tech","pixel","luxe"]){await p.evaluate(s=>document.documentElement.dataset.skin=s,skin);
  const colors=await p.locator("#follow .ant-tag").evaluateAll(es=>es.map(e=>getComputedStyle(e).color));expect(colors[0]).toBe(colors[1]);
 }
 await p.evaluate(()=>document.documentElement.dataset.skin="ledger");
 const colors=await p.evaluate(()=>{const c=getComputedStyle(document.documentElement);return [c.getPropertyValue("--danger").trim(),c.getPropertyValue("--seal").trim()]});
 expect(colors).toEqual(["#8b4513","#c8321e"]);
 }finally{await p.close()}
});
