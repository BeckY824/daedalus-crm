/**
 * 背调对比实验的自动核对（scripts/research-bench.ts，10-16 定的评判标准）：认对公司、来源里真有、两遍稳不稳。
 */
import { describe, it, expect, vi } from "vitest";
import { 认对了, 可核的词, 核来源, 稳定, 来源比A, 录下, 回放, 读余额元, 探余额元, 预计花费元, 左右各半, 编造率of, 读报告评分, 读结果csv, type 录像 } from "../scripts/research-bench";
import { 报告文本 } from "@/lib/research/report";
import type { 背调通道 } from "../src/lib/research/channel";
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

describe("结论带来源和 A 比（10-16 晚总控定：逐家比再平均，最多比 A 低 5 个百分点）", () => {
  const 行 = (组: string, 公司: string, 有来源: number, 结论数 = 10, 错 = "") => ({ 组, 公司, 有来源, 结论数, 错 });
  it("逐家「这组 − A」取平均", () => {
    const 行们 = [行("A", "甲", 7), 行("A", "乙", 9), 行("B", "甲", 8), 行("B", "乙", 6)];
    expect(来源比A(行们, "A", "B")).toBeCloseTo((0.1 - 0.3) / 2);
  });
  it("A 或这组那家没跑成、没结论的不比；一家都比不了是 NaN", () => {
    const 行们 = [行("A", "甲", 7), 行("A", "乙", 9, 10, "超时"), 行("B", "甲", 7), 行("B", "乙", 2), 行("B", "丙", 0, 0)];
    expect(来源比A(行们, "A", "B")).toBeCloseTo(0);
    expect(来源比A([行("A", "甲", 7, 10, "超时"), 行("B", "甲", 7)], "A", "B")).toBeNaN();
  });
});

