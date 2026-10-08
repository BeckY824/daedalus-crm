import { afterAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ revalidatePath() {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "export-user", name: "导出测试", role: "ADMIN" }) }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 开始完整导出, 读取完整导出批次, 校验完整导出, 导出客户 } from "@/app/(app)/customers/export-action";

beforeEach(async () => {
  await resetDb();
  await prisma.user.create({ data: { id: "export-user", name: "导出测试", email: "export@local", password: "x", role: "ADMIN" } });
});
afterAll(() => prisma.$disconnect());

async function 收全(条件 = {}) {
  const start = await 开始完整导出(条件);
  const fingerprints: { 类别: "客户" | "跟进"; 指纹: string }[] = [];
  const customers: string[] = [], follows: string[] = [];
  for (const kind of ["客户", "跟进"] as const) {
    let cursor: string | undefined;
    do {
      const r = await 读取完整导出批次(条件, start.截止, kind, cursor);
      (kind === "客户" ? customers : follows).push(...r.rows.map((x) => x.id));
      expect(r.rows.length).toBeLessThanOrEqual(kind === "客户" ? 5000 : 10000);
      fingerprints.push({ 类别: kind, 指纹: r.指纹 });
      cursor = r.游标 ?? undefined;
    } while (cursor);
  }
  return { start, fingerprints, customers, follows };
}

it("W025：超过旧2万客户/5万跟进上限，分批无遗漏无重复且只含筛选客户", async () => {
  const at = new Date("2026-01-01");
  for (let i = 0; i < 20_002; i += 500) await prisma.customer.createMany({ data: Array.from({ length: Math.min(500, 20_002 - i) }, (_, k) => ({ id: `c${String(i+k).padStart(5, "0")}`, name: `客户${i+k}`, phone: String(i+k), school: i+k === 20001 ? "排除" : "目标", salesOwnerId: "export-user", createdAt: at, updatedAt: at })) });
  for (let i = 0; i < 50_002; i += 1000) await prisma.followUp.createMany({ data: Array.from({ length: Math.min(1000, 50_002 - i) }, (_, k) => ({ id: `f${String(i+k).padStart(5, "0")}`, customerId: i+k === 50001 ? "c20001" : `c${String((i+k)%20001).padStart(5,"0")}`, ownerId: "export-user", type: "PHONE", title: "回电", content: "内容", createdAt: at, updatedAt: at })) });
  const result = await 收全({ keyword: "目标" });
  expect(result.start).toMatchObject({ 客户数: 20001, 跟进数: 50001 });
  expect(new Set(result.customers).size).toBe(20001);
  expect(new Set(result.follows).size).toBe(50001);
  expect(result.customers).not.toContain("c20001");
  expect(result.follows).not.toContain("f50001");
  expect(await 校验完整导出({ keyword: "目标" }, result.start, result.fingerprints)).toEqual({ ok: true });
}, 120_000);

it("W025：旧有界出口只读取实际入选客户的跟进，未入选客户不挤占额度", async () => {
  const at = new Date("2026-01-01");
  for (let i = 0; i < 20001; i += 500) await prisma.customer.createMany({ data: Array.from({ length: Math.min(500, 20001-i) }, (_, k) => ({ id: `c${String(i+k).padStart(5,"0")}`, name: "客户", phone: String(i+k), salesOwnerId: "export-user", createdAt: i+k === 0 ? new Date("2019-01-01") : at, updatedAt: at })) });
  // c00000是旧入口未入选的最后一位，它的较新跟进不能把选中客户的旧跟进挤掉。
  for (let i = 0; i < 50001; i += 1000) await prisma.followUp.createMany({ data: Array.from({ length: Math.min(1000, 50001-i) }, (_, k) => ({ customerId: "c00000", ownerId: "export-user", type: "PHONE", title: "不应入选", content: String(i+k), occurredAt: new Date("2026-08-01") })) });
  await prisma.followUp.create({ data: { customerId: "c00001", ownerId: "export-user", type: "PHONE", title: "必须保留", content: "选中客户", occurredAt: at } });
  const r = await 导出客户({});
  expect(r).toMatchObject({ ok: true, 截断了: true, 跟进截断了: false, 跟进: [{ title: "必须保留" }] });
}, 120_000);

