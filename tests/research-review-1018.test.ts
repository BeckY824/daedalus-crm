/**
 * 10-18 免费对比复核（03-测试/背调对比免费产品-20261018-复核/汇总.md 第三、六节）提的 6 处，钉住改法：
 *   1. 查到进口记录（HMRC 名录）时，各步结论 / 切入建议里不能再写「未查到进口记录」
 *   2. 正文里的「来源:17,28」「[17]」是内部材料编号：换成【来源】列表的编号，对不上的删；开发信里一律删
 *   3. 官网首页只写品牌名（Ansell Lighting）、不写工商全称（Ansell Electrical Products Limited）也算对上
 *   4. 风险那一步：母公司定向搜一次，搜到官网的历史页（history）就读一次——被收购常只写在那
 *   5. 自己都说「无法确认是同一主体」的风险（澳洲手套公司 Ansell Ltd 的集体诉讼）不进风险清单
 *   6. 判了「是同行」：切入建议第一条先写「先确认它外不外采」
 * 不联网、不调真模型（模拟通道 + 按步骤回答的假模型），一分钱不花。
 */
import { describe, it, expect } from "vitest";
import { 跑背调, type 模型调用 } from "@/lib/research/run";
import { 模拟通道 } from "@/lib/research/mock";
import type { 背调通道 } from "@/lib/research/channel";
import type { 研究事件 } from "@/lib/research/types";
import { 初始状态, 归约 } from "@/lib/research/state";
import { 报告文本 } from "@/lib/research/report";
import { 换引用, 删引用, 去掉没查到进口 } from "@/lib/research/cite";
import { 首页有名 } from "@/lib/research/verify/site";

describe("正文引用换成【来源】编号（复核第 2 点）", () => {
  // Ansell 第 1 轮真实报告里的几处（材料编号 → 网址 → 【来源】里的位置；71 是 Companies House 页，不在【来源】里）
  const 材料 = new Map<number, string>([
    [6, "https://ansell-lighting.com/en/octo-overview"],
    [17, "https://ansell-lighting.com/en/about-us"],
    [26, "https://ansell-lighting.com/en/contact"],
    [28, "https://ansell-lighting.com/en/product-categories"],
    [70, "https://theaccounts.uk/company/04134581/ansell-electrical-products-limited/"],
    [71, "https://find-and-update.company-information.service.gov.uk/company/04134581"],
  ]);
  const 列表 = [
    "https://ansell-lighting.com/en",
    "https://ansell-lighting.com/en/contact",
    "https://ansell-lighting.com/en/about-us",
    "https://ansell-lighting.com/en/product-categories",
    "https://ansell-lighting.com/en/octo-overview",
    "https://ansell-lighting.com/en/articles/news/introducing-s19-our-biggest-catalogue-yet",
    "x7",
    "x8",
    "x9",
    "https://theaccounts.uk/company/04134581/ansell-electrical-products-limited/",
  ];
  const 换 = (t: string) => 换引用(t, (n) => 材料.get(n), 列表);

  it("「来源:17,28,70,71」→ [3][4][10]；对不上列表的（71）删掉", () => {
    expect(换("欧洲覆盖和规模较强；来源:17,28,70,71。")).toBe("欧洲覆盖和规模较强 [3][4][10]。");
    expect(换("CH显示04134581存续，官网归属仍需核对。来源:71")).toBe("CH显示04134581存续，官网归属仍需核对。");
  });
  it("碰巧撞上别的来源也换对：「来源:6」是 OCTO 页 [5]，不是列表里的 [6]", () => {
    expect(换("OCTO 是其智能照明控制方案；来源:6。")).toBe("OCTO 是其智能照明控制方案 [5]。");
  });
  it("方括号、全角括号、「（来源：17、26）」都认；换出来的 [3] 不会再被当成材料编号换一遍", () => {
    expect(换("见 [17][28] 和【70】。")).toBe("见 [3][4]和 [10]。");
    expect(换("从展厅切入（来源：17、26）")).toBe("从展厅切入 [3][2]");
    expect(换("没有引用的句子，原样。")).toBe("没有引用的句子，原样。");
  });
  it("开发信：引用一律删，换行和称呼后面的逗号都留着", () => {
    expect(删引用("Dear Purchasing Team,\n\nsupply to more than 26 countries [17]. Your categories [28, 29], which align.")).toBe(
      "Dear Purchasing Team,\n\nsupply to more than 26 countries. Your categories, which align.",
    );
  });
});

describe("查到进口记录时删掉「未查到进口记录」（复核第 1 点）", () => {
  it("只删说没查到的那一小段，后面的引用留着", () => {
    expect(去掉没查到进口("Ansell 是英国照明制造商，欧洲覆盖和规模较强，但未查到公开采购或进口记录 [3][4][10]。")).toBe("Ansell 是英国照明制造商，欧洲覆盖和规模较强 [3][4][10]。");
    expect(去掉没查到进口("没有找到提单或海关记录；在招采购经理。")).toBe("在招采购经理。");
    expect(去掉没查到进口("没有查到公开进口记录。")).toBe("");
  });
  it("别的句子不动", () => {
    expect(去掉没查到进口("HMRC 名录上 90 个月有进口，未查到再融资信息。")).toBe("HMRC 名录上 90 个月有进口，未查到再融资信息。");
  });
});

