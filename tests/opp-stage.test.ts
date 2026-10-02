/**
 * 商机阶段和状态对齐（lib/opp-stage.ts，2026-10-02 排查）：这一次人动的是哪一格就听哪一格。
 * 原来已赢单的商机在编辑框里改成丢单、或者只改阶段，都被改回赢单，界面还说「已保存」。
 */
import { describe, it, expect } from "vitest";
import { 对齐阶段与状态 } from "@/lib/opp-stage";

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
