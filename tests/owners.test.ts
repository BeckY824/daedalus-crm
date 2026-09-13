/**
 * 负责人候选名单的回退。
 *
 * 「管理员不承担销售职责」这条规则本身是对的，但它在「工作区只有一个人，
 * 而那个人是管理员」时会把产品卡死——负责人必填、下拉却空着，
 * 新注册的人连第一条客户都建不出来。托管版每个新工作区一开始正好是这个状态。
 *
 * 这里钉住回退行为，以及「回退只影响指派下拉，不影响业绩口径」。
 */
import { describe, it, expect } from "vitest";
import { 可担任负责人 } from "@/lib/constants";

/** 与 lib/owners.ts 同一套逻辑，脱开数据库单独验 */
function 候选<T extends { role: string; active: boolean }>(全部: T[]): T[] {
  const 在职 = 全部.filter((u) => u.active);
  const 非管理员 = 在职.filter((u) => u.role !== "ADMIN");
  return 非管理员.length > 0 ? 非管理员 : 在职;
}

const 人 = (name: string, role: string, active = true) => ({ name, role, active });

describe("负责人候选", () => {
  it("有销售时不列管理员", () => {
    const r = 候选([人("管理员", "ADMIN"), 人("张三", "SALES"), 人("李四", "SALES")]);
    expect(r.map((u) => u.name)).toEqual(["张三", "李四"]);
  });

  it("只有一个管理员时回退到他自己——否则新工作区建不出第一条客户", () => {
    const r = 候选([人("林老师", "ADMIN")]);
    expect(r.map((u) => u.name)).toEqual(["林老师"]);
  });

  it("停用的人无论如何都不列", () => {
    const r = 候选([人("管理员", "ADMIN"), 人("离职的", "SALES", false)]);
    expect(r.map((u) => u.name)).toEqual(["管理员"]);
  });

  it("全员停用时给空名单，而不是把停用的人塞回来", () => {
    expect(候选([人("管理员", "ADMIN", false), 人("张三", "SALES", false)])).toEqual([]);
  });

  it("业绩口径不变：排行榜那条规则仍然严格排除管理员", () => {
    // 回退只用于指派下拉。这里确认常量本身没被改松
    expect(可担任负责人).toEqual({ active: true, role: { not: "ADMIN" } });
  });
});