describe("A / C 同材料回放（10-17 总控定：C 不再搜索，用 A 录下的材料重放，只比模型）", () => {
  const 基 = (): 背调通道 => ({
    名: "云端",
    扣次: 0,
    模型: "m",
    async 价目() {
      return { 扣次: 0, 还剩: null };
    },
    async 开始() {
      return { ok: true, 扣了: 0, 还剩: 0, 模型: "m" };
    },
    async 搜索(_r, q) {
      if (q === "坏") throw new Error("搜索超时");
      return [{ title: q, url: `https://x.example/${encodeURIComponent(q)}`, snippet: q }];
    },
    async 读页(_r, url) {
      if (url.includes("404")) throw new Error("读不到");
      return { url, title: "页", text: `正文 ${url}`, 截断了: false };
    },
    async 核验() {
      return null;
    },
    async 收尾() {
      return null;
    },
  }) as 背调通道;

  it("录下：按发生顺序记每次搜索（带哪一步）和读页，出的错也记", async () => {
    const 录: 录像 = { 公司: "甲", 组: "A", 搜索: [], 读页: [] };
    let 步 = "identify";
    const 通道 = 录下(基(), 录, () => 步);
    await 通道.搜索("r", "甲 官网");
    步 = "risks";
    await expect(通道.搜索("r", "坏")).rejects.toThrow("搜索超时");
    await 通道.读页("r", "https://a.example/about");
    await expect(通道.读页("r", "https://a.example/404")).rejects.toThrow();
    expect(录.搜索.map((x) => [x.步, x.query, x.错 ?? x.结果?.length])).toEqual([["identify", "甲 官网", 1], ["risks", "坏", "搜索超时"]]);
    expect(录.读页.map((x) => [x.url, x.错 ?? x.页?.title])).toEqual([["https://a.example/about", "页"], ["https://a.example/404", "读不到"]]);
  });

  it("回放：不看查询词——同一步先给一字不差的、再按顺序给；这一步的用完了给别的步的；全给完了把 A 搜到过的合起来再给", async () => {
    const r = (q: string) => [{ title: q, url: `https://x.example/${q}`, snippet: q }];
    const 录: 录像 = {
      公司: "甲",
      组: "A",
      搜索: [
        { 步: "basics", query: "q1", 结果: r("q1") },
        { 步: "basics", query: "q2", 结果: r("q2") },
        { 步: "risks", query: "q3", 结果: r("q3") },
      ],
      读页: [],
    };
    const 记 = { 缺搜: 0, 补读: 0 };
    let 步 = "basics";
    const 真搜 = vi.fn();
    const b = 基();
    b.搜索 = 真搜;
    const 通道 = 回放(录, b, () => 步, 记);
    expect((await 通道.搜索("r", "Q2 "))[0].title).toBe("q2");
    expect((await 通道.搜索("r", "别的说法"))[0].title).toBe("q1");
    步 = "fit"; // A 在这一步没搜过：给别的步还没用过的
    expect((await 通道.搜索("r", "再搜"))[0].title).toBe("q3");
    步 = "risks";
    expect((await 通道.搜索("r", "x")).map((x) => x.title)).toEqual(["q1", "q2", "q3"]);
    expect(记).toEqual({ 缺搜: 0, 补读: 0 });
    expect(真搜).not.toHaveBeenCalled();
  });

  it("回放：LinkedIn / Facebook 定向搜索录像里有一字不差的就给，没有就真搜并记进录像（下一轮回放不再真搜）；不混进别的查询", async () => {
    const r = (q: string) => [{ title: q, url: `https://x.example/${encodeURIComponent(q)}`, snippet: q }];
    const 录: 录像 = { 公司: "甲", 组: "A", 搜索: [{ 步: "basics", query: "q1", 结果: r("q1") }], 读页: [] };
    const 真搜 = vi.fn(async (_id: string, q: string) => r(`真:${q}`));
    const b = 基();
    b.搜索 = 真搜;
    const 通道 = 回放(录, b, () => "verify", { 缺搜: 0, 补读: 0 });
    expect((await 通道.搜索("r", "site:linkedin.com 甲"))[0].title).toBe("真:site:linkedin.com 甲");
    expect(录.搜索.at(-1)).toMatchObject({ 步: "verify", query: "site:linkedin.com 甲" });
    // 别的查询拿不到社媒那条
    expect((await 通道.搜索("r", "q9"))[0].title).toBe("q1");
    expect((await 通道.搜索("r", "q10")).map((x) => x.title)).toEqual(["q1"]);
    // 下一轮：同一份录像，社媒那次直接给录下的
    const 再 = 回放(录, b, () => "verify", { 缺搜: 0, 补读: 0 });
    expect((await 再.搜索("r", "site:linkedin.com 甲"))[0].title).toBe("真:site:linkedin.com 甲");
    expect(真搜).toHaveBeenCalledTimes(1);
  });

  it("回放：A 一次都没搜成才算缺搜；录的时候失败的照样失败", async () => {
    const 录: 录像 = { 公司: "甲", 组: "A", 搜索: [{ 步: "basics", query: "坏", 错: "搜索超时" }], 读页: [] };
    const 记 = { 缺搜: 0, 补读: 0 };
    const 通道 = 回放(录, 基(), () => "basics", 记);
    await expect(通道.搜索("r", "坏")).rejects.toThrow("搜索超时");
    expect(await 通道.搜索("r", "再搜")).toEqual([]);
    expect(记).toEqual({ 缺搜: 1, 补读: 0 });
  });

  it("回放：A 读过的页给录下的那份（末尾 / 和 # 不算不同，读失败的照样失败）；A 没读过的现场读、记一笔补读", async () => {
    const 录: 录像 = {
      公司: "甲",
      组: "A",
      搜索: [],
      读页: [
        { url: "https://a.example/about/", 页: { url: "https://a.example/about/", title: "关于", text: "正文", 截断了: false } },
        { url: "https://a.example/404", 错: "读不到" },
      ],
    };
    const 记 = { 缺搜: 0, 补读: 0 };
    const 真读 = vi.fn(async (_r: string, url: string) => ({ url, title: "现场读的", text: "新", 截断了: false }));
    const b = 基();
    b.读页 = 真读;
    const 通道 = 回放(录, b, () => "basics", 记, () => ({ 已花元: 1, 上限元: 10 }));
    expect((await 通道.读页("r", "https://A.example/about#team")).title).toBe("关于");
    await expect(通道.读页("r", "https://a.example/404")).rejects.toThrow("读不到");
    expect((await 通道.读页("r", "https://a.example/new")).title).toBe("现场读的");
    expect(真读).toHaveBeenCalledTimes(1);
    expect(记).toEqual({ 缺搜: 0, 补读: 1 });
    expect(通道.花费).toEqual({ 已花元: 1, 上限元: 10 });
  });
});