it.each(["修改", "删除", "外贸旁表", "跟进", "遗漏批次"])("完整导出拒绝%s造成的不一致", async (kind) => {
  const at = new Date("2026-01-01");
  await prisma.customer.create({ data: { id: "c", name: "客户", phone: "13800000001", salesOwnerId: "export-user", createdAt: at, updatedAt: at } });
  await prisma.followUp.create({ data: { id: "f", customerId: "c", ownerId: "export-user", type: "PHONE", title: "原值", content: "内容", createdAt: at, updatedAt: at } });
  const result = await 收全();
  if (kind === "修改") await prisma.customer.update({ where: { id: "c" }, data: { remark: "改动", updatedAt: new Date(Date.now()+10) } });
  if (kind === "删除") await prisma.customer.delete({ where: { id: "c" } });
  if (kind === "外贸旁表") await prisma.customerExtra.create({ data: { customerId: "c", source: "展会" } });
  if (kind === "跟进") await prisma.followUp.update({ where: { id: "f" }, data: { content: "新内容", updatedAt: new Date(Date.now()+10) } });
  if (kind === "遗漏批次") result.fingerprints.pop();
  await expect(校验完整导出({}, result.start, result.fingerprints)).rejects.toThrow(/变化|不完整/);
});

it("非法参数不查询；开始后新增的记录不混进既有批次", async () => {
  const result = await 收全();
  await prisma.customer.create({ data: { id: "new", name: "新", phone: "1", salesOwnerId: "export-user", createdAt: new Date(Date.now()+100) } });
  expect((await 读取完整导出批次({}, result.start.截止, "客户")).rows).toHaveLength(0);
  await expect(读取完整导出批次({}, "bad", "客户")).rejects.toThrow(/参数/);
  await expect(读取完整导出批次({}, result.start.截止, "客户", "x".repeat(129))).rejects.toThrow(/参数/);
});

it("单人导出全范围按ID隐藏负责人列，同名停用成员的末批旧归属必须保留",async()=>{
 const at=new Date("2026-01-01");
 await prisma.customer.createMany({data:Array.from({length:5001},(_,i)=>({id:`solo-${String(i).padStart(5,"0")}`,name:"导出客户",phone:"",salesOwnerId:"export-user",createdAt:at,updatedAt:at}))});
 expect(await 开始完整导出({})).toMatchObject({客户数:5001,隐藏负责人:true});
 const other=await prisma.user.create({data:{name:"导出测试",email:"inactive@local",password:"x",active:false}});
 await prisma.customer.update({where:{id:"solo-05000"},data:{channelOwnerId:other.id}});
 expect(await 开始完整导出({})).toMatchObject({隐藏负责人:false});
 await prisma.customer.update({where:{id:"solo-05000"},data:{channelOwnerId:null,salesOwnerId:other.id}});
 expect(await 开始完整导出({})).toMatchObject({隐藏负责人:false});
 expect(await 开始完整导出({salesOwnerId:"export-user"})).toMatchObject({客户数:5000,隐藏负责人:true});
 await prisma.user.update({where:{id:other.id},data:{active:true}});
 expect(await 开始完整导出({salesOwnerId:"export-user"})).toMatchObject({隐藏负责人:false});
 // Two active sales candidates must retain the dimension even if this filtered export is all one owner.
 await prisma.user.create({data:{name:"销售二",email:"active-sales@local",password:"x"}});
 expect(await 开始完整导出({salesOwnerId:"export-user"})).toMatchObject({隐藏负责人:false});
});

it("导出中成员范围变化不生成省略归属的旧结构文件",async()=>{
 await prisma.customer.create({data:{name:"客户",phone:"",salesOwnerId:"export-user"}});
 const result=await 收全();expect(result.start.隐藏负责人).toBe(true);
 await prisma.user.create({data:{name:"新销售",email:"new-sales@local",password:"x"}});
 await expect(校验完整导出({},result.start,result.fingerprints)).rejects.toThrow("负责人范围发生变化");
});
