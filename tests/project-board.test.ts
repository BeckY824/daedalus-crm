/**
 * 项目看板分列（lib/project/board.ts）：五列都摆、列头数和按币种分开的合计、列里最近改过的排前。
 * 总控 10-23 定：金额不换汇，各币种各算各的。
 */
import { describe, it, expect } from "vitest";
import { 看板分列, type 项目行 } from "@/lib/project/board";

let n = 0;
function 行(补: Partial<项目行>): 项目行 {
  n += 1;
  return {
    id: `p${n}`, name: `项目${n}`, customerId: "c", customerName: "客户", ownerId: "u", ownerName: "甲",
    phase: "线索", node: "潜客培育", result: null, exceptionReason: null, exceptionCategory: null, pooled: false, amount: 0, currency: "CNY", updatedAt: "2026-10-23T00:00:00.000Z",
    ...补,
  };
}

describe("看板分列", () => {
  it("没项目也摆五列，列头 0、合计空", () => {
    expect(看板分列([]).map((c) => [c.列, c.数, c.合计])).toEqual([
      ["线索", 0, []], ["商机", 0, []], ["订单", 0, []], ["成功交付", 0, []], ["没成", 0, []],
    ]);
  });

  it("异常留在所在阶段那列；流失、丢单进没成；合计按币种分开不换汇", () => {
    const 列 = 看板分列([
      行({ phase: "订单", node: "安装实施", amount: 100, currency: "CNY" }),
      行({ phase: "订单", node: "安装实施", result: "异常状态", exceptionReason: "停电", amount: 50, currency: "USD" }),
      行({ phase: "订单", node: "合同签订", amount: 30, currency: "CNY" }),
      行({ phase: "线索", node: "线索验证", result: "线索流失" }),
      行({ phase: "商机", node: "共识方案", result: "丢单", amount: 9 }),
      行({ phase: "订单", node: "尾款结算", result: "成功交付", amount: 7, currency: "EUR" }),
    ]);
    const 看 = Object.fromEntries(列.map((c) => [c.列, { 数: c.数, 合计: c.合计 }]));
    expect(看.订单).toEqual({ 数: 3, 合计: [{ 币种: "CNY", 合计: 130 }, { 币种: "USD", 合计: 50 }] });
    expect(看.没成).toEqual({ 数: 2, 合计: [{ 币种: "CNY", 合计: 9 }] });
    expect(看.成功交付).toEqual({ 数: 1, 合计: [{ 币种: "EUR", 合计: 7 }] });
    expect(看.线索.数).toBe(0);
  });

  it("列里最近改过的排前", () => {
    const [线索] = 看板分列([
      行({ name: "旧", updatedAt: "2026-10-20T00:00:00.000Z" }),
      行({ name: "新", updatedAt: "2026-10-22T00:00:00.000Z" }),
      行({ name: "中", updatedAt: "2026-10-21T00:00:00.000Z" }),
    ]);
    expect(线索.行.map((r) => r.name)).toEqual(["新", "中", "旧"]);
  });
});
