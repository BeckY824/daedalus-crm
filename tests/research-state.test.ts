/**
 * 背调状态、报告文字、对话历史还原（lib/research/state.ts、report.ts、lib/thread-history.ts）。
 * 屏上看到的、存进历史的、存进客户档案的是同一份东西——这里钉着它们对得上。
 */
import { describe, it, expect } from "vitest";
import { 初始状态, 归约, 认背调状态, 来源号, 补标题, type 背调状态 } from "@/lib/research/state";
import { 报告文本, 背调标题 } from "@/lib/research/report";
import { 算相关性 } from "@/lib/research/score";
import { 历史成屏, type 历史消息 } from "@/lib/thread-history";
import type { 研究事件 } from "@/lib/research/types";

const 官网 = "https://lumora.example/about";
const 论坛 = "https://forum.example/t/1";

function 跑完(): 背调状态 {
  const 事件: 研究事件[] = [
    { type: "stage", stage: "identify", status: "running" },
    { type: "tool", stage: "identify", id: "t1", kind: "search", label: "搜索「Lumora」", status: "running" },
    { type: "tool", stage: "identify", id: "t1", kind: "search", label: "搜索「Lumora」", status: "done", result: "5 条结果", sources: [{ title: "Lumora — About us", url: 官网 }] },
    { type: "field", key: "site", value: "lumora.example", source: 官网 },
    { type: "field", key: "country", value: "德国·汉堡", source: 官网 },
    { type: "field", key: "country", value: "  " },
    { type: "stage", stage: "identify", status: "done", summary: "官网对上了" },
    { type: "tag", tone: "risk", level: "low", text: "一次付款延迟", source: 论坛 },
    { type: "score", 评分: 算相关性([{ 维度: "category", 档: "high", 证据: "户外照明", 来源: 官网 }]) },
    { type: "similar", items: [{ id: "c-1", name: "Nordlicht", 档: "mid", 像在哪: "同在德国" }], 比了: 3 },
    { type: "approach", points: ["找品类经理"] },
    { type: "usage", searches: 1, pages: 0 },
    { type: "done", charge: 6, 不完整: false },
  ];
  return 事件.reduce(归约, 初始状态({ name: "Lumora Trading GmbH" }));
}

describe("背调状态", () => {
  it("事件一条条叠成状态：工具卡按 id 合并、空值字段不收、来源按出现顺序编号去重", () => {
    const s = 跑完();
    expect(s.stages.identify.tools).toHaveLength(1);
    expect(s.stages.identify.tools[0]).toMatchObject({ status: "done", result: "5 条结果" });
    expect(s.fields.country?.value).toBe("德国·汉堡");
    expect(s.sources.map((x) => x.url)).toEqual([官网, 论坛]);
    expect(来源号(s, 论坛)).toBe(2);
    // 字段只带网址，工具卡上有真标题：补回来
    expect(补标题(s)[0].title).toBe("Lumora — About us");
  });

  it("读回来的东西不可信：缺阶段的、不是对象的当没有", () => {
    expect(认背调状态(null)).toBeNull();
    expect(认背调状态({ 目标: { name: "x" }, stages: {} })).toBeNull();
    expect(认背调状态(JSON.parse(JSON.stringify(跑完())))?.目标.name).toBe("Lumora Trading GmbH");
  });
});

describe("报告文字", () => {
  it("来源链接一条不丢：结论后面标 [n]，文末列网址；风险、老客户、建议都在", () => {
    const t = 报告文本(跑完());
    expect(t).toContain("国家 / 城市：德国·汉堡 [1]");
    expect(t).toContain("- （低）一次付款延迟 [2]");
    expect(t).toContain("- Nordlicht（中）：同在德国");
    expect(t).toContain("1. 找品类经理");
    expect(t).toContain(`[1] Lumora — About us ${官网}`);
    expect(t).toContain(`[2] ${论坛}`);
  });

  it("标题以「背调｜」开头（记录页认它找上一次背调），带分数", () => {
    expect(背调标题(跑完())).toBe("背调｜Lumora Trading GmbH · 相关性 100 分");
  });
});

describe("对话历史还原", () => {
  it("refs 里存着背调状态的那一轮，读回来还是背调卡（kind=research）", () => {
    const s = 跑完();
    const msgs: 历史消息[] = [
      { id: "u1", role: "user", text: "帮我背调 Lumora", model: null, ms: null, steps: null, refs: null, createdAt: new Date().toISOString() },
      { id: "a1", role: "assistant", text: 报告文本(s), model: null, ms: 1200, steps: [], refs: { records: [], customers: [], research: s }, createdAt: new Date().toISOString() },
      { id: "u2", role: "user", text: "张三怎么样", model: null, ms: null, steps: null, refs: null, createdAt: new Date().toISOString() },
      { id: "a2", role: "assistant", text: "还行", model: null, ms: 900, steps: [], refs: { records: [], customers: [] }, createdAt: new Date().toISOString() },
    ];
    const { turns, jobs } = 历史成屏(msgs);
    expect(turns.map((t) => [t.kind, t.公司])).toEqual([["research", "Lumora Trading GmbH"], ["ask", undefined]]);
    expect(jobs[0].value.answer?.research?.done?.charge).toBe(6);
    expect(jobs[1].value.answer?.research).toBeUndefined();
  });
});
