/**
 * 商机阶段和状态对齐（lib/opp-stage.ts，2026-10-02 排查）：这一次人动的是哪一格就听哪一格。
 * 原来已赢单的商机在编辑框里改成丢单、或者只改阶段，都被改回赢单，界面还说「已保存」。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { 对齐阶段与状态 } from "@/lib/opp-stage";
import { saveOpportunity } from "@/app/(app)/opportunities/actions";

const 赢了 = { stage: "赢单成交", status: "WON" };

describe("对齐阶段与状态", () => {
  it("已赢单 → 只改状态成丢单：存得进去，阶段退回前一档", () => {
    expect(对齐阶段与状态({ stage: "赢单成交", status: "LOST" }, 赢了)).toEqual({ stage: "谈判审核", status: "LOST" });
  });
  it("已赢单 → 只改阶段：状态回到进行中", () => {
    expect(对齐阶段与状态({ stage: "谈判审核", status: "WON" }, 赢了)).toEqual({ stage: "谈判审核", status: "OPEN" });
  });
  it("进行中 → 只改状态成赢单：阶段跟到赢单成交", () => {
    expect(对齐阶段与状态({ stage: "方案报价", status: "WON" }, { stage: "方案报价", status: "OPEN" })).toEqual(赢了);
  });
  it("进行中 → 只把阶段拖到赢单成交：状态跟到赢单", () => {
    expect(对齐阶段与状态({ stage: "赢单成交", status: "OPEN" }, { stage: "方案报价", status: "OPEN" })).toEqual(赢了);
  });
  it("新建：赢单成交那一格说了算；丢单不限阶段", () => {
    expect(对齐阶段与状态({ stage: "赢单成交", status: "OPEN" }, null)).toEqual(赢了);
    expect(对齐阶段与状态({ stage: "需求确认", status: "LOST" }, null)).toEqual({ stage: "需求确认", status: "LOST" });
  });
});

/*
  2026-10-04 J-087（补测试）：上面钉的只是规则函数，saveOpportunity 落库那一层没有用例——
  哪天落库前不再过这道对齐，就又回到「提示已保存、实际还是赢单」，业绩数跟着错，而规则函数的用例照样全绿。
*/
describe("编辑框保存（落库）", () => {
  let 我: string;
  let 客户: string;
  beforeEach(async () => {
    await resetDb();
    我 = (await 造本人()).id;
    mocks.user.id = 我;
    客户 = (await 造客户(我)).id;
  });

  it("已赢单的商机只把状态改成丢单（阶段那格不动）→ 库里变丢单、阶段退回谈判审核、不再挂 100%", async () => {
    const o = await prisma.opportunity.create({
      data: { name: "面板灯", customerId: 客户, ownerId: 我, amount: 8000, stage: "赢单成交", status: "WON", probability: 100, closed: { create: {} } },
    });
    // 编辑框整表提交：其它格原样交回，只有状态从 WON 换成 LOST
    const r = await saveOpportunity({ id: o.id, name: o.name, customerId: 客户, amount: 8000, stage: "赢单成交", status: "LOST", probability: 100, ownerId: 我 });
    expect(r.ok).toBe(true);
    const 后 = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id }, include: { closed: true } });
    expect(后.status).toBe("LOST");
    expect(后.stage).toBe("谈判审核");
    expect(后.probability).toBeLessThan(100);
    // 丢单也是结单：结单时刻那一行还在
    expect(后.closed).not.toBeNull();
  });
});
