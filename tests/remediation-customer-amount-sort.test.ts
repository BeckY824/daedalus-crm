import {afterAll,afterEach,beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({user:{id:"acct_amount",name:"QA",email:"amount@qa.local",role:"ADMIN",title:"管理员"}}));
vi.mock("next/cache",()=>({revalidatePath(){}}));
vi.mock("@/lib/auth",()=>({requireUser:async()=>state.user}));
vi.mock("@/lib/llm",()=>({llmEnabled:async()=>false}));
vi.mock("@/app/(app)/customers/CustomersView",()=>({default:()=>null}));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {忘掉限定} from "@/lib/team-scope";
import {defaultClient as db} from "@/lib/prisma";
import {resetDb} from "./reset";
import {客户金额分页} from "@/app/(app)/customers/query";
import Page from "@/app/(app)/customers/page";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"crm-amount-sort-"));
beforeEach(async()=>{
 vi.stubEnv("DESKTOP_LOCAL","0");vi.stubEnv("MULTI_TENANT","0");忘掉限定();state.user.role="ADMIN"; await resetDb();await db.user.create({data:{...state.user,password:"qa"}});
 await db.customer.createMany({data:Array.from({length:25},(_,i)=>({id:`amount-${String(i).padStart(3,"0")}`,name:`客户${i}`,school:i<15?"组A":"组B",phone:`138${String(i).padStart(8,"0")}`,salesOwnerId:state.user.id,createdAt:new Date(Date.UTC(2026,0,26-i))}))});
 await db.contract.createMany({data:Array.from({length:25},(_,i)=>({id:`contract-${i}`,customerId:`amount-${String(i).padStart(3,"0")}`,amount:i+1,signedAt:new Date("2026-01-01")}))});
});
afterEach(()=>{忘掉限定();vi.unstubAllEnvs()});
afterAll(async()=>{await db.$disconnect();fs.rmSync(dir,{recursive:true,force:true})});
it("全范围金额降序后再分页，第二页不重复；筛选先于排序",async()=>{
 const first=await Page({searchParams:Promise.resolve({sort:"amount-desc",sortCurrency:"CNY",pageSize:"10"})});
 const second=await Page({searchParams:Promise.resolve({sort:"amount-desc",sortCurrency:"CNY",pageSize:"10",page:"2"})});
 expect(first.props.rows.map((r:{id:string})=>r.id)).toEqual(Array.from({length:10},(_,i)=>`amount-${String(24-i).padStart(3,"0")}`));
 expect(second.props.rows.map((r:{id:string})=>r.id)).toEqual(Array.from({length:10},(_,i)=>`amount-${String(14-i).padStart(3,"0")}`));
 const filtered=await Page({searchParams:Promise.resolve({sort:"amount-desc",keyword:"组A",pageSize:"10"})});
 expect(filtered.props.total).toBe(15);expect(filtered.props.rows[0].id).toBe("amount-014");
});
it("按单一币种精确金额排序，美元不与人民币相加，零金额使用稳定次序",async()=>{
 await db.contractMoney.createMany({data:[{contractId:"contract-0",currency:"USD",amountExact:100.51},{contractId:"contract-1",currency:"USD",amountExact:100.49}]});
 const usd=await Page({searchParams:Promise.resolve({sort:"amount-desc",sortCurrency:"USD",pageSize:"10"})});
 expect(usd.props.rows.slice(0,2).map((r:{id:string})=>r.id)).toEqual(["amount-000","amount-001"]);
 const cny=await Page({searchParams:Promise.resolve({sort:"amount-asc",sortCurrency:"CNY",pageSize:"10"})});
 expect(cny.props.rows.slice(0,2).map((r:{id:string})=>r.id)).toEqual(["amount-000","amount-001"]);
 expect(usd.props.排序币种).toBe("USD");
});
it("B6 删除末页后实际跳转有效URL，并保留搜索、排序和页大小",async()=>{
 const sp={keyword:"客户",sort:"amount-desc",sortCurrency:"CNY",pageSize:"10",page:"3"};
 const last=await Page({searchParams:Promise.resolve(sp)});expect(last.props.rows).toHaveLength(5);
 await db.customer.deleteMany({where:{id:{in:last.props.rows.map((r:{id:string})=>r.id)}}});
 const target="/customers?"+new URLSearchParams({...sp,page:"2"});
 await expect(Page({searchParams:Promise.resolve(sp)})).rejects.toMatchObject({digest:expect.stringContaining(target)});
 const valid=await Page({searchParams:Promise.resolve({...sp,page:"2"})});expect(valid.props.page).toBe(2);expect(valid.props.rows).toHaveLength(10);
});
it("坏页码/末页删除越界回到有效页；非法排序及币种安全回退",async()=>{
 await expect(Page({searchParams:Promise.resolve({page:"abc",pageSize:"bad",sort:"raw-sql",sortCurrency:"BAD!"})})).rejects.toMatchObject({digest:expect.stringContaining("page=1")});
 const bad=await Page({searchParams:Promise.resolve({page:"1",pageSize:"bad",sort:"raw-sql",sortCurrency:"BAD!"})});
 expect(bad.props.page).toBe(1);expect(bad.props.pageSize).toBe(20);expect(bad.props.金额排序).toBe("");expect(bad.props.排序币种).toBe("CNY");
 await db.customer.deleteMany({where:{id:{gte:"amount-020"}}});
 await expect(Page({searchParams:Promise.resolve({page:"3",pageSize:"10"})})).rejects.toMatchObject({digest:expect.stringContaining("page=2")});
 const last=await Page({searchParams:Promise.resolve({page:"2",pageSize:"10"})});expect(last.props.page).toBe(2);expect(last.props.rows).toHaveLength(10);
});
it.each(["abc","0","-1","999","","01"])("B6 非规范页码 %s 归一化且不丢筛选",async page=>{
 const sp={keyword:"组B",pageSize:"10",page};
 await expect(Page({searchParams:Promise.resolve(sp)})).rejects.toMatchObject({digest:expect.stringContaining("/customers?"+new URLSearchParams({...sp,page:"1"}))});
});
it("排序扫描与最终页均受业务员限定，不能用对方大金额挤掉自己的结果",async()=>{
 const other=await db.user.create({data:{name:"同事",email:"amount-other",password:"qa",role:"SALES"}});
 await db.customer.create({data:{id:"hidden-amount",name:"不应可见",phone:"13899999999",salesOwnerId:other.id,contracts:{create:{amount:999999,signedAt:new Date()}}}});
 await db.user.update({where:{id:state.user.id},data:{role:"SALES"}});state.user.role="SALES";
 fs.writeFileSync(path.join(dir,".cloud.json"),JSON.stringify({baseUrl:"http://fake",token:"dk_qa",accountId:"amount",name:"QA",contact:state.user.email,models:[],loggedAt:new Date().toISOString()}));
 fs.writeFileSync(path.join(dir,".team.json"),JSON.stringify({teamId:"amount-team",key:"k".repeat(43),joinSecret:"qa",device:"amount-device",pulled:0}));
 vi.stubEnv("DESKTOP_LOCAL","1");vi.stubEnv("CRM_DATA_DIR",dir);忘掉限定();
 const page=await Page({searchParams:Promise.resolve({sort:"amount-desc",pageSize:"10"})});
 expect(page.props.total).toBe(25);expect(page.props.rows.map((r:{id:string})=>r.id)).not.toContain("hidden-amount");expect(page.props.rows[0].id).toBe("amount-024");
});

it("超过1000客户按有界批次扫描，最大金额在末批仍排第一，同额稳定且无跨页重复",async()=>{
 await db.customer.createMany({data:Array.from({length:1001},(_,i)=>({id:`large-${String(i).padStart(4,"0")}`,name:"大库",phone:"",salesOwnerId:state.user.id,createdAt:new Date("2026-01-01")}))});
 await db.contract.create({data:{customerId:"large-1000",amount:5000,signedAt:new Date("2026-01-01")}});
 const spy=vi.spyOn(db.customer,"findMany");
 try{
  const where={name:"大库"}; const first=await 客户金额分页(where,"amount-desc","CNY",1,10); const second=await 客户金额分页(where,"amount-desc","CNY",2,10);
  expect(first[0].id).toBe("large-1000");expect(first[1].id).toBe("large-0999");expect(new Set([...first,...second].map((r:{id:string})=>r.id)).size).toBe(20);
  expect(spy.mock.calls.filter(([args])=>args?.take===1000)).toHaveLength(4);
 }finally{spy.mockRestore()}
});
