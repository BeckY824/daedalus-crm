import { beforeEach, afterAll, afterEach, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveFollowUp, saveTask, savePlan } from "@/app/(app)/customers/[id]/actions";
import { patchCustomer } from "@/app/(app)/customers/actions";
let customerId: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-08T10:00:00+08:00"));
  await resetDb();
  state.user.id = (await prisma.user.create({ data: { name: "QA", email: "qa-dates", password: "unused", role: "ADMIN" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "QA客户", phone: "", salesOwnerId: state.user.id } })).id;
});
afterEach(() => vi.useRealTimers()); afterAll(async () => { await prisma.$disconnect(); });
const input = () => ({ customerId, type: "PHONE", content: "真实跟进", status: "已完成", occurredAt: "2026-10-08T09:00:00+08:00" });
it("未来实际跟进拒绝且不改变热度/审计/待办", async () => {
  expect(await saveFollowUp({ ...input(), occurredAt: "2026-10-09T09:00:00+08:00" })).toMatchObject({ ok: false, error: expect.stringContaining("未来") });
  expect(await prisma.followUp.count()).toBe(0); expect(await prisma.auditLog.count()).toBe(0);
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).lastFollowAt).toBeNull();
});
it("历史待处理提醒不能无提示创建逾期待办；明确确认才可一起创建", async () => {
  const old = { ...input(), type: "REMIND", status: "待处理", occurredAt: "2026-09-01T09:00:00+08:00", dueAt: "2026-09-02T09:00:00+08:00" };
  expect(await saveFollowUp(old)).toMatchObject({ ok: false, error: expect.stringContaining("过期") });
  expect(await prisma.followUp.count()).toBe(0); expect(await prisma.task.count()).toBe(0);
  expect(await saveFollowUp({ ...old, 确认过期待办: true } as Parameters<typeof saveFollowUp>[0])).toMatchObject({ ok: true });
  expect(await prisma.followUp.count()).toBe(1); expect(await prisma.task.count()).toBe(1);
});
it("非法日期不自动顺延：行内预计签约、跟进、待办和计划都应中文拒绝", async () => {
  expect(await patchCustomer(customerId, "expectedSignAt", "2026-02-30")).toMatchObject({ ok: false });
  expect(await saveFollowUp({ ...input(), occurredAt: "2026-02-30T09:00:00+08:00" })).toMatchObject({ ok: false });
  expect(await saveTask({ customerId, title: "坏日期", dueAt: "2026-02-30" })).toMatchObject({ ok: false });
  expect(await savePlan({ customerId, subject: "坏日期", plannedAt: "2026-02-30", method: "电话" })).toMatchObject({ ok: false });
  expect(await prisma.task.count()).toBe(0); expect(await prisma.followPlan.count()).toBe(0);
});
it("纯日期按本地日历解析，不能按UTC错到前一天", async () => {
  const original = process.env.TZ; process.env.TZ = "America/New_York";
  try {
    expect(await patchCustomer(customerId, "expectedSignAt", "2026-10-08")).toMatchObject({ ok: true });
    const d = (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).expectedSignAt!;
    expect([d.getFullYear(), d.getMonth()+1, d.getDate()]).toEqual([2026, 10, 8]);
  } finally { process.env.TZ = original; }
});
