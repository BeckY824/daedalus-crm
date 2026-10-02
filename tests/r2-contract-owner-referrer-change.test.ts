/**
 * 复查 5b64f81「换负责人之前钉住老签约」：saveCustomer 只在「销售负责人变了 / 显式给了 channelOwnerId」时钉。
 * 改推荐链（来源渠道 / 推荐人）也会重算 channelOwnerId（attribution），这条路没钉——
 * 老签约（没有 ContractOwner 的）的渠道负责人业绩随之整笔搬到新渠道的负责人头上。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "admin", name: "管理员", email: "a", role: "ADMIN", title: "" }),
}));

let 张三: string, 李四: string, 客户: string, 渠道乙: string;
beforeEach(async () => {
  await resetDb();
  await prisma.user.create({ data: { id: "admin", email: "a", name: "管理员", title: "", role: "ADMIN", password: "x" } });
  张三 = (await prisma.user.create({ data: { email: "z3", name: "张三", role: "SALES", password: "x" } })).id;
  李四 = (await prisma.user.create({ data: { email: "l4", name: "李四", role: "SALES", password: "x" } })).id;
  const 渠道甲 = (await prisma.channel.create({ data: { name: "渠道甲", channelOwnerId: 张三 } })).id;
  渠道乙 = (await prisma.channel.create({ data: { name: "渠道乙", channelOwnerId: 李四 } })).id;
  客户 = (
    await prisma.customer.create({
      data: { name: "老客户", phone: "13800000009", salesOwnerId: "admin", channelId: 渠道甲, attributionChannelId: 渠道甲, channelOwnerId: 张三 },
    })
  ).id;
  // 升级前登记的签约：没有 ContractOwner
  await prisma.contract.create({ data: { customerId: 客户, amount: 50_000, signedAt: new Date("2026-08-01") } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("复查：改推荐链没钉住老签约", () => {
  it("把来源渠道从甲改成乙（负责人不动）：老签约的渠道业绩应仍是张三", async () => {
    const { saveCustomer } = await import("@/app/(app)/customers/actions");
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: 客户 } });
    const r = await saveCustomer({
      id: 客户, updatedAt: c.updatedAt.toISOString(), name: c.name, phone: c.phone, school: null, grade: null, major: null,
      followStatus: c.followStatus, decisionStatus: c.decisionStatus, expectedSignAt: null, remark: null,
      salesOwnerId: "admin", channelId: 渠道乙, referrerCustomerId: null,
    } as Parameters<typeof saveCustomer>[0]);
    expect(r.ok).toBe(true);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户 } })).channelOwnerId).toBe(李四);

    const { 签约归属人 } = await import("@/lib/contract-owner");
    const rows = await prisma.contract.findMany({
      select: { owner: { select: { salesOwnerId: true, channelOwnerId: true } }, customer: { select: { channelOwner: { select: { id: true, name: true, email: true } } } } },
    });
    const 归属 = await 签约归属人(rows);
    expect(归属.渠道负责人(rows[0])?.name).toBe("张三"); // 实际：李四
  });
});
