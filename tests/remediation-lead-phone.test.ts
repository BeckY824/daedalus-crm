import {beforeEach,afterEach,afterAll,it,expect,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const state=vi.hoisted(()=>({user:{id:"acct_phone-scope",name:"QA",email:"phone@local",role:"ADMIN",title:"管理员"}}));
vi.mock("next/cache",()=>({revalidatePath(){}}));
vi.mock("@/lib/auth",()=>({requireUser:async()=>state.user}));
vi.mock("@/app/(app)/leads/LeadsView",()=>({default:()=>null}));
import {忘掉限定} from "@/lib/team-scope";
import {prisma} from "@/lib/prisma";
import {resetDb} from "./reset";
import {saveLead} from "@/app/(app)/leads/actions";
import {saveChannel} from "@/app/(app)/channels/actions";
import LeadsPage from "@/app/(app)/leads/page";
import {客户关键词条件} from "@/lib/search-keyword";
import {maskPhone} from "@/lib/utils";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"crm-phone-scope-"));
beforeEach(async()=>{vi.stubEnv("DESKTOP_LOCAL","0");vi.stubEnv("MULTI_TENANT","0");state.user.role="ADMIN";忘掉限定();await resetDb();await prisma.user.create({data:{id:"acct_phone-scope",name:"QA",email:"phone@local",password:"x",role:"ADMIN"}})});
afterEach(()=>{忘掉限定();vi.unstubAllEnvs()});
afterAll(async()=>{await prisma.$disconnect();fs.rmSync(dir,{recursive:true,force:true})});
const lead=(phone:string|null,id?:string,remark:string|null=null)=>saveLead({id,name:"QA线索",status:"待跟进",source:"其他",phone,remark});
const channel=(phone:string|null,id?:string,remark:string|null=null)=>saveChannel({id,name:"QA渠道",phone,remark});
it("线索与渠道新增电话共用客户规范：国家码、全角、海外、座机分机，原附注不丢",async()=>{
 for(const [raw,want] of [["＋８６ １３８－００００－１１１１","13800001111"],["+1 (415) 555-0132","+14155550132"],["010-12345678 ext 801","01012345678转801"],["13800001111（微信同号）","13800001111"],["13800001111 13900002222","13800001111"]]){
  await prisma.lead.deleteMany();await prisma.channel.deleteMany();expect(await lead(raw)).toMatchObject({ok:true});expect(await channel(raw)).toMatchObject({ok:true});
  const l=await prisma.lead.findFirstOrThrow(),c=await prisma.channel.findFirstOrThrow();expect(l.phone).toBe(want);expect(c.phone).toBe(want);
  if(raw.includes("微信")||raw.includes("1390000")){expect(l.remark).toContain(raw);expect(c.remark).toContain(raw)}
 }
});
it("旧号码原样和准确打码返回可编辑，未知打码/非法新号拒绝且无写入",async()=>{
 const l=await prisma.lead.create({data:{name:"QA线索",phone:"旧号待核对",ownerId:"acct_phone-scope"}}),c=await prisma.channel.create({data:{name:"QA渠道",phone:"旧号待核对",channelOwnerId:"acct_phone-scope"}});
 expect(await lead(l.phone,l.id,"改备注")).toMatchObject({ok:true});expect(await channel(c.phone,c.id,"改备注")).toMatchObject({ok:true});
 await prisma.lead.update({where:{id:l.id},data:{phone:"+86 138 0000 1111"}});await prisma.channel.update({where:{id:c.id},data:{phone:"+86 138 0000 1111"}});
 expect(await lead(maskPhone("+86 138 0000 1111"),l.id)).toMatchObject({ok:true});expect(await channel(maskPhone("+86 138 0000 1111"),c.id)).toMatchObject({ok:true});
 expect((await prisma.lead.findUniqueOrThrow({where:{id:l.id}})).phone).toBe("+86 138 0000 1111");
 for(const raw of ["138****9999","138O0001111","名字"]){expect(await lead(raw,l.id)).toMatchObject({ok:false});expect(await channel(raw,c.id)).toMatchObject({ok:false})}
 expect((await prisma.channel.findUniqueOrThrow({where:{id:c.id}})).phone).toBe("+86 138 0000 1111");
});
it("线索和客户号码搜索兼容旧分隔符/全角与完整国家码，字面特殊词不扩大匹配",async()=>{
 await prisma.lead.createMany({data:[{id:"old-phone",name:"旧号码",phone:"＋８６ １３８－００００－１１１１",ownerId:"acct_phone-scope"},{id:"literal-lead",name:"Firma ÄÖ 100%_[QA]*?",phone:"13900002222",ownerId:"acct_phone-scope"},{id:"wrong-lead",name:"Firma äö 100XYZQa",phone:"",ownerId:"acct_phone-scope"}]});
 await prisma.customer.create({data:{id:"old-customer",name:"旧号码",phone:"＋８６ １３８－００００－１１１１",salesOwnerId:"acct_phone-scope"}});
 for(const keyword of ["138 0000","＋８６ １３８－００００－１１１１"]){const p=await LeadsPage({searchParams:Promise.resolve({keyword})});expect(p.props.rows.map((r:{id:string})=>r.id)).toEqual(["old-phone"]);expect(await prisma.customer.findMany({where:await 客户关键词条件(keyword),select:{id:true}})).toEqual([{id:"old-customer"}])}
 const p=await LeadsPage({searchParams:Promise.resolve({keyword:"firma äö 100%_[QA]*?"})});expect(p.props.rows.map((r:{id:string})=>r.id)).toEqual(["literal-lead"]);
});

it("关键词原生ID查询不绕过真实业务员限定，同词同号同事资料仍不可见",async()=>{
 const other=await prisma.user.create({data:{name:"同事",email:"phone-other",password:"x"}});
 await prisma.lead.createMany({data:[{id:"own-lead",name:"相同QA",phone:"13800001111",ownerId:state.user.id},{id:"hidden-lead",name:"相同QA",phone:"13800001111",ownerId:other.id}]});
 await prisma.user.update({where:{id:state.user.id},data:{role:"SALES"}});state.user.role="SALES";
 fs.writeFileSync(path.join(dir,".cloud.json"),JSON.stringify({baseUrl:"http://fake",token:"dk_qa",accountId:"phone-scope",name:"QA",contact:state.user.email,models:[],loggedAt:new Date().toISOString()}));fs.writeFileSync(path.join(dir,".team.json"),JSON.stringify({teamId:"phone-team",key:"k".repeat(43),joinSecret:"qa",device:"phone-device",pulled:0}));vi.stubEnv("DESKTOP_LOCAL","1");vi.stubEnv("CRM_DATA_DIR",dir);忘掉限定();
 for(const keyword of ["相同QA","＋８６ １３８００００１１１１"]){const p=await LeadsPage({searchParams:Promise.resolve({keyword})});expect(p.props.总数).toBe(1);expect(p.props.rows.map((r:{id:string})=>r.id)).toEqual(["own-lead"])}
});
