/**
 * 10-19 报告结构 A + D（总控 10-18 派：保留我们的直查和来源，学盲评 D 的结构），钉住：
 *   - 新几块的认法：画像、关键发现（带来源、机会 / 障碍至少一样）、产品匹配（系列名要在来源原文里）、认证提醒（代码拼、不经模型）
 *   - 最后一步拆成并行两次：切入步骤由代码拼（选切口 → 找对人 → 提案 → 先问 → 联系入口）；切入那次失败报告照出、标不完整；
 *     切入那次回老格式（建议 / 型号对比）照收
 *   - 报告文字的新顺序：结论 → 已核实 → 公司 → 关键发现 → 产品匹配 → 评分条 → 真实性 → 风险 + 认证提醒 → … → 来源；
 *     bench 的 读报告评分 照样认得出分数和档位；老报告（没有新几块）照老样子出
 * 不联网、不调真模型，一分钱不花。
 */
import { describe, it, expect } from "vitest";
import { 跑背调, type 模型调用 } from "@/lib/research/run";
import { 模拟通道 } from "@/lib/research/mock";
import type { 研究事件 } from "@/lib/research/types";
import { 初始状态, 归约, 认背调状态 } from "@/lib/research/state";
import { 报告文本, 已核实项, 待验证 } from "@/lib/research/report";
import { 认画像, 认发现, 认匹配, 认证提醒, 我们的认证, type 找材料 } from "@/lib/research/extras";
import { 读报告评分 } from "../scripts/research-bench";

const 官网 = "https://lumora-trading.example";
const 原文 = `${官网}/about`;
const 找: 找材料 = (u) => (u === 原文 || u === 1 || u === "1" ? { url: 原文, text: "Range includes the HB-150 high-bay and the SL-60 street light. Own factory in Ningbo." } : undefined);

describe("新几块的认法", () => {
  it("画像：类型没写整块不要；先验证最多 2 条", () => {
    expect(认画像({ 先验证: ["x"] })).toBeUndefined();
    expect(认画像({ 类型: "英国照明品牌商", 先验证: ["它外不外采", "起订量", "第三条不要"] })).toEqual({ 类型: "英国照明品牌商", 先验证: ["它外不外采", "起订量"] });
  });

  it("关键发现：要核得上的来源、机会 / 障碍至少一样；同一句不收两遍；最多 3 条", () => {
    const 出 = 认发现(
      [
        { 事实: "在宁波有自己的工厂", 障碍: "可能自己生产", 来源: 1 },
        { 事实: "在宁波有自己的工厂", 机会: "重复的", 来源: 1 },
        { 事实: "编的来源", 机会: "x", 来源: "https://made-up.example" },
        { 事实: "没写机会障碍", 来源: 1 },
        { 事实: "第二条", 机会: "a", 来源: 原文 },
        { 事实: "第三条", 机会: "b", 来源: 原文 },
        { 事实: "第四条", 机会: "c", 来源: 原文 },
      ],
      找,
    );
    expect(出.map((x) => x.事实)).toEqual(["在宁波有自己的工厂", "第二条", "第三条"]);
    expect(出[0]).toEqual({ 事实: "在宁波有自己的工厂", 障碍: "可能自己生产", source: 原文 });
  });

  it("产品匹配：系列名不在来源原文里的去掉；匹配度 / 开发写错的整行不要；「优先开发」也认", () => {
    const 出 = 认匹配(
      [
        { 品类: "UFO 工矿灯", 匹配: "高", 系列: ["HB-150", "编的 X9"], 开发: "优先开发", 依据: "同功率", 来源: 1 },
        { 品类: "路灯", 匹配: "超高", 系列: ["SL-60"], 开发: "优先", 来源: 1 },
        { 品类: "面板灯", 匹配: "low", 系列: [], 开发: "谨慎", 来源: "https://made-up.example" },
        { 品类: "线条灯", 匹配: "mid", 系列: ["SL-60"], 开发: "选择性", 来源: 原文 },
      ],
      找,
    );
    expect(出).toEqual([
      { 品类: "UFO 工矿灯", 匹配: "高", 开发: "优先", 系列: ["HB-150"], 依据: "同功率", source: 原文 },
      { 品类: "线条灯", 匹配: "中", 开发: "选择性", 系列: ["SL-60"], source: 原文 },
    ]);
  });

  it("认证提醒：代码按业务简介和对方国家拼；英国问 CE 还是 UKCA，中东提 SASO；不替用户下够不够的结论", () => {
    expect(我们的认证("LED 工矿灯，有 CE、RoHS、ENEC 认证，出口欧洲")).toEqual(["CE", "RoHS", "ENEC"]);
    const 英 = 认证提醒("LED 工矿灯，有 CE、RoHS 认证", "英国·谢菲尔德");
    expect(英[0]).toContain("CE / RoHS 不一定覆盖每一款产品");
    expect(英.some((x) => x.includes("UKCA"))).toBe(true);
    expect(英.some((x) => x.includes("SASO"))).toBe(false);
    const 中东 = 认证提醒("户外照明，主攻中东项目", "阿联酋·迪拜");
    expect(中东[0]).toContain("业务简介里没写认证");
    expect(中东.some((x) => x.includes("SASO"))).toBe(true);
    expect(认证提醒("户外照明", "德国")).toHaveLength(1);
  });
});

