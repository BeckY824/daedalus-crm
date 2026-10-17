/**
 * 背调的成本和降本开关（lib/research/price.ts，10-16 总控定）：b.ai 实价、缓存读按 1/10 算、
 * 最后打分写报告固定 gpt-5.5、搜索上限 / 搜索结果量 / 成本上限都是配置、配错按默认。
 */
import { describe, it, expect } from "vitest";
import { 成本上限元, 搜索上限, 背调模型们, 搜索结果量, 读价目, 模型花费元, 搜索花费元 } from "@/lib/research/price";

describe("单价：b.ai 实价（10-16 用户截图）", () => {
  it("gpt-5.5 输入 5、缓存读 0.5、输出 30；gpt-5.4-mini 0.75 / 0.075 / 4.5（美元 / 百万 token）", () => {
    const 价 = 读价目({});
    expect(价.单价["gpt-5.5"]).toEqual({ 入: 5, 缓存: 0.5, 出: 30 });
    expect(价.单价["gpt-5.4-mini"]).toEqual({ 入: 0.75, 缓存: 0.075, 出: 4.5 });
  });

  it("命中缓存的那部分按缓存读价算；认不出的模型按最贵的估（宁可早停不超支）；搜索另加每次的搜索费", () => {
    const 价 = 读价目({});
    expect(模型花费元(价, "gpt-5.5", 1_000_000, 0)).toBeCloseTo(5 * 7.2);
    expect(模型花费元(价, "gpt-5.5", 1_000_000, 0, 1_000_000)).toBeCloseTo(0.5 * 7.2);
    expect(模型花费元(价, "gpt-5.5", 1_000_000, 0, 9_999_999)).toBeCloseTo(0.5 * 7.2);
    expect(模型花费元(价, "没见过的模型", 0, 1_000_000)).toBeCloseTo(30 * 7.2);
    expect(搜索花费元(价, "gpt-5.4-mini", 0, 0)).toBeCloseTo(0.072);
  });

  it("10-16 Rexel 那次对上账单：输入 132,254 / 输出 11,212（gpt-5.5、没缓存）≈ $1.0", () => {
    const 价 = 读价目({});
    expect(模型花费元(价, "gpt-5.5", 132_254, 11_212) / 7.2).toBeCloseTo(0.998, 2);
  });

  it("RESEARCH_PRICES 写了哪样覆盖哪样；不写缓存价就按输入价的 1/10", () => {
    const 价 = 读价目({ RESEARCH_PRICES: JSON.stringify({ 汇率: 7, 每次搜索美元: 0.02, 模型: { "gpt-5.5": { 入: 4, 出: 24 } } }) });
    expect(价.汇率).toBe(7);
    expect(价.每次搜索美元).toBe(0.02);
    expect(价.单价["gpt-5.5"]).toEqual({ 入: 4, 缓存: 0.4, 出: 24 });
    expect(价.单价["gpt-5.4-mini"]).toEqual({ 入: 0.75, 缓存: 0.075, 出: 4.5 });
  });
});

describe("降本开关", () => {
  it("最后打分写报告默认 gpt-5.5；搜索、摘要没配就跟报告一样", () => {
    expect(背调模型们({})).toEqual({ 搜索: "gpt-5.5", 摘要: "gpt-5.5", 报告: "gpt-5.5" });
    expect(背调模型们({ RESEARCH_SEARCH_MODEL: "gpt-5.4-mini", RESEARCH_SUMMARY_MODEL: "gpt-5.4-mini" })).toEqual({ 搜索: "gpt-5.4-mini", 摘要: "gpt-5.4-mini", 报告: "gpt-5.5" });
  });

  it("搜索上限默认 8，只认 3–8；搜索结果量只认 low / medium / high", () => {
    expect(搜索上限({})).toBe(8);
    expect(搜索上限({ RESEARCH_SEARCH_LIMIT: "5" })).toBe(5);
    for (const v of ["2", "9", "5.5", "五"]) expect(搜索上限({ RESEARCH_SEARCH_LIMIT: v }), v).toBe(8);
    expect(搜索结果量({ RESEARCH_SEARCH_CONTEXT: "LOW" })).toBe("low");
    expect(搜索结果量({ RESEARCH_SEARCH_CONTEXT: "tiny" })).toBeUndefined();
  });

  it("成本上限默认 10 元，RESEARCH_COST_CAP 能改，配错按默认", () => {
    expect(成本上限元({})).toBe(10);
    expect(成本上限元({ RESEARCH_COST_CAP: "1.5" })).toBe(1.5);
    expect(成本上限元({ RESEARCH_COST_CAP: "零" })).toBe(10);
  });
});
