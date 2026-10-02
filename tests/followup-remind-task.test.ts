/**
 * 「跟进提醒 / 跟进任务」填了时间：同时建一条待办，到点才真会提醒（2026-10-02 排查 3-2）。
 * 原来那个时间只是记录上的一格，Dock、早报、到点通知、计划页都看不到它。
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

describe("跟进提醒顺带建待办", () => {
  it("新建「跟进提醒」带时间、没做完：多一条待办，时间对得上，归我", async () => {
    const { saveFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    const 到点 = new Date(Date.now() + 5 * 60_000).toISOString();
    const r = await saveFollowUp({ customerId, type: "REMIND", title: "回电话", content: "下午回电话", status: "待处理", occurredAt: new Date().toISOString(), dueAt: 到点 });
    expect(r.ok && "待办id" in r && r.待办id).toBeTruthy();
    const t = await prisma.task.findFirstOrThrow({ where: { customerId } });
    expect(t).toMatchObject({ title: "回电话", ownerId: "tester-id", done: false });
    expect(t.dueAt?.toISOString()).toBe(到点);
  });

  it("已完成的、没填时间的、别的类型、编辑老记录：都不建", async () => {
    const { saveFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    const 时 = new Date().toISOString();
    await saveFollowUp({ customerId, type: "REMIND", content: "x", status: "已完成", occurredAt: 时, dueAt: 时 });
    await saveFollowUp({ customerId, type: "TASK", content: "x", status: "待处理", occurredAt: 时 });
    const 电话 = await saveFollowUp({ customerId, type: "PHONE", content: "x", status: "已完成", occurredAt: 时, dueAt: 时 });
    if (电话.ok) await saveFollowUp({ id: 电话.id, customerId, type: "REMIND", content: "x", status: "待处理", occurredAt: 时, dueAt: 时 });
    expect(await prisma.task.count({ where: { customerId } })).toBe(0);
  });
});
