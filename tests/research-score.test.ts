import { describe, it, expect } from "vitest";
import { 算相关性, 清洗评档, 默认权重, 信息不足门槛, type 评档 } from "@/lib/research/score";

const 全高: 评档[] = [
  { 维度: "category", 档: "high", 证据: "官网产品页：户外照明", 来源: "https://a.example" },
  { 维度: "buyerType", 档: "high", 证据: "分销商", 来源: "https://a.example" },
  { 维度: "market", 档: "high", 证据: "德国", 来源: "https://a.example" },
  { 维度: "scale", 档: "high", 证据: "60 人", 来源: "https://a.example" },
  { 维度: "signals", 档: "high", 证据: "在招品类经理", 来源: "https://b.example" },
  { 维度: "similar", 档: "high", 证据: "和老客户 Nordlicht 同在德国、都做工程分销" },
];

describe("背调相关性打分", () => {
  it("默认权重合计 100", () => {
    expect(Object.values(默认权重).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("六维全高 = 100，可信度 1", () => {
    const r = 算相关性(全高);
    expect(r.分).toBe(100);
    expect(r.可信度).toBe(1);
    expect(r.信息不足).toBe(false);
  });

  it("「信息不足」不算 0 分：不知道的维度不进分母，另报可信度", () => {
    const 缺规模 = 全高.map((x) => (x.维度 === "scale" ? { ...x, 档: "unknown" as const } : x));
    const r = 算相关性(缺规模);
    expect(r.分).toBe(100); // 查到的五维都高
    expect(r.可信度).toBe(0.9);
    expect(r.明细.find((d) => d.维度 === "scale")?.得分).toBeNull();
  });

  it("查到的太少就标信息不足；一维都没查到，分是 null", () => {
    const 只有品类 = 清洗评档([{ 维度: "category", 档: "high", 证据: "x" }]);
    const r = 算相关性(只有品类);
    expect(r.可信度).toBeLessThan(信息不足门槛);
    expect(r.信息不足).toBe(true);
    expect(算相关性(清洗评档([])).分).toBeNull();
  });

  it("档位按权重折算：品类中、其余高 → 25×0.6 + 75 = 90", () => {
    const r = 算相关性(全高.map((x) => (x.维度 === "category" ? { ...x, 档: "mid" as const } : x)));
    expect(r.分).toBe(90);
  });

  it("风险单列，不从相关性里扣；级别取最高", () => {
    const r = 算相关性(全高, [
      { 级别: "low", 说明: "论坛提到账期长" },
      { 级别: "mid", 说明: "两起付款投诉" },
    ]);
    expect(r.分).toBe(100);
    expect(r.风险级别).toBe("mid");
  });

  it("权重可调，先归一：只看品类时，品类高就是 100", () => {
    const r = 算相关性(全高.map((x) => (x.维度 === "category" ? x : { ...x, 档: "low" as const })), [], { category: 1, buyerType: 0, market: 0, scale: 0, signals: 0, similar: 0 });
    expect(r.分).toBe(100);
  });

  it("模型回来的东西不可信：缺维度补 unknown、写错的档当 unknown、重复的维度取第一条、英文键也认", () => {
    const x = 清洗评档([
      { dimension: "category", grade: "high", evidence: "LED", source: "https://a.example" },
      { 维度: "category", 档: "low" },
      { 维度: "market", 档: "超级高" },
      { 维度: "不存在", 档: "high" },
      null,
    ]);
    expect(x).toHaveLength(6);
    expect(x.find((d) => d.维度 === "category")).toMatchObject({ 档: "high", 证据: "LED" });
    expect(x.find((d) => d.维度 === "market")?.档).toBe("unknown");
    expect(x.find((d) => d.维度 === "signals")?.档).toBe("unknown");
  });

  it("没有老客户：「像不像老客户」是 unknown，不进分母、不拉低分数", () => {
    const 没老客户 = 全高.map((x) => (x.维度 === "similar" ? { 维度: "similar" as const, 档: "unknown" as const } : x));
    const r = 算相关性(没老客户);
    expect(r.分).toBe(100);
    expect(r.可信度).toBe(0.8);
  });

  it("说「高」却没证据，降成「中」", () => {
    expect(清洗评档([{ 维度: "scale", 档: "high" }]).find((d) => d.维度 === "scale")?.档).toBe("mid");
  });
});
