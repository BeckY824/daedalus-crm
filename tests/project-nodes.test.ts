/**
 * 团队版项目模式 1a：阶段 / 节点 / 结局的规矩（lib/project/nodes.ts）。
 * 钉的是总控 10-23 的「最简规则」：成功交付两项都勾才让点、异常必须有原因、
 * 已转商机 / 赢单是进下一阶段不是结局、看板每张卡落在哪一列。
 */
import { describe, it, expect } from "vitest";
import { 改节点问题, 交付还差, 下一步, 看板列, 节点序号, 节点总数, 节点们, 阶段们, 第一个节点 } from "@/lib/project/nodes";

const 都勾 = { balanceSettled: true, acceptancePassed: true };
const 都没勾 = { balanceSettled: false, acceptancePassed: false };

describe("改节点问题", () => {
  it("任意阶段的任意节点都能去，前后都行", () => {
    expect(改节点问题({ phase: "订单", node: "物流运输" }, 都没勾)).toBeNull();
    expect(改节点问题({ phase: "线索", node: "潜客培育" }, 都没勾)).toBeNull();
  });

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
    expect(改节点问题(到, { balanceSettled: true, acceptancePassed: false })).toBe("还差验收通过，勾上才能点成功交付");
    expect(改节点问题(到, { balanceSettled: false, acceptancePassed: true })).toBe("还差尾款结清，勾上才能点成功交付");
    expect(改节点问题(到, 都勾)).toBeNull();
  });

  it("异常状态必须写原因，空白不算", () => {
    const 到 = { phase: "订单", node: "安装实施", result: "异常状态" };
    expect(改节点问题(到, 都没勾)).toMatch("要写一段原因");
    expect(改节点问题(到, 都没勾, "   ")).toMatch("要写一段原因");
    expect(改节点问题(到, 都没勾, "现场电压不对，设备装不上")).toBeNull();
    expect(改节点问题(到, 都没勾, "长".repeat(501))).toMatch("500 字以内");
  });
});

describe("交付还差", () => {
  it("按尾款、验收的顺序列出没勾的", () => {
    expect(交付还差(都没勾)).toEqual(["尾款结清", "验收通过"]);
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
