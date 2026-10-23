/**
 * 团队版项目模式 1a：阶段 / 节点 / 结局的规矩（lib/project/nodes.ts）。
 * 钉的是总控 10-23 的规则：节点不能往前跳（往后随便退）、成功交付两项都勾才让点、
 * 异常要选类别（备注可空）、已转商机 / 赢单是进下一阶段不是结局、看板每张卡落在哪一列。
 */
import { describe, it, expect } from "vitest";
import { 改节点问题, 交付还差, 下一步, 看板列, 节点序号, 节点总数, 节点们, 阶段们, 第一个节点 } from "@/lib/project/nodes";

/** 项目在哪 + 两个勾；默认停在订单最后一个节点，这样往哪都不算往前跳，单测别的规矩 */
const 在 = (phase: string, node: string, 勾: { balanceSettled: boolean; acceptancePassed: boolean }, result: string | null = null) => ({ phase, node, result, ...勾 });
const 都勾 = 在("订单", "尾款结算", { balanceSettled: true, acceptancePassed: true });
const 都没勾 = 在("订单", "尾款结算", { balanceSettled: false, acceptancePassed: false });
const 没勾 = { balanceSettled: false, acceptancePassed: false };

describe("改节点问题：前后方向", () => {
  it("往前一步可以，同阶段下一个节点、跨阶段到下一阶段第一个节点都算一步", () => {
    expect(改节点问题({ phase: "线索", node: "线索验证" }, 在("线索", "潜客培育", 没勾))).toBeNull();
    expect(改节点问题({ phase: "商机", node: "明确需求" }, 在("线索", "线索推进", 没勾))).toBeNull();
  });

  it("往前跳不行，提示先推到下一个节点", () => {
    expect(改节点问题({ phase: "线索", node: "线索推进" }, 在("线索", "潜客培育", 没勾))).toBe("节点不能往前跳，只能先推到「线索验证」");
    expect(改节点问题({ phase: "订单", node: "物流运输" }, 在("线索", "潜客培育", 没勾))).toMatch("节点不能往前跳");
    expect(改节点问题({ phase: "商机", node: "共识方案" }, 在("线索", "线索推进", 没勾))).toBe("节点不能往前跳，只能先推到「明确需求」");
  });

  it("往后随便退，跨阶段退回最开始也行；原地不算跳", () => {
    expect(改节点问题({ phase: "线索", node: "潜客培育" }, 在("订单", "安装实施", 没勾))).toBeNull();
    expect(改节点问题({ phase: "商机", node: "签约审批" }, 在("订单", "生产备货", 没勾))).toBeNull();
    expect(改节点问题({ phase: "商机", node: "签约审批" }, 在("商机", "签约审批", 没勾, "丢单"))).toBeNull();
  });

  it("从异常 / 结局恢复也守同一条：退回去随便，往前只能一步", () => {
    const 异常中 = 在("订单", "物流运输", 没勾, "异常状态");
    expect(改节点问题({ phase: "订单", node: "生产备货" }, 异常中)).toBeNull();
    expect(改节点问题({ phase: "订单", node: "安装实施" }, 异常中)).toBeNull();
    expect(改节点问题({ phase: "订单", node: "验收交付" }, 异常中)).toMatch("节点不能往前跳");
  });

  it("结局也算位置：从线索直接点丢单（落在商机最后一个节点）是往前跳", () => {
    expect(改节点问题({ phase: "商机", node: "首款支付", result: "丢单" }, 在("线索", "线索推进", 没勾))).toMatch("节点不能往前跳");
    expect(改节点问题({ phase: "线索", node: "线索验证", result: "线索流失" }, 在("线索", "线索验证", 没勾))).toBeNull();
  });
});

