import { beforeAll, afterAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser; let bundle: string;
const plugin: Plugin = {name:"stats-ui",setup(b){
  const stub=(filter:RegExp,code:string)=>b.onResolve({filter},a=>({path:a.path,namespace:"stub",pluginData:code}));
  stub(/demo-data(?:\.tsx?)?$/, "export const 查演示数据状态=async()=>({可灌:false}),灌一套演示数据=async()=>({ok:false}),清除演示数据=async()=>({ok:false});");
  stub(/^next\/link$/,"export default function L(p){return <a {...p}/>}");
  stub(/^next\/navigation$/,"export const useRouter=()=>({push(){},refresh(){}}),useSearchParams=()=>new URLSearchParams();");
  stub(/components\/Chart$/,"export default function C(){return <div>chart</div>}");
  stub(/(^|\/)ai-jobs(?:\.tsx?)?$/,"export const useJob=()=>null,runJob=()=>{},clearJob=()=>{};");
  stub(/(^|\/)draft-jobs(?:\.tsx?)?$/,"export const 起草=()=>{},草稿键=()=>'',useCopyDraft=()=>()=>{};");
  stub(/(^|\/)AiCost(?:\.tsx?)?$/,"export default function C(){return null};export const useAiOutOfCredits=()=>false;");
  stub(/(^|\/)ai(?:\.tsx?)?$/,"export const explainWatchlist=async()=>({ok:false});");
  b.onLoad({filter:/.*/,namespace:"stub"},a=>({contents:a.pluginData,loader:"jsx",resolveDir:process.cwd()}));
}};
beforeAll(async()=>{
  const r=await build({stdin:{contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';
    import Reports from '@/app/(app)/reports/ReportsView';import Sentinel from '@/app/(app)/dashboard/SentinelCard';
    const items=Array.from({length:8},(_,i)=>({kind:'sleeping',customerId:'c'+i,customerName:'客户'+i,ownerName:'我',reason:'30天没跟进',score:10}));
    createRoot(document.getElementById('root')).render(<App>
      <Reports trend={[{label:'10-01',amount:0,count:0},{label:'10-02',amount:100,count:1}]} 明细={{}} bySales={[]} byChannelOwner={[]} byChannel={[]} byAttribution={[]} total={{amount:100,count:1}} 未来={{amount:9900,count:1}} 口径="测试月" 币种="CNY" 币种们={[]}/>
      <Sentinel items={items} total={21} aiEnabled={false}/>
    </App>);`,loader:"tsx",resolveDir:process.cwd()},bundle:true,write:false,format:"iife",jsx:"automatic",alias:{"@":path.resolve("src")},define:{"process.env.NODE_ENV":'"production"'},plugins:[plugin],logLevel:"silent"});
  bundle=r.outputFiles[0].text;browser=await chromium.launch();
},120_000);
afterAll(async()=>{await browser?.close()});
it("最佳周期显示实际金额、未来排除提示和盯盘总数/完整入口可见",async()=>{
  const page=await browser.newPage();page.setDefaultTimeout(5000);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.route("http://stats.test/**",r=>r.fulfill({contentType:"text/html",body:"<meta charset='utf-8'><div id='root'></div>"}));
  await page.goto("http://stats.test");await page.addScriptTag({content:bundle});
  const best=page.locator('.stat-card').filter({hasText:"最佳周期"});await best.waitFor();
  expect(await best.innerText()).toMatch(/100/);expect(await best.innerText()).toContain("10-02");
  await page.getByText(/未计入历史合计、趋势和最佳周期/).waitFor();
  await page.getByText("21 位需要跟进，先显示 8 位",{exact:true}).waitFor();
  expect(await page.getByRole("link",{name:"查看全部 21 位"}).getAttribute("href")).toBe("/follow-ups/watchlist?scope=team");
  expect(errors).toEqual([]);await page.close();
});
