/**
 * 第三轮对抗复查 · 同一张卡不确认两次（5771538）
 *
 * 修法：按「谁 + 卡的 JSON（去掉现值）」占位 10 分钟，进程内存。
 * 这里钉的是它误拦的一种：撤销后卡片回到可确认（ProposalCard 撤销后 set状态("idle")），再点确认被拦。
 * （两次不同提问出的同内容跟进卡不会被拦：occurredAt 默认带毫秒的「此刻」，卡的 JSON 不一样。）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import type { Proposal } from "@/lib/agent/proposals";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

import { applyProposal, undoProposal } from "@/app/(app)/dashboard/apply";

let 客户 = "";
let 序 = 0;

beforeEach(async () => {
  await resetDb();
  await prisma.user.create({ data: { id: "tester-id", email: "t@t", name: "测试员", role: "ADMIN", password: "x" } });
  // 每条用例换一个客户名 + 手机号：占位表在进程内存里，resetDb 清不掉它，客户 id 也是新的，免得用例之间串
  序++;
  客户 = (await prisma.customer.create({ data: { name: `李文龙${序}`, phone: `1380000${String(1000 + 序)}`, salesOwnerId: "tester-id", followStatus: "跟进中" } })).id;
});

async function 出卡(工具: string, args: Record<string, unknown>): Promise<Proposal> {
  const { TOOL_MAP } = await import("@/lib/agent/tools");
  const { getBusiness } = await import("@/lib/business");
  const ctx = { userId: "tester-id", userName: "测试员", b: await getBusiness(), recordOffset: 0, proposals: [] as Proposal[], 号: <T,>(p: T) => p };
  await TOOL_MAP.get(工具)!.run(args, ctx as never);
  expect(ctx.proposals).toHaveLength(1);
  return ctx.proposals[0];
}

describe("同一张卡不确认两次：误拦", () => {
  it("记跟进卡：确认 → 点「撤销」→ 改主意再点确认：被说成「刚刚已经确认过了」，10 分钟内记不上", async () => {
    const 卡 = await 出卡("propose_followup", { id: 客户, content: "电话聊了报价细节", reason: "r" });
    const 一 = await applyProposal(卡);
    expect(一.ok).toBe(true);
    const 撤 = 一.ok ? 一.撤销 : undefined;
    expect(撤).toBeTruthy();
    expect((await undoProposal(撤!)).ok).toBe(true);
    expect(await prisma.followUp.count({ where: { customerId: 客户 } })).toBe(0);
    const 二 = await applyProposal(卡);
    expect(二.ok, 二.ok ? "" : 二.error).toBe(true);
    expect(await prisma.followUp.count({ where: { customerId: 客户 } })).toBe(1);
  });

  it("改状态卡：确认 → 撤销 → 再确认：同样被拦", async () => {
    const 卡 = await 出卡("propose_status_change", { id: 客户, to: "意向较高", reason: "r" });
    const 一 = await applyProposal(卡);
    expect(一.ok).toBe(true);
    expect((await undoProposal((一 as unknown as { 撤销: never }).撤销)).ok).toBe(true);
    const 二 = await applyProposal(卡);
    expect(二.ok, 二.ok ? "" : 二.error).toBe(true);
    expect((await prisma.customer.findUnique({ where: { id: 客户 } }))!.followStatus).toBe("意向较高");
  });
});