/* ---------- 跑一遍：模拟通道 + 按步骤回答的假模型 ---------- */

/** 开发信要 120–200 词（认开发信） */
const 信 = `Dear Mr Beispiel,\n\n${"We make LED high-bay fixtures and street lights for distributors in the UK and Europe, with stable lead times and private-label packaging. ".repeat(6)}Would you have fifteen minutes next week for a short call?\n\nBest regards,\nLi Wei`;

const 公司 = "Lumora Trading GmbH";
function 假结论(prompt: string, 切入回: "新" | "老" | "坏" = "新"): unknown {
  if (prompt.includes("认准是哪一家")) return { 认准: true, 官网: 原文, 国家城市: "英国·谢菲尔德", 说明: "官网和登记对上了", 来源: 原文 };
  if (prompt.includes("查基本面"))
    return { 字段: { business: { value: "户外 LED 照明分销", source: 原文 } }, 联系人: [{ 岗位: "采购负责人", 姓名: "Jan Beispiel", 邮箱: "sales@lumora-trading.example", 来源: 原文 }], 小结: "照明进口分销商" };
  if (prompt.includes("对照我们的业务")) return { 型号: [{ 型号: "HB-150", 是什么: "工矿灯", 来源: 原文 }], 小结: "对口" };
  if (prompt.includes("找近期信号")) return { 信号: [], 小结: "没有" };
  if (prompt.includes("排查风险"))
    return {
      必查: { 母公司: { 结论: "独立公司", 级别: "none", 来源: 原文 }, 财务: { 结论: "2024 年营收 1200 万欧元，盈利", 级别: "none", 来源: 原文 }, 同行: { 结论: "只做分销", 是: "否", 级别: "none", 来源: 原文 }, 市场: { 结论: "在英国做生意，刚撤出爱尔兰", 级别: "mid", 来源: 原文, 应对: "先问爱尔兰的项目还做不做" } },
      风险: [{ 级别: "low", 说明: "2024 年有一次付款延迟", 来源: 原文, 应对: "首单走 30% 预付" }],
      小结: "风险低",
    };
  if (prompt.includes("切入步骤：")) {
    if (切入回 === "坏") throw new Error("上游 500");
    if (切入回 === "老") return { 建议: ["找品类经理", "主推工矿灯"], 型号对比: [{ 对方: "HB-150", 我们: "UFO 工矿灯", 怎么比: "同功率" }] };
    return { 切入: { 切口: "模型写的", 找谁: ["Category Manager"], 提案: "3 页精简提案", 先问: ["要不要验厂"] }, 开发信: { 主题: "Hello", 正文: 信 } };
  }
  if (prompt.includes("对下面 5 项"))
    return {
      评档: [
        { 维度: "category", 档: "high", 证据: "主营户外照明", 来源: 原文 },
        { 维度: "buyerType", 档: "mid", 证据: "分销" },
        { 维度: "market", 档: "high", 证据: "英国", 来源: 原文 },
        { 维度: "scale", 档: "unknown" },
        { 维度: "signals", 档: "low", 证据: "没招人", 来源: 原文 },
      ],
      像的老客户: [],
      画像: { 类型: "英国照明进口分销商", 先验证: ["新供应商要不要验厂"] },
      发现: [{ 事实: "在宁波有自己的工厂", 障碍: "可能自己生产一部分", 来源: 原文 }],
      匹配: [{ 品类: "UFO 工矿灯", 匹配: "高", 系列: ["HB-150"], 开发: "优先", 准备: "UKCA 证书", 来源: 原文 }],
      进口记录: { 有: false },
      真实性: "登记和域名都对得上。",
      小结: "对口",
    };
  return {};
}

