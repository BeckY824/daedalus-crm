/**
 * 背调的价钱和成本（lib/research/price.ts，10-16 总控定）：一次扣 60、配置可改、配错不变免费；成本按官方价估；重算扣次的口径。
 */
import { describe, it, expect } from "vitest";
import { 背调扣次, 成本上限元, 读价目, 模型花费元, 搜索花费元, 建议扣次 } from "@/lib/research/price";

describe("扣几次", () => {
  it("默认 60；AI_PRICE_TABLE 能改；配错、配 0、配负数一律按默认（不能变成免费）", () => {
    expect(背调扣次({})).toBe(60);
    expect(背调扣次({ AI_PRICE_TABLE: '{"research": 45}' })).toBe(45);
    for (const v of ["{坏的", '{"research": 0}', '{"research": -5}', '{"research": 2.5}', '{"ask": 1}']) expect(背调扣次({ AI_PRICE_TABLE: v }), v).toBe(60);
  });

  it("按实测平均成本重算：成本 ÷ 0.05 × 1.15，向上取整（试跑 2.6 元 → 60）", () => {
    expect(建议扣次(2.6)).toBe(60);
    expect(建议扣次(2.5)).toBe(58);
  });
});

describe("花多少", () => {
  it("上限默认 4 元，RESEARCH_COST_CAP 能改", () => {
    expect(成本上限元({})).toBe(4);
    expect(成本上限元({ RESEARCH_COST_CAP: "2.5" })).toBe(2.5);
    expect(成本上限元({ RESEARCH_COST_CAP: "零" })).toBe(4);
  });

  it("模型按 token 估；认不出的模型按最贵的估（宁可早停不超支）；搜索另加每次的搜索费", () => {
    const 价 = 读价目({});
    expect(模型花费元(价, "gpt-5.5", 1_000_000, 0)).toBeCloseTo(1.25 * 7.2);
    expect(模型花费元(价, "没见过的模型", 1_000_000, 0)).toBeCloseTo(3 * 7.2);
    expect(搜索花费元(价, "gpt-5.5", 0, 0)).toBeCloseTo(0.072);
  });

  it("RESEARCH_PRICES 写了哪样覆盖哪样", () => {
    const 价 = 读价目({ RESEARCH_PRICES: JSON.stringify({ 汇率: 7, 每次搜索美元: 0.02, 模型: { "gpt-5.5": { 入: 1, 出: 8 } } }) });
    expect(价.汇率).toBe(7);
    expect(价.每次搜索美元).toBe(0.02);
    expect(价.单价["gpt-5.5"]).toEqual({ 入: 1, 出: 8 });
    expect(价.单价["claude-sonnet-5.5"]).toEqual({ 入: 3, 出: 15 });
  });
});
