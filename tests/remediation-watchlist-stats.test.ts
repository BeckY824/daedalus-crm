import { beforeEach, afterEach, afterAll, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
vi.mock("@/lib/llm", () => ({ llmEnabled: async () => true, listModelOptions: async () => [] }));
vi.mock("@/lib/onboarding", () => ({ 要选模版: async () => false }));
vi.mock("@/lib/pool-db", () => ({ 自动掉公海: async () => {} }));
vi.mock("@/app/(app)/dashboard/threads", () => ({ 读对话: async () => null }));
vi.mock("@/app/(app)/dashboard/HomeChat", () => ({ default: () => null }));
vi.mock("@/app/(app)/dashboard/DashboardView", () => ({ default: () => null }));
vi.mock("@/components/ui", async () => {
  const { createElement } = await import("react");
  return { PageHead: (p: {title: string; subtitle: string}) => createElement("header", null, p.title, p.subtitle) };
});
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: (p: object) => createElement("a", p) };
});
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { loadWatchlistPage } from "@/lib/sentinel-data";
import { dayjs } from "@/lib/utils";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { TOOLS } from "@/lib/agent/tools";
import { 认意图 } from "@/lib/agent/intents";
import DashboardPage from "@/app/(app)/dashboard/page";
import Board from "@/app/(app)/dashboard/Board";
import WatchlistPage from "@/app/(app)/follow-ups/watchlist/page";
import { 加载复盘 } from "@/app/(app)/overview/data";
let otherId: string; let customerId: string;
beforeEach(async () => {
  vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date("2026-10-08T12:00:00+08:00")); await resetDb();
  state.user.id = (await prisma.user.create({data:{email:"stats-me",password:"x",name:"QA",role:"ADMIN"}})).id;
  otherId = (await prisma.user.create({data:{email:"stats-other",password:"x",name:"同事",role:"SALES"}})).id;
  customerId = (await prisma.customer.create({data:{name:"QA客户",phone:"",salesOwnerId:state.user.id}})).id;
});
afterEach(() => vi.useRealTimers()); afterAll(async () => {await prisma.$disconnect()});
async function sleepers() {
  for (const [ownerId, count, prefix] of [[state.user.id,21,"我的"],[otherId,4,"同事"]] as const)
    await prisma.customer.createMany({data:Array.from({length:count},(_,i)=>({name:`${prefix}${i}`,phone:"",salesOwnerId:ownerId,createdAt:new Date("2026-08-01")}))});
}
it("总数先统计再截取；首页21位、看板团队25位与完整分页一致",async()=>{
  await sleepers();
  const mine=await loadWatchlistPage(dayjs(),{ownerId:state.user.id});
  expect(mine.total).toBe(21);expect(mine.items).toHaveLength(8);
  expect((await DashboardPage({searchParams:Promise.resolve({})})).props.context).toContain("21 位");
  const board=(await Board({})).props;expect(board.watchlistTotal).toBe(25);expect(board.watchlist).toHaveLength(8);
  const first=await loadWatchlistPage(dayjs(),{ownerId:state.user.id},0,20);
  const last=await loadWatchlistPage(dayjs(),{ownerId:state.user.id},20,20);
  expect(new Set([...first.items,...last.items].map(x=>x.customerId)).size).toBe(21);
  const markup=renderToStaticMarkup(await WatchlistPage({searchParams:Promise.resolve({scope:"mine",page:"999999"})}));
  expect(markup).toContain("共 21 位");expect(markup).toContain("第 2 / 2 页");expect(markup).not.toContain("同事0");expect(markup).toContain("上一页");
});
it("AI默认本人21位，明确团队才返回25位；不把前12误称全部",async()=>{
  await sleepers();const t=TOOLS.find(t=>t.name==="get_watchlist")!;
  const ctx={userId:state.user.id,userName:"QA",b:DEFAULT_BUSINESS,recordOffset:0,proposals:[]};
  const mine=await t.run({},ctx);expect(mine.data).toMatchObject({总数:21,显示:12,范围:"我名下"});expect(JSON.stringify(mine.data)).not.toContain('"name":"同事');
  expect((await t.run({scope:"team"},ctx)).data).toMatchObject({总数:25,显示:12,范围:"当前权限内团队"});
  expect((await t.run({scope:"bad"},ctx)).data).toHaveProperty("error");
  expect(认意图("看看全团队盯盘清单")?.调用[0].args).toEqual({scope:"team"});
  expect(认意图("看我名下盯盘清单")?.调用[0].args).toEqual({});
});
it("客户全流失仍有历史数据，不显示无数据的空库页",async()=>{
  await prisma.customer.updateMany({data:{followStatus:"已流失"}});
  expect((await Board({})).props.空库).toBe(false);
  await prisma.customer.deleteMany();expect((await Board({})).props.空库).toBe(true);
});
it("未来记录单独列示，不填进今日后的压缩柱、不参与最佳周期/历史合计",async()=>{
  await prisma.contract.createMany({data:[{customerId,amount:100,signedAt:new Date("2026-10-02T10:00:00+08:00")},{customerId,amount:9900,signedAt:new Date("2026-10-20T10:00:00+08:00")} ]});
  const data=await 加载复盘(new Date("2026-10-01T00:00:00+08:00"),new Date("2026-11-01T00:00:00+08:00"),"day");
  expect(data.total).toEqual({amount:100,count:1});expect(data.未来).toEqual({amount:9900,count:1});expect(data.trend.map(x=>x.label)).toEqual(Array.from({length:8},(_,i)=>`10-0${i+1}`));
  expect(data.trend.reduce((a,b)=>a+b.amount,0)).toBe(100);expect(Object.values(data.明细).flat()).toHaveLength(1);
  expect(data.bySales[0].amount).toBe(100);
  expect((await Board({})).props.stats.签约本月).toEqual([{币种:"CNY",合计:100}]);
  expect((await DashboardPage({searchParams:Promise.resolve({})})).props.信号.本月签约).toEqual([{币种:"CNY",合计:100}]);
});

it("跨币种总额同样排除未来记录，未来独有币种仍可切换核对",async()=>{
  await prisma.contract.create({data:{customerId,amount:100,signedAt:new Date("2026-10-02")}});
  const future=await prisma.contract.create({data:{customerId,amount:9999,signedAt:new Date("2026-10-20")}});
  await prisma.contractMoney.create({data:{contractId:future.id,currency:"USD",amountExact:9999.25}});
  const data=await 加载复盘(new Date("2026-10-01"),new Date("2026-11-01"),"day",{想看:"USD",本位币:"CNY"});
  expect(data.total).toEqual({amount:0,count:0});expect(data.未来).toEqual({amount:9999.25,count:1});
  expect(data.币种们).toEqual([{币种:"CNY",合计:100},{币种:"USD",合计:0}]);expect(data.trend.every(t=>t.amount===0)).toBe(true);
});