describe("官网首页认品牌名（复核第 3 点）", () => {
  it("首页只写品牌名 Ansell Lighting：拿工商全称比不上，拿品牌名比得上", () => {
    const 首页 = "Lighting Manufacturers UK Bespoke Solutions\nAnsell Lighting designs and manufactures internal and external lighting.";
    // 只给全称：域名主体「ansell lighting」和全称不够像，不拿它兜底（不然同名前缀的别家官网也会对上，见下一条）
    expect(首页有名(首页, ["Ansell Electrical Products Limited"], "ansell-lighting.com")).toBe(false);
    // 背调时程序把人输入的品牌名一起交过去（run.ts 开始核验：别名）
    expect(首页有名(首页, ["Ansell Electrical Products Limited", "Ansell Lighting"], "ansell-lighting.com")).toBe(true);
    // 人输入的是别的写法、首页写的和域名主体一样：域名主体像这家的名字才算
    expect(首页有名("Welcome to Anselllighting", ["Ansell Lighting Group"], "ansell-lighting.com")).toBe(true);
  });
  it("域名主体只在像这家公司的名字时才算：同名前缀的别家官网照样标黄（Lumexa Trading ≠ Lumexa Imaging）", () => {
    expect(首页有名("Lumexa Imaging — medical imaging systems", ["Lumexa Trading"], "lumexa-imaging.com")).toBe(false);
  });
});

/** 一家英国照明公司的模拟材料：官网、历史页（写着被 Endo 收购）、一条澳洲同名公司的集体诉讼 */
const 公司 = "Brightline Lighting";
const 官网 = "https://brightline-lighting.example";
const 历史页 = `${官网}/en/about-us/history`;
const 页: Record<string, { title: string; text: string }> = {
  [`${官网}/en/about-us`]: { title: "About Us - Brightline Lighting", text: "Brightline Lighting designs and manufactures internal and external lighting in Warrington since 1992." },
  [历史页]: { title: "History - Brightline Lighting", text: "2014: Brightline Lighting was acquired by Endo Lighting Corporation, listed on the Tokyo Stock Exchange." },
  "https://court.example/brightline-ltd-class-action": { title: "Brightline Ltd Group Proceeding", text: "Shareholder class action against Brightline Ltd (Australia, gloves)." },
};
const 进口 = { 名: "BRIGHTLINE ELECTRICAL PRODUCTS LIMITED", 月份: [{ 月: "2026-08", 编码: "94054000", 品类: "灯具" }, { 月: "2026-07", 编码: "94054000", 品类: "灯具" }], 链接: "https://api.uktradeinfo.com/Trader(1)" };

function 通道(): 背调通道 & { 读过: string[]; 搜过: string[] } {
  const 基 = 模拟通道();
  const 读过: string[] = [];
  const 搜过: string[] = [];
  return {
    ...基,
    读过,
    搜过,
    async 搜索(_r, q) {
      搜过.push(q);
      if (/owned by/.test(q)) return [{ title: "History - Brightline Lighting", url: 历史页, snippet: "Our story since 1992." }, { title: "Brightline Ltd Group Proceeding", url: "https://court.example/brightline-ltd-class-action", snippet: "class action" }];
      if (/site:(linkedin|facebook)/.test(q)) return [];
      return Object.entries(页).filter(([u]) => u !== 历史页).map(([url, p]) => ({ title: p.title, url, snippet: p.text.slice(0, 120) }));
    },
    async 读页(_r, url) {
      读过.push(url);
      const p = 页[url];
      if (!p) throw new Error("这个网址读不了");
      return { url, title: p.title, text: p.text, 截断了: false };
    },
    async 核验(请求) {
      const r = (await 基.核验(请求))!;
      return { ...r, 进口 };
    },
  };
}

