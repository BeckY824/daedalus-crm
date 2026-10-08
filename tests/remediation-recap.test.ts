import { beforeEach, afterEach, afterAll, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { TOOLS } from "@/lib/agent/tools";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { 认意图 } from "@/lib/agent/intents";
import { completePlan } from "@/app/(app)/customers/[id]/actions";
const tool = (name: string) => TOOLS.find(x => x.name === name)!;
const ctx = () => ({ userId: state.user.id, userName: "QA", b: DEFAULT_BUSINESS, recordOffset: 0, proposals: [] });
let customerId: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-31T12:00:00+08:00")); await resetDb();
  state.user.id = (await prisma.user.create({ data: { email: "qa-recap", name: "QA", password: "x", role: "ADMIN" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "QA客户", phone: "", salesOwnerId: state.user.id, createdAt: new Date("2026-01-01") } })).id;
});
afterEach(() => vi.useRealTimers()); afterAll(async () => { await prisma.$disconnect(); });
it("本月快捷意图使用自然月，不是固定30天", () => {
  expect(认意图("这个月我跟了谁")?.调用[0].args).toEqual({ period: "this_month" });
});
it("本月范围含10月1日，排除9月30日与未来11月跟进及签约", async () => {
  for (const occurredAt of ["2026-09-30T23:59:00+08:00", "2026-10-01T00:00:00+08:00", "2026-10-31T11:00:00+08:00", "2026-11-01T09:00:00+08:00"]) await prisma.followUp.create({ data: { customerId, ownerId: state.user.id, type: "PHONE", title: "", content: "跟进", status: "已完成", occurredAt: new Date(occurredAt) } });
  for (const signedAt of ["2026-10-01T00:00:00+08:00", "2026-11-01T09:00:00+08:00"]) await prisma.contract.create({ data: { customerId, amount: 100, signedAt: new Date(signedAt) } });
  const r = await tool("my_recap").run({ period: "this_month" }, ctx());
  expect(r.data).toMatchObject({ 跟进笔数: 2, 签约合计: "¥ 100" }); expect(r.summary).toContain("本月");
});
it("完成计划按实际完成时间，反复点完成不改首次时间，撤销再完成重新计时", async () => {
  const plan = await prisma.followPlan.create({ data: { subject: "老计划现在完成", customerId, ownerId: state.user.id, plannedAt: new Date("2026-08-01") } });
  expect((await completePlan(plan.id)).ok).toBe(true);
  expect((await tool("my_recap").run({ period: "this_month" }, ctx())).data).toMatchObject({ 完成的计划: 1 });
});
it("自己的建档按创建操作人，转交不重记成别人的新建", async () => {
  const other = await prisma.user.create({ data: { email: "other", name: "乙", password: "x" } });
  const mine = await prisma.customer.create({ data: { name: "我创建后转给乙", phone: "", salesOwnerId: other.id } });
  const assigned = await prisma.customer.create({ data: { name: "乙创建后转给我", phone: "", salesOwnerId: state.user.id } });
  for (const [id, uid] of [[mine.id, state.user.id], [assigned.id, other.id]]) await prisma.auditLog.create({ data: { userId: uid, userName: uid, action: "create", entity: "Customer", entityId: id, summary: "创建客户" } });
  const r = await tool("my_recap").run({ period: "this_month" }, ctx());
  expect((r.data as any).新建的客户.map((x: any) => x.姓名)).toEqual(["我创建后转给乙"]);
});
it("跨14个月走势返回最近12个月并明确截断，不能把最近两月丢掉", async () => {
  for (let i = 0; i < 14; i++) await prisma.lead.create({ data: { name: `月${i}`, createdAt: new Date(2025, 8+i, 1), ownerId: state.user.id } });
  const r = await tool("query_metric").run({ metric: "leads_count", groupBy: "month" }, ctx());
  const data = r.data as any;
  expect(data.rows.map((x: any) => x.label)).toContain("2026-10");
  expect(data.rows.map((x: any) => x.label)).not.toContain("2025-09");
  expect(data.总行数).toBe(14); expect(data.说明).toContain("最近12个月");
});