describe("开跑前查中转站余额", () => {
  const 不够 = '{"error":{"message":"credit insufficient balance: balance=14598812 required=300000046 (request id: x)","code":"insufficient_user_quota"}}';
  it("从余额不足的回包里读出余额：积分 / 100 万 = 美元，再乘汇率", () => {
    expect(读余额元(不够, 7.2)).toBeCloseTo(105.11, 1);
    expect(读余额元('{"error":{"message":"bad request"}}', 7.2)).toBeNull();
  });
  it("探：被拒读余额；放行当足够；连不上 null；发的是 max_tokens 一千万的最小调用", async () => {
    const f = vi.fn(async () => new Response(不够, { status: 400 }));
    expect(await 探余额元("https://x/v1", "k", 7.2, f as unknown as typeof fetch)).toBeCloseTo(105.11, 1);
    const 体 = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(体.max_tokens).toBe(10_000_000);
    expect(await 探余额元("https://x/v1", "k", 7.2, (async () => Response.json({ choices: [] })) as unknown as typeof fetch)).toBe(Infinity);
    expect(await 探余额元("https://x/v1", "k", 7.2, (async () => { throw new Error("断网"); }) as unknown as typeof fetch)).toBeNull();
  });
  it("预计花费：真跑的组默认 7 元、能用录像的不算；回放组每家 1 元；写了 预计每次元 按写的", () => {
    const 组们 = [
      { 名: "A", 搜索: "gpt-5.5", 摘要: "gpt-5.5", 报告: "gpt-5.5", 标准: true },
      { 名: "C", 搜索: "gpt-5.5", 摘要: "gpt-5.4-mini", 报告: "gpt-5.5", 回放: "A" },
    ];
    expect(预计花费元(组们, ["甲", "乙"], () => false)).toBe(16);
    expect(预计花费元(组们, ["甲", "乙"], (co) => co === "甲")).toBe(9);
    expect(预计花费元([{ ...组们[0], 预计每次元: 5 }, { ...组们[1], 预计每次元: 0.8 }], ["甲"], () => false)).toBeCloseTo(5.8);
  });
});

describe("盲评左右", () => {
  it("左右各占一半（单数差一家），不会一边倒", () => {
    for (let k = 0; k < 200; k++) {
      const x = 左右各半(5);
      const 左 = x.filter(Boolean).length;
      expect(左 === 2 || 左 === 3).toBe(true);
      expect(左右各半(4).filter(Boolean).length).toBe(2);
    }
  });
});

describe("编造率（10-17 总控改：按比例和 A 比，≤ A + 3 个百分点，几遍合计）", () => {
  it("嫌疑 ÷ 带来源，几行合起来算；没有带来源的是 NaN", () => {
    expect(编造率of([{ 嫌疑: 11, 有来源: 90 }, { 嫌疑: 8, 有来源: 88 }])).toBeCloseTo(19 / 178);
    expect(编造率of([{ 嫌疑: 0, 有来源: 0 }])).toBeNaN();
  });
});

describe("--只出汇总：从上次的 results.csv 和报告 txt 读回来", () => {
  it("报告 txt 里读回总分和各项档位，和原来的状态比分差 0、档位全一致", () => {
    const a = 造([{ type: "score", 评分: 算相关性([{ 维度: "category", 档: "high", 证据: "x" }, { 维度: "market", 档: "mid", 证据: "德奥" }, { 维度: "buyerType", 档: "low" }]) }]);
    const 回 = 读报告评分(报告文本(a));
    expect(稳定(a, 回)).toEqual({ 分差: 0, 档一致: 1 });
    expect(读报告评分("Rexel 背调\n\n【公司】\n规模：大")).toBeNull();
  });
  it("csv：去 BOM，引号里的逗号 / 双引号 / 换行原样回来", () => {
    expect(读结果csv('\uFEFF组,公司,错\nA,Rexel,\nC,"S, LV","说""超时""\n第二行"')).toEqual([
      { 组: "A", 公司: "Rexel", 错: "" },
      { 组: "C", 公司: "S, LV", 错: '说"超时"\n第二行' },
    ]);
  });
});
