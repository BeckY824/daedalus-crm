/**
 * 复查 fc06ead「跟进提醒 / 跟进任务顺带建待办」：那条待办和跟进记录之间没有任何关联。
 *   - 把这条跟进删掉（或改成「已完成」）后，顺带建的待办还挂着，照样进 Dock 数、早报、到点通知、逾期。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

let customerId: string;
beforeEach(async () => {
  await resetDb();
  await prisma.user.create({ data: { id: "tester-id", email: "t", name: "测试员", title: "", role: "ADMIN", password: "x" } });
  customerId = (await prisma.customer.create({ data: { name: "王总", phone: "13800000001", salesOwnerId: "tester-id" } })).id;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("复查：顺带建的待办跟不上跟进记录", () => {
  it("删掉那条「跟进提醒」：顺带建的待办也应该没了", async () => {
    const { saveFollowUp, deleteFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    const 到点 = new Date(Date.now() + 5 * 60_000).toISOString();
    const r = await saveFollowUp({ customerId, type: "REMIND", title: "回电话", content: "下午回电话", status: "待处理", occurredAt: new Date().toISOString(), dueAt: 到点 });
    if (!r.ok) throw new Error("没存上");
    await deleteFollowUp(r.id, customerId);
    expect(await prisma.task.count({ where: { customerId, done: false } })).toBe(0); // 实际：1，还会到点提醒
  });

  it("把那条「跟进任务」改成已完成：待办应该跟着完成", async () => {
    const { saveFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    const 时 = new Date().toISOString();
    const 到点 = new Date(Date.now() + 5 * 60_000).toISOString();
    const r = await saveFollowUp({ customerId, type: "TASK", title: "发报价", content: "发报价", status: "待处理", occurredAt: 时, dueAt: 到点 });
    if (!r.ok) throw new Error("没存上");
    await saveFollowUp({ id: r.id, customerId, type: "TASK", title: "发报价", content: "发报价", status: "已完成", occurredAt: 时, dueAt: 到点 });
    expect(await prisma.task.count({ where: { customerId, done: false } })).toBe(0); // 实际：1
  });
});
