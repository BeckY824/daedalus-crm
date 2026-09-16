import { describe, expect, test } from "vitest";
import { 只留选中的改动, type Proposal } from "@/lib/agent/proposals";

/**
 * 逐项确认（批 2）。
 *
 * 一张卡建议改三个字段，人只认其中两个——没勾的那一项必须**整条不出现在提交里**。
 * 留着值只是把界面上的勾当装饰：服务端会用 buildProposal 从 changes 重新收一遍，
 * 留下的那一项照样会被写进去。
 */
const 一张卡 = (changes: { field: string; value: string }[]): Proposal =>
  ({
    id: "p1",
    kind: "update_customer",
    customerId: "c1",
    customerName: "林夏",
    reason: "从这次沟通里看出来的",
    changes,
    现值: { followStatus: "跟进中", school: "北京大学", remark: "" },
  }) as unknown as Proposal;

describe("建议卡逐项确认", () => {
  test("只提交勾上的那几项", () => {
    const p = 一张卡([
      { field: "followStatus", value: "意向较高" },
      { field: "school", value: "清华大学" },
      { field: "remark", value: "家长关心就业" },
    ]);
    const 收 = 只留选中的改动(p, [0, 2]) as Extract<Proposal, { kind: "update_customer" }>;
    expect(收.changes.map((c) => c.field)).toEqual(["followStatus", "remark"]);
    // 没勾的那一项连字段都不该在
    expect(JSON.stringify(收.changes)).not.toContain("清华大学");
  });

  test("一项都没勾就是一张空卡，服务端那边会以「没有要改的字段」拒掉", () => {
    const 收 = 只留选中的改动(一张卡([{ field: "school", value: "清华大学" }]), []) as Extract<Proposal, { kind: "update_customer" }>;
    expect(收.changes).toEqual([]);
  });

  test("不是改档案的卡原样返回——它们只有一件事，没有逐项可言", () => {
    const p = { id: "p2", kind: "add_plan", customerId: "c1", customerName: "林夏", reason: "r", subject: "谈报价", plannedAt: "2026-09-20T02:00:00.000Z", method: "电话沟通" } as unknown as Proposal;
    expect(只留选中的改动(p, [])).toBe(p);
  });

  test("现值只是给卡片画「改之前 → 改之后」的，挑选不碰它", () => {
    const p = 一张卡([{ field: "followStatus", value: "意向较高" }]);
    const 收 = 只留选中的改动(p, [0]);
    expect(收.现值).toEqual({ followStatus: "跟进中", school: "北京大学", remark: "" });
  });
});
