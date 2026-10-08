import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa-calendar-query", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
vi.mock("@/lib/llm", async original => ({ ...(await original<object>()), llmEnabled: async () => false }));
vi.mock("@/app/(app)/customers/[id]/RecordView", () => ({ default: () => null }));
vi.mock("@/app/(app)/dashboard/DashboardView", () => ({ default: () => null }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { TOOLS } from "@/lib/agent/tools";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { readCalendarSorted } from "@/lib/agent/calendar-query";
import { 取客户近况 } from "@/app/(app)/customers/[id]/pick";
import DetailPage from "@/app/(app)/customers/[id]/page";
import Board from "@/app/(app)/dashboard/Board";
let customerId: string;
const originalTZ = process.env.TZ;
const ctx = () => ({ userId: state.user.id, userName: "QA", b: DEFAULT_BUSINESS, recordOffset: 0, proposals: [] });
beforeEach(async () => {
  await resetDb(); invalidateSettingsCache(); process.env.TZ = "America/New_York";
  state.user.id = (await prisma.user.create({ data: { email: state.user.email, name: "QA", role: "ADMIN", password: "qa" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "日期查询客户", phone: "", salesOwnerId: state.user.id } })).id;
});
afterEach(() => { process.env.TZ = originalTZ; }); afterAll(async () => { await prisma.$disconnect(); });
const query = async (args: Record<string, unknown>) => (await TOOLS.find(t => t.name === "query_records")!.run(args, ctx())).data as { 总数: number; 结果: Record<string, unknown>[] };

async function fixtures() {
  // 在北京保存的10月8日日期，旧索引在纽约是10月7日中午，但原日历日仍是8日。
  await prisma.followPlan.create({ data: { id: "date-8", customerId, ownerId: state.user.id, subject: "日期8日", plannedAt: new Date("2026-10-07T16:00:00Z"), plannedOn: "2026-10-08", plannedHasTime: false } });
  await prisma.followPlan.create({ data: { id: "timed-7", customerId, ownerId: state.user.id, subject: "钟点7日晚", plannedAt: new Date("2026-10-07T23:00:00-04:00"), plannedHasTime: true } });
}
it("通用AI日期上下界按原日历日筛选/显示，内部元数据不泄漏", async () => {
  await fixtures();
  const range = await query({ 表: "跟进计划", 条件: [{ 字段: "计划时间", 运算: "不早于", 值: "2026-10-08" }, { 字段: "计划时间", 运算: "不晚于", 值: "2026-10-08" }] });
  expect(range.总数).toBe(1); expect(range.结果).toEqual([expect.objectContaining({ 主题: "日期8日", 计划时间: "2026-10-08" })]);
  expect(JSON.stringify(range)).not.toMatch(/plannedOn|plannedHasTime/);
  expect((await query({ 表: "跟进计划", 条件: [{ 字段: "计划时间", 运算: "不晚于", 值: "2026-10-07" }] })).结果).toEqual([expect.objectContaining({ 主题: "钟点7日晚" })]);
});
it("通用AI升/降序在取1条前排序，任务与计划同规则", async () => {
  await fixtures();
  const asc = await query({ 表: "跟进计划", 排序: { 字段: "计划时间", 降序: false }, 取: 1 });
  expect(asc.结果[0].主题).toBe("钟点7日晚");
  const desc = await query({ 表: "跟进计划", 排序: { 字段: "计划时间", 降序: true }, 取: 1 }); expect(desc.结果[0].主题).toBe("日期8日");
  await prisma.task.createMany({ data: [
    { id: "date-task", customerId, ownerId: state.user.id, title: "日期任务", dueAt: new Date("2026-10-07T16:00:00Z"), dueOn: "2026-10-08", dueHasTime: false },
    { id: "timed-task", customerId, ownerId: state.user.id, title: "钟点任务", dueAt: new Date("2026-10-07T23:00:00-04:00"), dueHasTime: true },
  ] });
  expect((await query({ 表: "任务", 排序: { 字段: "截止时间", 降序: false }, 取: 1 })).结果[0].标题).toBe("钟点任务");
});
it("记录页/客户近况/看板/AI专用工具均取真正最早的原日历日，不先按旧索引截断", async () => {
  await fixtures();
  expect((await 取客户近况(customerId))!.未完成计划!.subject).toBe("钟点7日晚");
  const detail = await DetailPage({ params: Promise.resolve({ id: customerId }), searchParams: Promise.resolve({}) });
  expect(detail.props.plan.subject).toBe("钟点7日晚");
  const board = await Board({}); expect(board.props.tasks[0].title).toBe("钟点7日晚");
  const plans = (await TOOLS.find(t => t.name === "get_my_plans")!.run({}, ctx())).data as { 跟进计划: { subject: string }[] };
  expect(plans.跟进计划[0].subject).toBe("钟点7日晚");
});
it("通用排序跨1000行批界仍找到正确前两条，每批查询保持where且最多1000行", async () => {
  const c = await prisma.customer.create({ data: { name: "不属于筛选", phone: "", salesOwnerId: state.user.id } });
  await prisma.followPlan.createMany({ data: Array.from({ length: 1001 }, (_, i) => ({ id: `batch-${String(i).padStart(4, "0")}`, customerId, ownerId: state.user.id, subject: `计划${i}`, plannedAt: new Date("2026-10-07T16:00:00Z"), plannedOn: i === 1000 ? "2026-10-06" : "2026-10-08", plannedHasTime: false })) });
  await prisma.followPlan.create({ data: { id: "batch-excluded", customerId: c.id, ownerId: state.user.id, subject: "禁止混入", plannedAt: new Date("2026-01-01") } });
  const read = vi.fn(async (args: unknown) => prisma.followPlan.findMany(args as Parameters<typeof prisma.followPlan.findMany>[0]) as unknown as Promise<Record<string, unknown>[]>);
  const rows = await readCalendarSorted(read, { customerId }, { id: true, plannedAt: true, plannedOn: true, subject: true }, 2, "plannedAt", "plannedOn", "asc");
  expect(rows.map(r => r.id)).toEqual(["batch-1000", "batch-0000"]); expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.map(([args]) => (args as { take: number }).take)).toEqual([1000, 1000]);
});