function 假模型(切入回: "新" | "老" | "坏" = "新"): 模型调用 {
  const 全文 = (ms: { role: string; content?: unknown }[]) => ms.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).join("\n");
  return {
    // 认准那步搜一次、读一次官网 About（型号名、系列名要在读过的原文里核），别的步骤直接交
    async tools(messages) {
      const 第几 = messages.filter((m) => m.role === "tool").length;
      if (!全文(messages).includes("这一步：认准是哪一家")) return { toolCalls: [], text: "够了" };
      if (第几 === 0) return { toolCalls: [{ id: "c1", type: "function", function: { name: "search_web", arguments: JSON.stringify({ query: `"${公司}"` }) } }], text: "先搜" };
      if (第几 === 1) return { toolCalls: [{ id: "c2", type: "function", function: { name: "read_page", arguments: JSON.stringify({ url: 原文 }) } }], text: "读官网" };
      return { toolCalls: [], text: "够了" };
    },
    async json(messages) {
      return 假结论(全文(messages), 切入回);
    },
  };
}

async function 跑(切入回: "新" | "老" | "坏" = "新") {
  const 事件: 研究事件[] = [];
  const r = await 跑背调({
    公司,
    b: { brief: "户外 LED 工矿灯和路灯，有 CE、RoHS 认证，出口欧洲", fields: { school: "公司", grade: "职位", major: "行业" } },
    通道: 模拟通道(),
    模型: 假模型(切入回),
    老客户: [],
    发: (e) => 事件.push(e),
    runId: "run-ad",
  });
  return { r, 事件, s: 事件.reduce(归约, 初始状态({ name: 公司 })) };
}

describe("最后一步拆成两次 + 切入步骤由代码拼", () => {
  it("出画像 / 关键发现 / 产品匹配 / 认证提醒；切入步骤五样按固定顺序", async () => {
    const { r, s } = await 跑();
    expect(r.ok).toBe(true);
    expect(s.画像).toEqual({ 类型: "英国照明进口分销商", 先验证: ["新供应商要不要验厂"] });
    expect(s.发现).toEqual([{ 事实: "在宁波有自己的工厂", 障碍: "可能自己生产一部分", source: 原文 }]);
    expect(s.匹配?.[0]).toMatchObject({ 品类: "UFO 工矿灯", 系列: ["HB-150"], 开发: "优先" });
    expect(s.认证提醒?.some((x) => x.includes("UKCA"))).toBe(true);
    expect(s.approach).toEqual([
      "选产品切口：先拿UFO 工矿灯切入，对标它的 HB-150；准备：UKCA 证书",
      "找对人：优先找 Category Manager（建议去找的岗位，不代表已经确认有这个人）",
      "发精简提案：3 页精简提案",
      "先问采购机制，再报价：要不要验厂",
      "联系入口：采购负责人 sales@lumora-trading.example（官网公开的），英文开发信在下面",
    ]);
    expect(s.开发信?.主题).toBe("Hello");
    // 风险的应对：必查有级别的那项、另外查到的那条都带上
    expect(s.必查?.find((x) => x.key === "市场")?.应对).toBe("先问爱尔兰的项目还做不做");
    expect(s.必查?.find((x) => x.key === "母公司")?.应对).toBeUndefined();
    expect(s.tags.find((t) => t.tone === "risk")?.应对).toBe("首单走 30% 预付");
    expect(s.done?.不完整).toBe(false);
  });

  it("切入那次失败：报告照出（有分、有画像），没有切入步骤和开发信，标材料不全", async () => {
    const { r, s } = await 跑("坏");
    expect(r.ok).toBe(true);
    expect(s.评分?.分).not.toBeNull();
    expect(s.画像).toBeDefined();
    expect(s.approach).toEqual([]);
    expect(s.开发信).toBeUndefined();
    expect(s.done?.不完整).toBe(true);
  });

  it("切入那次回了老格式（建议 / 型号对比）：照收", async () => {
    const { s } = await 跑("老");
    expect(s.approach).toEqual(["找品类经理", "主推工矿灯"]);
    expect(s.型号对比).toEqual([{ 对方: "HB-150", 我们: "UFO 工矿灯", 怎么比: "同功率" }]);
  });
});