/** 假模型：在各处正文里带内部材料编号、说「未查到进口记录」、把同名公司的诉讼列成风险、判同行——看程序收拾得干不干净 */
function 假模型(): 模型调用 & { 提示: string[] } {
  const 提示: string[] = [];
  const 答 = (p: string): unknown => {
    const 这步 = p.slice(p.lastIndexOf("这一步："));
    if (这步.includes("认准是哪一家")) return { 认准: true, 官网: `${官网}/en/about-us`, 全称: "Brightline Electrical Products Limited", 国家城市: "英国·Warrington", 说明: "官网对上了；来源:1", 来源: 1 };
    if (这步.includes("查基本面")) return { 字段: { business: { value: "商业 / 工业照明", source: 1 } }, 小结: "英国照明制造商，没有查到公开进口记录；来源:1,2" };
    if (这步.includes("对照我们的业务")) return { 型号: [], 小结: "品类重合 [1]" };
    if (这步.includes("找近期信号")) return { 信号: [], 小结: "查不到" };
    if (这步.includes("排查风险"))
      return {
        必查: { 母公司: { 结论: "2014 年被 Endo Lighting 收购", 级别: "mid", 来源: 历史页 }, 财务: { 结论: "查不到" }, 同行: { 结论: "自己设计制造灯具，母公司也做灯具", 是: "是", 级别: "high", 来源: 历史页 }, 市场: { 结论: "查不到" } },
        风险: [{ 级别: "low", 说明: "检索到针对Brightline Limited的股东集体诉讼及OECD指南投诉信息，但材料对象为Brightline Limited，无法确认与Brightline Lighting/Brightline Electrical Products Limited为同一主体。", 来源: "https://court.example/brightline-ltd-class-action" }],
        小结: "是同行",
      };
    if (这步.includes("怎么切入"))
      return {
        评档: [{ 维度: "category", 档: "high", 证据: "品类重合；来源:1", 来源: 1 }],
        建议: ["找 Purchasing team，推 OEM 补充产能；来源:1,99", "主推工矿灯 [2]"],
        开发信: { 主题: "OEM LED lighting", 正文: `Dear Purchasing Team,\n\n${"We make LED lights for brands in Europe and can help with extra capacity [1]. ".repeat(8)}\n\nBest regards` },
        真实性: "官网对上了。来源:99",
        小结: "英国照明制造商，但未查到公开采购或进口记录；来源:1,2",
      };
    return {};
  };
  return {
    提示,
    async tools(messages) {
      const p = messages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).join("\n");
      提示.push(p);
      return { toolCalls: [], text: JSON.stringify(答(p)) };
    },
    async json(messages) {
      const p = messages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).join("\n");
      提示.push(p);
      return 答(p);
    },
  };
}

async function 跑一次() {
  const 事件: 研究事件[] = [];
  const 道 = 通道();
  const 模 = 假模型();
  const r = await 跑背调({ 公司, b: { brief: "户外 LED 照明出口欧洲", fields: { school: "公司", grade: "职位", major: "行业" } }, 通道: 道, 模型: 模, 老客户: [], 发: (e) => 事件.push(e), runId: "run-review" });
  if (!r.ok) throw new Error(r.error);
  // 浏览器那边是拿同一串事件叠出来的：和服务端那份要一样
  const 浏览器 = 事件.reduce(归约, 初始状态({ name: 公司 }));
  return { 状态: r.状态, 浏览器, 道, 模 };
}

describe("整次背调跑下来（模拟通道 + 假模型）", () => {
  it("同一份报告不能既有进口记录、又写「未查到进口记录」（复核第 1 点）", async () => {
    const { 状态 } = await 跑一次();
    const 文 = 报告文本(状态);
    expect(文).toContain("进口记录：HMRC 进口商名录");
    const 别处 = 文.split("\n").filter((l) => !l.startsWith("进口记录："));
    expect(别处.filter((l) => /(未|没有?)(查到|找到)[^。\n]*(进口|提单|海关)/.test(l))).toEqual([]);
  });

  it("正文引用的编号都在【来源】里，没有「来源:N」这种内部编号（复核第 2 点）", async () => {
    const { 状态, 浏览器 } = await 跑一次();
    const 文 = 报告文本(状态);
    expect(文).not.toMatch(/(来源|出处)\s*[:：]\s*\d/);
    const 正文 = 文.slice(0, 文.indexOf("【来源】"));
    const 共 = 状态.sources.length;
    for (const m of 正文.matchAll(/\[(\d{1,3})\]/g)) expect(Number(m[1])).toBeLessThanOrEqual(共);
    expect(状态.开发信?.正文).not.toMatch(/\[\d/);
    expect(报告文本(浏览器)).toBe(文);
  });

  it("母公司：程序定向搜一次，搜到官网的历史页就读一次，读到的原文进了风险那一步的提示词（复核第 4 点）", async () => {
    const { 道, 模 } = await 跑一次();
    expect(道.搜过.some((q) => q.includes('"owned by"'))).toBe(true);
    expect(道.读过).toContain(历史页);
    const 风险提示 = 模.提示.filter((p) => p.slice(p.lastIndexOf("这一步：")).includes("排查风险"));
    expect(风险提示.some((p) => p.includes("acquired by Endo Lighting Corporation"))).toBe(true);
  });

  it("自己说「无法确认是同一主体」的风险不进风险清单（复核第 5 点）", async () => {
    const { 状态 } = await 跑一次();
    expect(状态.tags.filter((t) => t.tone === "risk").map((t) => t.text).join("\n")).not.toContain("集体诉讼");
    expect(报告文本(状态)).not.toContain("集体诉讼");
  });

  it("判了「是同行」：切入建议第一条先写「先确认它外不外采」，再谈 OEM（复核第 6 点）", async () => {
    const { 状态 } = await 跑一次();
    expect(状态.approach[0]).toMatch(/^先确认它外不外采/);
    expect(状态.approach.length).toBeLessThanOrEqual(3);
  });
});
