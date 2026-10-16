/**
 * 背调对比实验的自动核对（scripts/research-bench.ts，10-16 定的评判标准）：认对公司、来源里真有、两遍稳不稳。
 */
import { describe, it, expect } from "vitest";
import { 认对了, 可核的词, 核来源, 稳定 } from "../scripts/research-bench";
import { 初始状态, 归约, type 背调状态 } from "@/lib/research/state";
import { 算相关性 } from "@/lib/research/score";
import type { 研究事件 } from "@/lib/research/types";

const 造 = (事件: 研究事件[]): 背调状态 => 事件.reduce(归约, 初始状态({ name: "Delta Light" }));

describe("认对了", () => {
  it("去掉 www、子域名也算；名单可列多个站", () => {
    expect(认对了(造([{ type: "field", key: "site", value: "www.deltalight.com" }]), ["deltalight.com"])).toBe("对");
    expect(认对了(造([{ type: "field", key: "site", value: "uk.deltalight.com" }]), ["deltalight.com"])).toBe("对");
    expect(认对了(造([{ type: "field", key: "site", value: "deltaww.com" }]), ["deltalight.com"])).toBe("错");
    expect(认对了(造([]), ["deltalight.com"])).toBe("没找到");
  });
});

describe("来源里真有这句", () => {
  it("摘数字和英文词去原文里找；全中文的记核不了；没来源的不算", () => {
    expect(可核的词("成立于 2009 年，约 40 人")).toEqual(["2009", "40"]);
    expect(可核的词("Hamburg 的 lighting 分销")).toEqual(["hamburg"]);
    const s = 造([
      { type: "field", key: "founded", value: "1993 年", source: "https://a.example" },
      { type: "field", key: "size", value: "约 300 人", source: "https://a.example" },
      { type: "field", key: "business", value: "建筑照明", source: "https://a.example" },
      { type: "field", key: "country", value: "比利时 Wevelgem" },
    ]);
    const r = 核来源(s, [{ url: "https://a.example", text: "Founded in 1993 in Wevelgem, Delta Light employs 600 people." }]);
    // 「约 300 人」：300 在原文里没有（原文是 600）——数字对不上，记一条编造嫌疑
    expect(r).toEqual({ 结论数: 4, 有来源: 3, 核得上: 1, 核不上: 1, 核不了: 1, 嫌疑: [{ 话: "约 300 人", 源: "https://a.example" }] });
  });
});

describe("稳定", () => {
  it("分差、档位一致率", () => {
    const a = 造([{ type: "score", 评分: 算相关性([{ 维度: "category", 档: "high", 证据: "x" }, { 维度: "market", 档: "mid" }]) }]);
    const b = 造([{ type: "score", 评分: 算相关性([{ 维度: "category", 档: "high", 证据: "x" }, { 维度: "market", 档: "low" }]) }]);
    const r = 稳定(a, b);
    expect(r.分差).toBe(Math.abs(a.评分!.分! - b.评分!.分!));
    expect(r.档一致).toBeCloseTo(5 / 6);
    expect(稳定(a, null)).toEqual({ 分差: null, 档一致: null });
  });
});
