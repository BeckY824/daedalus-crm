import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa-calendar", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
vi.mock("@/app/(app)/follow-ups/plans/PlansView", () => ({ default: () => null }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { savePlan, saveTask, saveFollowUp, deleteFollowUp, restoreFollowUp } from "@/app/(app)/customers/[id]/actions";
import PlansPage from "@/app/(app)/follow-ups/plans/page";
import { 取提醒项 } from "@/lib/reminders-db";
import { 算提醒 } from "@/lib/reminders";
import { 数逾期跟进, 是逾期 } from "@/lib/overdue";
import { loadWatchlistPage } from "@/lib/sentinel-data";
import { buildWatchlist } from "@/lib/sentinel";
import { buildProposal } from "@/lib/agent/proposals";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { sanitizeFollowUpDraft } from "@/lib/ai-draft";
import { 截止说法 } from "@/lib/deadline";
import { dayjs, fmtDateTime } from "@/lib/utils";
const originalTZ = process.env.TZ;
let customerId: string;
beforeEach(async () => {
  process.env.TZ = "Asia/Shanghai";
  await resetDb();
  state.user.id = (await prisma.user.create({ data: { email: state.user.email, name: "QA", password: "qa", role: "ADMIN" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "日历验收客户", phone: "", salesOwnerId: state.user.id, followStatus: "已签约" } })).id;
});
afterEach(() => { process.env.TZ = originalTZ; vi.useRealTimers(); });
afterAll(async () => { await prisma.$disconnect(); });
const plan = (plannedAt: string, extra = {}) => savePlan({ customerId, subject: "仅日期计划", method: "电话", plannedAt, ...extra });
function now(instant: string) { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(instant)); }

it.each(["America/New_York", "America/Los_Angeles", "UTC", "Europe/London", "Asia/Kolkata", "Pacific/Auckland", "America/Santiago"])("D-048 北京录入的原日历日到%s仍为10月8日，计划页/提醒/逾期/盯盘一致", async tz => {
  await plan("2026-10-08");
  process.env.TZ = tz;
  now(new Date(2026, 9, 8, 13).toISOString());
  const page = await PlansPage({ searchParams: Promise.resolve({}) });
  expect(page.props.plans[0]).toMatchObject({ plannedAt: "2026-10-08", plannedHasTime: false });
  expect(截止说法(page.props.plans[0].plannedAt)).toBe("今天"); expect(fmtDateTime(page.props.plans[0].plannedAt)).toBe("2026-10-08");
  expect(是逾期(page.props.plans[0].plannedAt)).toBe(false);
  expect(算提醒(await 取提醒项(state.user.id))).toMatchObject({ 今天: 1, 逾期: 0, 定时: [], 错过: [] });
  expect(await 数逾期跟进(prisma, { ownerId: state.user.id })).toBe(0);
  now(new Date(2026, 9, 9, 0, 1).toISOString());
  expect(算提醒(await 取提醒项(state.user.id))).toMatchObject({ 今天: 0, 逾期: 1, 最久: { 天: 1 }, 定时: [], 错过: [] });
  expect(await 数逾期跟进(prisma, { ownerId: state.user.id })).toBe(1);
  expect((await loadWatchlistPage(dayjs())).items).toEqual([expect.objectContaining({ kind: "overdue_plan", reason: expect.stringContaining("逾期 1 天") })]);
});
it("明确00:00必须定时，旧客户端原样编辑日期计划保留语义，现代明确切钟点可覆盖", async () => {
  const saved = await plan("2026-10-08"); if (!saved.ok) throw Error(saved.error);
  const p = await prisma.followPlan.findUniqueOrThrow({ where: { id: saved.id } });
  expect((await plan(p.plannedAt.toISOString(), { id: p.id, subject: "只改标题" })).ok).toBe(true);
  expect(await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ plannedOn: "2026-10-08", plannedHasTime: false });
  expect((await plan(p.plannedAt.toISOString(), { id: p.id, plannedHasTime: true })).ok).toBe(true);
  now("2026-10-07T23:55:00+08:00");
  expect(算提醒(await 取提醒项(state.user.id)).定时).toEqual([expect.objectContaining({ at: p.plannedAt.toISOString() })]);
  expect((await plan("2026-10-08", { id: p.id, plannedHasTime: false })).ok).toBe(true);
  expect(算提醒(await 取提醒项(state.user.id)).定时).toEqual([]);
});
it("真实旧记录不反推选择；仅改标题保留未知，显式选择日期才确认语义", async () => {
  const p = await prisma.followPlan.create({ data: { customerId, ownerId: state.user.id, subject: "旧", plannedAt: new Date("2026-10-08T09:00:00+08:00") } });
  await plan(p.plannedAt.toISOString(), { id: p.id });
  expect(await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ plannedOn: null, plannedHasTime: null });
  await plan("2026-10-08", { id: p.id });
  expect(await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ plannedOn: "2026-10-08", plannedHasTime: false });
});
it("跟进日期提醒、附加AI日期任务/计划及删除撤销均保留日历语义；今天日期不误要求历史确认", async () => {
  now("2026-10-08T13:00:00+08:00");
  const draft = sanitizeFollowUpDraft({ followUp: { content: "明天回访" }, tasks: [{ title: "寄资料", dueAt: "2026-10-09" }], plan: { subject: "问进展", plannedAt: "2026-10-09" } }, { contactIds: [], opportunityIds: [] });
  expect(draft.tasks[0].dueAt).toBe("2026-10-09"); expect(draft.plan!.plannedAt).toBe("2026-10-09");
  expect(buildProposal("qa-proposal", "add_plan", { id: customerId, name: "QA客户" }, { subject: "裸日期", plannedAt: "2026-10-09", method: "电话沟通", reason: "客户要求回访" }, DEFAULT_BUSINESS)).toMatchObject({ ok: true, proposal: { plannedAt: "2026-10-09" } });
  const r = await saveFollowUp({ customerId, type: "REMIND", title: "今天回电", content: "提醒", status: "待处理", occurredAt: new Date().toISOString(), dueAt: "2026-10-08", 附带: { tasks: draft.tasks, plan: draft.plan } });
  if (!r.ok) throw Error(r.error);
  expect(await prisma.followUp.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ dueOn: "2026-10-08", dueHasTime: false });
  expect(await prisma.task.findMany({ orderBy: { title: "asc" } })).toEqual(expect.arrayContaining([expect.objectContaining({ dueOn: "2026-10-08", dueHasTime: false }), expect.objectContaining({ dueOn: "2026-10-09", dueHasTime: false })]));
  const deleted = await deleteFollowUp(r.id, customerId); if (!deleted.ok) throw Error(deleted.error);
  expect((await restoreFollowUp(deleted.快照)).ok).toBe(true);
  expect(await prisma.task.findMany({ where: { title: "今天回电" } })).toEqual([expect.objectContaining({ dueOn: "2026-10-08", dueHasTime: false })]);
  process.env.TZ = "America/New_York"; now("2026-10-08T13:00:00-04:00");
  expect(算提醒(await 取提醒项(state.user.id))).toMatchObject({ 定时: [], 错过: [] });
});
it("非法/自相矛盾日期模式拒绝；清空待办截止同步清语义", async () => {
  expect(await plan("2026-10-08T00:00:00+08:00", { plannedHasTime: false })).toMatchObject({ ok: false });
  expect(await plan("2026-10-08", { plannedHasTime: true })).toMatchObject({ ok: false });
  expect(await prisma.followPlan.count()).toBe(0);
  await saveTask({ customerId, title: "清空截止", dueAt: "2026-10-08" });
  const t = await prisma.task.findFirstOrThrow(); await saveTask({ id: t.id, customerId, title: t.title, dueAt: null });
  expect(await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ dueAt: null, dueOn: null, dueHasTime: null });
});
it.each(["America/Los_Angeles", "Europe/London"])("L-036 %s跨DST按日历日统计沉睡/停滞，不差一个钟点", tz => {
  process.env.TZ = tz;
  const n = new Date(2026, 10, 2, 0, 5); const old = new Date(2026, 9, 19, 23, 55);
  const items = buildWatchlist({ overduePlans: [], customers: [{ id: "sleep", name: "甲", ownerName: "QA", followStatus: "跟进中", lastFollowAt: old, createdAt: old }], opportunities: [{ customerId: "stall", customerName: "乙", ownerName: "QA", name: "报价", stage: "方案报价", updatedAt: old }] }, n);
  expect(items).toHaveLength(2); expect(items.every(x => x.reason.includes("14 天"))).toBe(true);
});