describe("报告文字的新顺序", () => {
  it("结论 → 已核实 → 公司 → 关键发现 → 产品匹配 → 评分条 → 真实性 → 风险 → 认证提醒 → 切入步骤 → 开发信 → 各步结论 → 来源", async () => {
    const { s } = await 跑();
    const t = 报告文本(s);
    const 段 = ["【结论】", "【已核实】", "【公司】", "【关键发现】", "【产品匹配】", "【相关性】", "【真实性】", "【风险】", "【认证提醒】", "【切入步骤】", "【英文开发信】", "【各步结论】", "【来源】"];
    const 位 = 段.map((x) => t.indexOf(x));
    expect(位.every((i) => i >= 0)).toBe(true);
    expect([...位].sort((a, b) => a - b)).toEqual(位);
    expect(t).toContain("客户类型：英国照明进口分销商");
    expect(t).toContain("先弄清：新供应商要不要验厂");
    expect(t).toContain("  障碍：可能自己生产一部分");
    expect(t).toContain("- UFO 工矿灯：匹配度高，优先开发；它的系列：HB-150");
    expect(t).toContain("  要准备：UKCA 证书");
    expect(t).toContain("  应对：先问爱尔兰的项目还做不做");
    expect(t).toContain("  应对：首单走 30% 预付");
    // 已核实：有来源的财务在这里；已核的绿灯项在这里、【真实性】里不再列
    const 已核 = t.slice(t.indexOf("【已核实】"), t.indexOf("【公司】"));
    expect(已核).toContain("近两年财务：2024 年营收 1200 万欧元，盈利");
    const 核 = 已核实项(s);
    expect(核.length).toBeGreaterThan(0);
    const 真 = t.slice(t.indexOf("【真实性】"), t.indexOf("【风险】"));
    expect(真).not.toContain("工商登记：");
    expect(已核).toContain("工商登记：");
    // 评分条：查不到、没来源的标「待验证」
    expect(t).toContain("- 品类匹配：高 ●●●●●，主营户外照明");
    expect(t).toContain("- 买家类型：中 ●●●○○（待验证），分销");
    expect(t).toContain("- 规模与采购力：查不到 ○○○○○（待验证）");
    // 没查到进口：写在【公司】里
    expect(t.slice(t.indexOf("【公司】"))).toContain("进口记录：未查到公开进口记录");
  });

  it("bench 的 读报告评分 认得出新报告的分数和档位", async () => {
    const { s } = await 跑();
    const 回 = 读报告评分(报告文本(s))!;
    expect(回.评分!.分).toBe(s.评分!.分);
    expect(回.评分!.明细.map((d) => d.档)).toEqual(s.评分!.明细.map((d) => d.档));
  });

  it("老报告（存下来的、没有新几块）：没有关键发现那几块，切入还叫「切入建议」，结论照样有", async () => {
    const { s } = await 跑();
    const 老 = 认背调状态(JSON.parse(JSON.stringify({ ...s, 画像: undefined, 发现: undefined, 匹配: undefined, 认证提醒: undefined })))!;
    const t = 报告文本(老);
    expect(t).toContain("【切入建议】");
    expect(t).not.toContain("【切入步骤】");
    expect(t).not.toContain("【关键发现】");
    expect(t).toContain("结论：");
  });

  it("待验证：查不到，或者有档没来源（老客户那一维不要网上来源）", () => {
    expect(待验证({ 维度: "category", 档: "unknown" })).toBe(true);
    expect(待验证({ 维度: "category", 档: "high" })).toBe(true);
    expect(待验证({ 维度: "category", 档: "high", 来源: 原文 })).toBe(false);
    expect(待验证({ 维度: "similar", 档: "mid" })).toBe(false);
  });
});
