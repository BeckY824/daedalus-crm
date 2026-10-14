import {afterAll,beforeAll,expect,it} from "vitest";
import {build,type Plugin} from "esbuild";
import path from "node:path";
import {chromium,type Browser} from "playwright";
let browser:Browser,bundle:string;
const plugin:Plugin={name:"order-list-boundaries",setup(b){
 b.onResolve({filter:/^next\/navigation$/},a=>({path:a.path,namespace:"nav"}));b.onLoad({filter:/.*/,namespace:"nav"},()=>({contents:"export const useRouter=()=>({push(){},refresh(){}});"}));
 b.onResolve({filter:/^next\/link$/},a=>({path:a.path,namespace:"link"}));b.onLoad({filter:/.*/,namespace:"link"},()=>({contents:"import React from 'react';export default ({href,children,...p})=>React.createElement('a',{href,...p},children);",resolveDir:process.cwd()}));
 b.onResolve({filter:/^@\/lib\/features$/},a=>({path:a.path,namespace:"features"}));b.onLoad({filter:/.*/,namespace:"features"},()=>({contents:"export const 订单节点=window.__nodes;"}));
 b.onResolve({filter:/EmptyState$/},a=>({path:a.path,namespace:"empty"}));b.onLoad({filter:/.*/,namespace:"empty"},()=>({contents:"export default ()=>null;"}));
}};
beforeAll(async()=>{
 bundle=(await build({stdin:{contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{App,ConfigProvider}from'antd';import zhCN from'antd/locale/zh_CN';import View from'@/app/(app)/orders/OrdersView';
 const rows=[{id:'one',no:'QA-ONE',customerId:'c1',customerName:'客户甲',ownerId:'u',ownerName:'QA',amount:100,currency:'CNY',payment:'T/T 100%',supplier:'QA工厂甲',confirmedAt:'2026-02-01',createdAt:'2026-02-01',nodes:[{idx:1,name:'询盘',dueAt:null,status:'未开始'}],当前:{idx:1,name:'询盘'},超期:0,进度:0,未收:50},{id:'two',no:'QA-TWO',customerId:'c2',customerName:'客户乙',ownerId:'u',ownerName:'QA',amount:200,currency:'USD',payment:'L/C',supplier:'QA工厂乙',confirmedAt:'2026-03-01',createdAt:'2026-03-01',nodes:[],当前:null,超期:0,进度:100,未收:70}];
 createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App><View rows={rows} users={[]} filters={{ownerId:''}}/></App></ConfigProvider>);
 `,loader:"tsx",resolveDir:process.cwd()},bundle:true,write:false,format:"iife",jsx:"automatic",alias:{"@":path.resolve("src")},define:{"process.env.NODE_ENV":'"production"'},plugins:[plugin],logLevel:"silent"})).outputFiles[0].text;
 browser=await chromium.launch();
});
afterAll(async()=>{await browser?.close()});
async function open(nodes:boolean){const page=await browser.newPage();page.setDefaultTimeout(5000);await page.route("http://orders.test/**",r=>r.fulfill({contentType:"text/html",body:"<meta charset='utf-8'><div id='root'></div>"}));await page.goto("http://orders.test");await page.evaluate(value=>Reflect.set(window,"__nodes",value),nodes);await page.addScriptTag({content:bundle});await page.locator(".list-sum").waitFor();return page}
it("轻量版显示全范围币种分开合计和三列，不暴露节点/收款操作",async()=>{const page=await open(false);try{
 const total=await page.locator(".list-sum").innerText();expect(total).toContain("全部筛选结果 · 共 2 单");expect(total).toMatch(/100/);expect(total).toMatch(/200/);expect(total).not.toContain("300");expect(total).not.toContain("未收");
 for(const name of ["付款方式","供应商","订单确认时间"])await page.getByRole("columnheader",{name,exact:true}).waitFor();expect(await page.locator(".ord-cells").count()).toBe(0);
}finally{await page.close()}});
it("节点版有相同金额合计和未收，列设置可打开付款/供应商/确认时间",async()=>{const page=await open(true);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));try{
 const total=await page.locator(".list-sum").innerText();expect(total).toContain("共 2 单");expect(total).toContain("未收");expect(total).toMatch(/50/);expect(total).toMatch(/70/);
 await page.getByRole("button",{name:"选择要显示的列"}).click();for(const name of ["付款方式","供应商","订单确认时间"])await page.getByRole("checkbox",{name,exact:true}).check();await page.getByRole("button",{name:"选择要显示的列"}).click();
 await page.locator('tr[data-row-key="one"]').getByText("QA工厂甲",{exact:true}).waitFor();await page.locator('tr[data-row-key="one"]').getByText("T/T 100%",{exact:true}).waitFor();await page.getByRole("columnheader",{name:"未收",exact:true}).getByText("未收",{exact:true}).hover();await page.getByText("订单金额减去定金实收和尾款实收，最低为0；按订单币种计算",{exact:true}).waitFor();expect(errors).toEqual([]);
}finally{await page.close()}});
