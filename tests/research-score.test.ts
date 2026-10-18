import { describe, it, expect } from "vitest";
import { 算相关性, 清洗评档, 默认权重, 信息不足门槛, 定结论, type 评档 } from "@/lib/research/score";

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

describe("封顶和结论（10-18 对比免费产品第三点：可信度 40% 拿 96 分、同行也满分）", () => {
  const 只 = (...keys: 评档["维度"][]) => 全高.map((x) => (keys.includes(x.维度) ? x : { ...x, 档: "unknown" as const }));

  it("可信度 < 50% 最多 50 分；50%–70% 最多 70 分；70% 以上不压。原分照留，原因写明", () => {
    const 低 = 算相关性(只("category", "buyerType")); // 25 + 15 = 40%
    expect(低).toMatchObject({ 分: 50, 原分: 100, 可信度: 0.4, 封顶: { 上限: 50, 原因: ["可信度 40%（查到的维度不到一半），最多 50 分"] } });
    const 中 = 算相关性(只("category", "buyerType", "similar")); // 60%
    expect(中).toMatchObject({ 分: 70, 原分: 100, 封顶: { 上限: 70 } });
    const 高 = 算相关性(只("category", "buyerType", "similar", "market")); // 75%
    expect(高.分).toBe(100);
    expect(高.封顶).toBeUndefined();
  });

  it("原分本来就不高于上限：不算封顶", () => {
    const r = 算相关性([{ 维度: "category", 档: "low", 证据: "只做室内" }]);
    expect(r.分).toBe(20);
    expect(r.封顶).toBeUndefined();
  });

  it("同行：是 → 最多 40 分、结论不建议优先；部分 → 最多 70 分；几条同时成立取最低", () => {
    const 是 = 算相关性(全高, [], {}, { 同行: "是" });
    expect(是).toMatchObject({ 分: 40, 原分: 100, 结论: { 档: "不优先" } });
    expect(是.结论?.字).toContain("同行");
    expect(算相关性(全高, [], {}, { 同行: "部分" })).toMatchObject({ 分: 70, 结论: { 档: "可以试" } });
    const 两条 = 算相关性(只("category"), [], {}, { 同行: "部分" });
    expect(两条.分).toBe(50);
    expect(两条.封顶?.原因).toHaveLength(2);
    expect(算相关性(全高, [], {}, { 同行: "否" }).分).toBe(100);
    expect(算相关性(全高, [], {}, { 同行: "查不到" }).分).toBe(100);
  });

  it("结论只按最后的分：≥75 重点、50–74 可以试、<50 不优先；有高风险先核实；一维没查到说不知道", () => {
    expect(定结论(75, [], false).档).toBe("重点");
    expect(定结论(74, [], false).档).toBe("可以试");
    expect(定结论(50, [], false).档).toBe("可以试");
    expect(定结论(49, [], false).档).toBe("不优先");
    expect(定结论(90, [{ 级别: "high", 说明: "母公司在重组" }], false)).toEqual({ 档: "先核实", 字: "先核实风险再决定：母公司在重组" });
    expect(定结论(90, [{ 级别: "mid", 说明: "x" }], false).档).toBe("重点");
    expect(定结论(null, [], true).档).toBe("不知道");
    expect(定结论(50, [], true).字).toContain("信息不足，仅供参考");
    // 分数和结论一致：可信度低的高分被压到 50，结论跟着是「可以试」而不是「重点」
    expect(算相关性(只("category", "buyerType")).结论?.档).toBe("可以试");
  });
});