describe("改节点问题", () => {

  it("阶段、节点、结局认不出就拦", () => {
    expect(改节点问题({ phase: "售后", node: "回访" }, 都没勾)).toMatch("没有「售后」");
    expect(改节点问题({ phase: "线索", node: "首款支付" }, 都没勾)).toMatch("没有「首款支付」");
    expect(改节点问题({ phase: "订单", node: "尾款结算", result: "已转商机" }, 都勾)).toMatch("没有「已转商机」这个结局");
  });

  it("结局只能在自己的阶段点", () => {
    expect(改节点问题({ phase: "线索", node: "线索推进", result: "丢单" }, 都没勾)).toMatch("只能在商机阶段点");
    expect(改节点问题({ phase: "商机", node: "签约审批", result: "丢单" }, 都没勾)).toBeNull();
  });

  it("成功交付：两项都勾上才让点，只勾一项写明还差哪项", () => {
    const 到 = { phase: "订单", node: "尾款结算", result: "成功交付" };
    expect(改节点问题(到, 都没勾)).toBe("还差尾款结清、验收通过，勾上才能点成功交付");
    expect(改节点问题(到, 在("订单", "尾款结算", { balanceSettled: true, acceptancePassed: false }))).toBe("还差验收通过，勾上才能点成功交付");
    expect(改节点问题(到, 在("订单", "尾款结算", { balanceSettled: false, acceptancePassed: true }))).toBe("还差尾款结清，勾上才能点成功交付");
    expect(改节点问题(到, 都勾)).toBeNull();
  });

  it("异常状态要选一个类别，备注可空、太长才拦", () => {
    const 到 = { phase: "订单", node: "安装实施", result: "异常状态" };
    expect(改节点问题(到, 都没勾)).toBe("进异常状态要选一个异常类别");
    expect(改节点问题(到, 都没勾, { 备注: "现场电压不对" })).toBe("进异常状态要选一个异常类别");
    expect(改节点问题(到, 都没勾, { categoryId: "stalled" })).toBeNull();
    expect(改节点问题(到, 都没勾, { categoryId: "stalled", 备注: "  " })).toBeNull();
    expect(改节点问题(到, 都没勾, { categoryId: "stalled", 备注: "长".repeat(501) })).toMatch("500 字以内");
  });

  it("异常状态只在订单阶段：线索、商机阶段的项目点不了，哪怕下一步就进订单", () => {
    const 类别 = { categoryId: "stalled" };
    expect(改节点问题({ phase: "订单", node: "生产备货", result: "异常状态" }, 在("商机", "首款支付", 没勾), 类别)).toBe("异常状态只在订单阶段能点");
    expect(改节点问题({ phase: "订单", node: "生产备货", result: "异常状态" }, 在("线索", "潜客培育", 没勾), 类别)).not.toBeNull();
    expect(改节点问题({ phase: "线索", node: "线索验证", result: "异常状态" }, 在("线索", "线索验证", 没勾), 类别)).toBe("「异常状态」只能在订单阶段点");
    expect(改节点问题({ phase: "订单", node: "生产备货", result: "异常状态" }, 在("订单", "生产备货", 没勾), 类别)).toBeNull();
  });
});

describe("交付还差", () => {
  it("按尾款、验收的顺序列出没勾的", () => {
    expect(交付还差(没勾)).toEqual(["尾款结清", "验收通过"]);
    expect(交付还差(都勾)).toEqual([]);
  });
});

describe("下一步", () => {
  it("同阶段往后一个节点", () => {
    expect(下一步({ phase: "线索", node: "潜客培育" })).toEqual({ phase: "线索", node: "线索验证" });
  });

  it("阶段最后一个节点往前推 = 已转商机 / 赢单，进下一阶段第一个节点", () => {
    expect(下一步({ phase: "线索", node: "线索推进" })).toEqual({ phase: "商机", node: "明确需求" });
    expect(下一步({ phase: "商机", node: "首款支付" })).toEqual({ phase: "订单", node: "生产备货" });
  });

  it("订单最后一个节点、已经有结局的，没有下一步", () => {
    expect(下一步({ phase: "订单", node: "尾款结算" })).toBeNull();
    expect(下一步({ phase: "订单", node: "安装实施", result: "异常状态" })).toBeNull();
  });
});

describe("看板列", () => {
  it("进行中的按阶段；异常留在订单列；成功交付、流失 / 丢单各一列", () => {
    expect(看板列({ phase: "商机", node: "签约审批" })).toBe("商机");
    expect(看板列({ phase: "订单", node: "安装实施", result: "异常状态" })).toBe("订单");
    expect(看板列({ phase: "订单", node: "尾款结算", result: "成功交付" })).toBe("成功交付");
    expect(看板列({ phase: "线索", node: "线索验证", result: "线索流失" })).toBe("没成");
    expect(看板列({ phase: "商机", node: "共识方案", result: "丢单" })).toBe("没成");
  });
});

describe("节点序号", () => {
  it("从潜客培育 0 排到尾款结算，一共 14 个", () => {
    expect(节点总数).toBe(14);
    expect(节点序号(第一个节点)).toBe(0);
    expect(节点序号({ phase: "商机", node: "明确需求" })).toBe(3);
    expect(节点序号({ phase: "订单", node: "尾款结算" })).toBe(13);
  });

  it("节点名不重：改节点只存名字也认得出是哪一步", () => {
    const 全部 = 阶段们.flatMap((s) => 节点们[s]);
    expect(new Set(全部).size).toBe(全部.length);
  });
});
