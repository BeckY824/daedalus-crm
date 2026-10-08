import {afterAll,afterEach,beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({user:{id:"acct_order_totals",name:"QA",email:"orders@qa.local",role:"ADMIN",title:"管理员"}}));
vi.mock("next/cache",()=>({revalidatePath(){}}));
vi.mock("@/lib/auth",()=>({requireUser:async()=>state.user}));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {defaultClient as db} from "@/lib/prisma";
import {resetDb} from "./reset";
import {订单列表,订单详情} from "@/lib/order-db";
import {供应商详情} from "@/lib/supplier-db";
import {订单的钱} from "@/lib/order";
import {忘掉限定} from "@/lib/team-scope";
import {TOOLS} from "@/lib/agent/tools";
import {DEFAULT_BUSINESS} from "@/lib/business-config";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"crm-order-totals-"));
beforeEach(async()=>{vi.stubEnv("DESKTOP_LOCAL","0");vi.stubEnv("MULTI_TENANT","0");忘掉限定();state.user.role="ADMIN";await resetDb();await db.user.create({data:{...state.user,password:"qa"}});await db.customer.create({data:{id:"order-totals-customer",name:"QA客户",phone:"",salesOwnerId:state.user.id}})});
afterEach(()=>{忘掉限定();vi.unstubAllEnvs()});afterAll(async()=>{await db.$disconnect();fs.rmSync(dir,{recursive:true,force:true})});
it("超过500/1000张订单仍全量，最旧的超期订单排在前，AI注明只展示30张",async()=>{
 await db.tradeOrder.createMany({data:Array.from({length:1001},(_,i)=>({id:`total-${String(i).padStart(4,"0")}`,no:`QA-${i}`,ownerId:state.user.id,customerId:"order-totals-customer",amount:i+1,currency:i%2?"USD":"CNY",createdAt:new Date(Date.UTC(2026,0,1,0,0,i))}))});
 await db.tradeOrderNode.create({data:{orderId:"total-0000",idx:1,name:"询盘",dueAt:new Date("2020-01-01"),status:"未开始"}});
 const spy=vi.spyOn(db.tradeOrder,"findMany");
 try{const rows=await 订单列表();expect(rows).toHaveLength(1001);expect(rows[0].id).toBe("total-0000");expect(new Set(rows.map(r=>r.id)).size).toBe(1001);expect(spy.mock.calls.every(([args])=>Number(args?.take)<=1000)).toBe(true)}finally{spy.mockRestore()}
 const ai=await TOOLS.find(t=>t.name==="list_orders")!.run({}, {userId:state.user.id,userName:"QA",b:DEFAULT_BUSINESS,recordOffset:0,proposals:[]});expect(ai.summary).toContain("1001 张订单");expect(ai.summary).toContain("列出");expect(ai.data).toHaveLength(30);
});
it("列表/详情/供应商销售额均跟真实签约精确金额，采购额独立保留，未收不读旧副本",async()=>{
 const supplier=await db.supplier.create({data:{name:"QA工厂"}});
 const contract=await db.contract.create({data:{customerId:"order-totals-customer",amount:251,signedAt:new Date("2026-02-01"),money:{create:{currency:"USD",amountExact:250.51}}}});
 const order=await db.tradeOrder.create({data:{no:"QA-MONEY",ownerId:state.user.id,customerId:"order-totals-customer",contractId:contract.id,amount:999,currency:"EUR",depositDue:100,depositPaid:30,balancePaid:20,purchase:{create:{supplierId:supplier.id,cost:1234,currency:"CNY"}}}});
 const row=(await 订单列表())[0], detail=(await 订单详情(order.id))!;
 expect([row.amount,row.currency,row.未收]).toEqual([250.51,"USD",200.51]);expect([detail.amount,detail.currency,订单的钱(detail).未收]).toEqual([250.51,"USD",200.51]);
 const purchase=(await 供应商详情(supplier.id))!.purchases[0];expect([purchase.amount,purchase.currency,purchase.cost,purchase.costCurrency]).toEqual([250.51,"USD",1234,"CNY"]);
 await db.tradeOrder.update({where:{id:order.id},data:{balancePaid:300}});expect((await 订单列表())[0].未收).toBe(0);
});
it("无对应签约的旧订单保留原金额币种，负责人筛选与真实业务员范围均生效",async()=>{
 const other=await db.user.create({data:{id:"other-orders",name:"同事",email:"other-orders",password:"qa",role:"SALES"}});
 const hidden=await db.customer.create({data:{name:"不应可见",phone:"",salesOwnerId:other.id}});
 await db.tradeOrder.createMany({data:[{id:"mine-order",no:"QA-OLD",ownerId:state.user.id,customerId:"order-totals-customer",amount:77.77,currency:"GBP"},{id:"hidden-order",no:"QA-HIDDEN",ownerId:other.id,customerId:hidden.id,amount:999,currency:"USD"}]});
 expect((await 订单列表({ownerId:state.user.id})).map(r=>[r.id,r.amount,r.currency])).toEqual([["mine-order",77.77,"GBP"]]);
 await db.user.update({where:{id:state.user.id},data:{role:"SALES"}});state.user.role="SALES";
 fs.writeFileSync(path.join(dir,".cloud.json"),JSON.stringify({baseUrl:"http://fake",token:"dk_qa",accountId:"order_totals",name:"QA",contact:state.user.email,models:[],loggedAt:new Date().toISOString()}));fs.writeFileSync(path.join(dir,".team.json"),JSON.stringify({teamId:"orders-team",key:"k".repeat(43),joinSecret:"qa",device:"orders-device",pulled:0}));vi.stubEnv("DESKTOP_LOCAL","1");vi.stubEnv("CRM_DATA_DIR",dir);忘掉限定();
 expect((await 订单列表()).map(r=>r.id)).toEqual(["mine-order"]);expect(await 订单详情("hidden-order")).toBeNull();
});
