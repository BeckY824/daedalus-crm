/**
 * 老签约（0.46.15 之前、没有 ContractOwner 的）在第一次换负责人之前被钉住（lib/contract-owner.ts 钉住老签约，2026-10-02 排查 X1）。
 * 原来升级后停用张三、转给李四，张三的老业绩整笔算到李四名下。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "admin", name: "管理员", email: "a", role: "ADMIN", title: "" }),
}));

let 张三: string, 李四: string, 客户: string;
beforeEach(async () => {
  await resetDb();
  await prisma.user.create({ data: { id: "admin", email: "a", name: "管理员", title: "", role: "ADMIN", password: "x" } });
  张三 = (await prisma.user.create({ data: { email: "z3", name: "张三", role: "SALES", password: "x" } })).id;
  李四 = (await prisma.user.create({ data: { email: "l4", name: "李四", role: "SALES", password: "x" } })).id;
  客户 = (await prisma.customer.create({ data: { name: "老客户", phone: "13800000009", salesOwnerId: 张三 } })).id;
  // 升级前登记的签约：没有 ContractOwner
  await prisma.contract.create({ data: { customerId: 客户, amount: 50_000, signedAt: new Date("2026-08-01") } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("钉住老签约", () => {
  it("补上一行，按此刻的负责人；再调不重复", async () => {
    const { 钉住老签约 } = await import("@/lib/contract-owner");
    expect(await 钉住老签约()).toBe(1);
    expect(await 钉住老签约()).toBe(0);
    const row = await prisma.contractOwner.findFirstOrThrow();
    expect(row.salesOwnerId).toBe(张三);
  });

  it("批量把客户转给李四：老签约仍记在张三名下", async () => {
    const { assignSalesOwner: bulkAssignOwner } = await import("@/app/(app)/customers/actions");
    const r = await bulkAssignOwner([客户], 李四);
    expect(r.ok).toBe(true);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户 } })).salesOwnerId).toBe(李四);
    expect((await prisma.contractOwner.findFirstOrThrow()).salesOwnerId).toBe(张三);
  });
});
