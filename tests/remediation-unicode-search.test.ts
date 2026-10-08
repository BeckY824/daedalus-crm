import {afterAll,afterEach,beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({user:{id:"acct_unicode",name:"QA",email:"unicode@qa.local",role:"ADMIN",title:"管理员"}}));
vi.mock("next/cache",()=>({revalidatePath(){}}));
vi.mock("@/lib/auth",()=>({requireUser:async()=>state.user}));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {defaultClient as db,prisma} from "@/lib/prisma";
import {忘掉限定} from "@/lib/team-scope";
import {resetDb} from "./reset";
import {客户筛选条件} from "@/app/(app)/customers/query";
import {搜客户} from "@/app/(app)/customers/[id]/pick";
import {导出客户} from "@/app/(app)/customers/export-action";
import {TOOLS,type ToolContext} from "@/lib/agent/tools";
import {DEFAULT_BUSINESS} from "@/lib/business-config";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"crm-unicode-"));
const search=async(keyword:string)=>prisma.customer.findMany({where:await 客户筛选条件({keyword}),select:{id:true},orderBy:{id:"asc"}});
beforeEach(async()=>{
 vi.stubEnv("DESKTOP_LOCAL","0");vi.stubEnv("MULTI_TENANT","0");忘掉限定();state.user.role="ADMIN";await resetDb();await db.user.create({data:{...state.user,password:"qa"}});
 await db.customer.createMany({data:[{id:"german",name:"MÜLLER",school:"STRAẞE"},{id:"russian",name:"МОСКВА"},{id:"literal",name:"字面档案"},{id:"decoy",name:"另一个档案"}].map(row=>({...row,phone:"",salesOwnerId:state.user.id}))});
 await db.contact.create({data:{customerId:"literal",name:"ЖАН_100%[A]*?",phone:"",isPrimary:true}});
 await db.tradeOrder.create({data:{customerId:"literal",ownerId:state.user.id,no:"PI_100%[A]*?",amount:10}});
 await db.customerExtra.create({data:{customerId:"literal",country:"ÖSTERREICH"}});
 await db.contact.create({data:{customerId:"decoy",name:"ЖАНx100分Axyz",phone:""}});
});
afterEach(()=>{忘掉限定();vi.unstubAllEnvs()});
afterAll(async()=>{await db.$disconnect();fs.rmSync(dir,{recursive:true,force:true})});
it("德文、俄文及大写ẞ小写ß双向一致，导出和AI沿用同一搜索范围",async()=>{
 expect(await search("müller")).toEqual([{id:"german"}]);expect(await search("straße")).toEqual([{id:"german"}]);expect(await search("москва")).toEqual([{id:"russian"}]);
 await db.customer.update({where:{id:"german"},data:{name:"müller"}});expect(await search("MÜLLER")).toEqual([{id:"german"}]);
 const exp=await 导出客户({keyword:"москва"});expect(exp.ok&&exp.rows.map(row=>row.id)).toEqual(["russian"]);
 const ctx:ToolContext={userId:state.user.id,userName:"QA",b:DEFAULT_BUSINESS,recordOffset:0,proposals:[]};
 const ai=await TOOLS.find(t=>t.name==="search_customers")!.run({query:"москва"},ctx);expect(JSON.stringify(ai.data)).toContain("МОСКВА");
});
it("联系人、外贸资料、订单号的百分号下划线和GLOB字符均按字面，不漏关联也不误匹配",async()=>{
 for(const keyword of ["жан_100%[a]*?","pi_100%[a]*?","österreich","[A]","*?","100%"]){expect(await search(keyword),keyword).toEqual([{id:"literal"}])}
 expect(await search("x' OR 1=1 --")).toEqual([]);expect(await db.customer.count()).toBe(4);
});
it("按需选择也支持Unicode大小写、规整号码和百分号字面，不扩大到关联联系人",async()=>{
 await db.customer.update({where:{id:"german"},data:{phone:"13800001111"}});
 expect((await 搜客户("müller")).map(c=>c.id)).toEqual(["german"]);expect((await 搜客户("138 0000")).map(c=>c.id)).toEqual(["german"]);
 expect(await 搜客户("100%")).toEqual([]);expect(await 搜客户("жан")).toEqual([]);
});
it("搜索后的筛选与导入批次同时生效，真实业务员权限不泄漏不可见客户",async()=>{
 const other=await db.user.create({data:{email:"unicode-other",name:"同事",role:"SALES",password:"qa"}});
 await db.customer.create({data:{id:"hidden",name:"MÜLLER",phone:"",salesOwnerId:other.id}});
 const batch=await db.importBatch.create({data:{fileName:"QA.csv",userId:state.user.id,userName:"QA"}});
 await db.importRow.create({data:{batchId:batch.id,customerId:"german",kind:"create"}});
 expect(await prisma.customer.findMany({where:await 客户筛选条件({keyword:"müller",batch:batch.id}),select:{id:true}})).toEqual([{id:"german"}]);
 await db.user.update({where:{id:state.user.id},data:{role:"SALES"}});state.user.role="SALES";
 fs.writeFileSync(path.join(dir,".cloud.json"),JSON.stringify({baseUrl:"http://fake",token:"dk_qa",accountId:"unicode",name:"QA",contact:state.user.email,models:[],loggedAt:new Date().toISOString()}));
 fs.writeFileSync(path.join(dir,".team.json"),JSON.stringify({teamId:"unicode-team",key:"k".repeat(43),joinSecret:"qa",device:"unicode-device",pulled:0}));
 vi.stubEnv("DESKTOP_LOCAL","1");vi.stubEnv("CRM_DATA_DIR",dir);忘掉限定();
 expect(await search("müller")).toEqual([{id:"german"}]);expect((await 搜客户("müller")).map(c=>c.id)).toEqual(["german"]);
});
it("20001项匹配不会被SQL参数上限截断，计数/分页/关系筛选正确",async()=>{
 await db.customer.createMany({data:Array.from({length:20001},(_,i)=>({id:`unicode-${String(i).padStart(5,"0")}`,name:"MÜLLER",phone:"",salesOwnerId:state.user.id}))});
 const where=await 客户筛选条件({keyword:"müller"});expect(await prisma.customer.count({where})).toBe(20002);
 expect(await prisma.customer.findMany({where,take:10,skip:20000,orderBy:{id:"asc"},select:{id:true}})).toHaveLength(2);
 expect(await prisma.followUp.count({where:{customer:where}})).toBe(0);
 const batch=await db.importBatch.create({data:{fileName:"large.csv",userId:state.user.id,userName:"QA"}});
 await db.importRow.createMany({data:Array.from({length:20001},(_,i)=>({batchId:batch.id,customerId:`unicode-${String(i).padStart(5,"0")}`,kind:"create"}))});
 const batchWhere=await 客户筛选条件({keyword:"müller",batch:batch.id});expect(await prisma.customer.count({where:batchWhere})).toBe(20001);
 expect(await prisma.customer.findMany({where:batchWhere,take:10,skip:20000,orderBy:{id:"asc"},select:{id:true}})).toEqual([{id:"unicode-20000"}]);
});
