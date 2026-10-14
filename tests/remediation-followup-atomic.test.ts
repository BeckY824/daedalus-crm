import { beforeEach, afterAll, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveFollowUp } from "@/app/(app)/customers/[id]/actions";
let customerId: string; let planId: string;
beforeEach(async () => {
  await resetDb();
  state.user.id = (await prisma.user.create({ data: { name: "QA", email: "qa-atomic", password: "unused", role: "ADMIN" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "QA客户", phone: "", salesOwnerId: state.user.id } })).id;
  planId = (await prisma.followPlan.create({ data: { customerId, ownerId: state.user.id, subject: "QA到期计划", method: "电话", plannedAt: new Date("2026-10-01") } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });
const input = () => ({ customerId, type: "PHONE", content: "QA跟进已完成，排新任务和计划", status: "已完成", occurredAt: new Date().toISOString(), 附带: { tasks: [{ title: "QA发报价", dueAt: null }], plan: { subject: "QA回访", method: "电话", plannedAt: "2026-10-10T10:00:00+08:00" }, 完成计划: planId } });
it("J-177 一次提交跟进、待办、下次计划、到期计划全部完成", async () => {
  expect((await saveFollowUp(input())).ok).toBe(true);
  expect(await prisma.followUp.count()).toBe(1); expect(await prisma.task.count()).toBe(1); expect(await prisma.followPlan.count()).toBe(2);
  expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: planId } })).done).toBe(true);
});
it.each(["Task", "FollowPlan"])("J-177 %s建项失败，跟进和所有收尾动作都回滚", async (table) => {
  const before = await prisma.followPlan.findUniqueOrThrow({ where: { id: planId } });
  await prisma.$executeRawUnsafe(`CREATE TRIGGER qa_extra_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'QA write unavailable'); END`);
  try { try { await saveFollowUp(input()); } catch {} } finally { await prisma.$executeRawUnsafe("DROP TRIGGER qa_extra_failure"); }
  expect(await prisma.followUp.count()).toBe(0); expect(await prisma.task.count()).toBe(0); expect(await prisma.followPlan.count()).toBe(1);
  expect(await prisma.followPlan.findUniqueOrThrow({ where: { id: planId } })).toEqual(before);
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).lastFollowAt).toBeNull(); expect(await prisma.auditLog.count()).toBe(0);
});
it("J-177 不能勾选完成另一位客户的计划", async () => {
  const other = await prisma.customer.create({ data: { name: "QA另一位", phone: "", salesOwnerId: state.user.id } });
  await prisma.followPlan.update({ where: { id: planId }, data: { customerId: other.id } });
  expect(await saveFollowUp(input())).toMatchObject({ ok: false, error: expect.stringContaining("计划") });
  expect(await prisma.followUp.count()).toBe(0); expect(await prisma.task.count()).toBe(0); expect(await prisma.auditLog.count()).toBe(0);
  expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: planId } })).done).toBe(false);
});
it("手工提醒自带待办创建失败也不能留下孤立跟进", async () => {
  await prisma.$executeRawUnsafe("CREATE TRIGGER qa_task_failure BEFORE INSERT ON Task BEGIN SELECT RAISE(ABORT, 'QA task unavailable'); END");
  try { try { await saveFollowUp({ customerId, type: "REMIND", content: "QA要提醒", status: "待处理", occurredAt: new Date().toISOString(), dueAt: "2026-10-10T10:00:00+08:00" }); } catch {} } finally { await prisma.$executeRawUnsafe("DROP TRIGGER qa_task_failure"); }
  expect(await prisma.followUp.count()).toBe(0); expect(await prisma.auditLog.count()).toBe(0);
});