it("计划完成时间幂等、撤销清空、再完成重记；旧计划时间未知单列", async () => {
  const plan = await prisma.followPlan.create({ data: { subject: "完成时间", customerId, ownerId: state.user.id, plannedAt: new Date("2026-01-01") } });
  await completePlan(plan.id); const first = (await prisma.followPlan.findUniqueOrThrow({ where: { id: plan.id } })).doneAt;
  vi.setSystemTime(new Date("2026-10-31T13:00:00+08:00")); await completePlan(plan.id);
  expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: plan.id } })).doneAt).toEqual(first);
  await completePlan(plan.id, false); expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: plan.id } })).doneAt).toBeNull();
  await completePlan(plan.id); expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: plan.id } })).doneAt?.getHours()).toBe(13);
  await prisma.followPlan.create({ data: { subject: "旧已完成", done: true, customerId, ownerId: state.user.id, plannedAt: new Date("2026-10-10") } });
  expect((await tool("my_recap").run({ period: "this_month" }, ctx())).data).toMatchObject({ 完成的计划: 1, 完成时间未知的旧计划: 1 });
});
it("常驻进程跨月后本月快捷查询随当前时间重算", () => {
  vi.setSystemTime(new Date("2026-11-01T00:01:00+08:00"));
  expect(认意图("这个月谁签得最多？")?.调用[0].args).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
});
it("导入、线索新建转化可核实建档人；并入老客户不算新建，重复证据只计一次", async () => {
  const other = await prisma.user.create({ data: { email: "source-other", name: "乙", password: "x" } });
  const ids: string[] = [];
  for (const name of ["本人导入后转交", "本人线索新建后转交", "并入已有客户"]) ids.push((await prisma.customer.create({ data: { name, phone: "", salesOwnerId: other.id } })).id);
  const batch = await prisma.importBatch.create({ data: { userId: state.user.id, userName: "QA", fileName: "本地.csv" } });
  await prisma.importRow.create({ data: { batchId: batch.id, customerId: ids[0], kind: "create" } });
  await prisma.auditLog.create({ data: { userId: state.user.id, userName: "QA", action: "create", entity: "Customer", entityId: ids[0], summary: "重复创建证据" } });
  for (const [customer, merge] of [[ids[1], false], [ids[2], true]] as const) await prisma.auditLog.create({ data: { userId: state.user.id, userName: "QA", action: "convert", entity: "Lead", summary: "转化", detail: JSON.stringify({ customerId: customer, 并入: merge }) } });
  const r = await tool("my_recap").run({ period: "this_month" }, ctx());
  expect((r.data as any).新建的客户.map((x: any) => x.姓名).sort()).toEqual(["本人导入后转交", "本人线索新建后转交"].sort());
  expect(r.summary).toContain("可核实本人建档 2 位");
});
it("上月/上周用完整自然范围，本周从周一开始；未知周期拒绝", async () => {
  const { recapRange } = await import("@/lib/agent/recap-range");
  const { dayjs } = await import("@/lib/utils");
  const period = (name: string) => { const range = recapRange({ period: name })!; return [dayjs(range.from).format("YYYY-MM-DD HH:mm"), dayjs(range.to).format("YYYY-MM-DD HH:mm")]; };
  expect(period("last_month")).toEqual(["2026-09-01 00:00", "2026-09-30 23:59"]);
  expect(period("last_week")).toEqual(["2026-10-19 00:00", "2026-10-25 23:59"]);
  expect(period("this_week")).toEqual(["2026-10-26 00:00", "2026-10-31 12:00"]);
  expect((await tool("my_recap").run({ period: "yesterday-ish" }, ctx())).data).toHaveProperty("error");
});
