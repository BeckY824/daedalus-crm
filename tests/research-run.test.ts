/**
 * 背调的 6 步编排（lib/research/run.ts，2026-10-16）。不联网、不调真模型：通道用模拟（lib/research/mock.ts），
 * 模型用一个按「这一步」回答的假模型。钉的是编排的规矩，不是模型的本事：
 *   - 6 步按固定顺序走完，每一步都有开始和结束；分数由程序算
 *   - 搜索 / 读页的次数卡在上限（模型一直要也不给）
 *   - 来源只认材料里出现过的网址（模型编的网址丢掉）；像的老客户按编号对回清单，编号越界的丢掉
 *   - 一条材料都没拿到：收尾报「没出」（服务器据此全退）；拿到了：报「出了」，不完整的写明
 *   - 对面不吃 tools：退回 JSON 协议照样跑完
 */
import { describe, it, expect, vi } from "vitest";
import { 跑背调, 认来源, type 模型调用 } from "@/lib/research/run";
import { 模拟通道 } from "@/lib/research/mock";
import { 背调上限, 社媒搜索次数, 阶段表, type 研究事件 } from "@/lib/research/types";
import type { 背调通道 } from "@/lib/research/channel";
import type { 老客户 } from "@/lib/research/similar";
import type { 线索 } from "@/lib/research/verify/clues";
import type { 邮件信号 } from "@/lib/research/verify/mail";
import { 初始状态, 归约 } from "@/lib/research/state";
import { 报告文本 } from "@/lib/research/report";

const 公司 = "Lumora Trading GmbH";
const 官网 = "https://lumora-trading.example";

const 老客户们: 老客户[] = [
  { id: "c-1", name: "Nordlicht Elektro", 国家: "德国", 档案: "行业：电气批发", 状态: "已成交" },
  { id: "c-2", name: "Sol Andino", 国家: "智利", 档案: "", 状态: "在谈" },
];

/** 按提示词里「这一步：」后面那句认出是哪一步，回那一步该回的 JSON */
function 假结论(prompt: string): unknown {
  if (prompt.includes("认准是哪一家")) return { 认准: true, 官网: `${官网}/about`, 国家城市: "德国·汉堡", 说明: "官网和商业登记对上了", 来源: `https://registry.example/lumora-trading` };
  if (prompt.includes("查基本面"))
    return {
      字段: {
        founded: { value: "2009 年", source: `https://registry.example/lumora-trading` },
        size: { value: "约 40 人", source: `${官网}/about` },
        business: { value: "户外 / 工业 LED 照明分销", source: `${官网}/about` },
        buyerType: { value: "进口分销商", source: "https://made-up.example/x" },
        contact: { value: "sales@lumora-trading.example", source: `${官网}/about` },
      },
      联系人: [{ 岗位: "采购负责人", 姓名: "Jan Beispiel", 电话: "+49 40 0000 0000", 邮箱: "sales@lumora-trading.example", 来源: `${官网}/about` }, { 岗位: "总经理", 姓名: "Max Erfunden", 来源: `${官网}/about` }],
      小结: "汉堡的照明进口分销商",
    };
  if (prompt.includes("对照我们的业务"))
    return { 型号: [{ 型号: "HB-150", 是什么: "工矿灯", 来源: `${官网}/about` }, { 型号: "SL-60", 是什么: "路灯", 来源: `${官网}/about` }, { 型号: "ZZ-999", 是什么: "原文里没有，该丢", 来源: `${官网}/about` }], 小结: "品类和买家类型都对口" };
  if (prompt.includes("找近期信号")) return { 信号: [{ text: "在招户外照明品类经理", source: `https://jobs.example/lumora-trading-category-manager` }], 小结: "在扩户外品类" };
  if (prompt.includes("排查风险")) return { 风险: [{ 级别: "low", 说明: "2024 年有一次付款延迟", 来源: `${官网}/about/` }, { 级别: "mid", 说明: "没带来源，该丢", 来源: "https://made-up.example/z" }, { 级别: "超高", 说明: "级别写错，该丢" }], 必查: { 母公司: { 结论: "独立公司，商业登记上没有母公司", 级别: "none", 来源: `https://registry.example/lumora-trading` }, 财务: { 结论: "查不到" }, 同行: { 结论: "只做进口分销，不自己生产", 是: "否", 级别: "none", 来源: `${官网}/about` }, 市场: { 结论: "在德奥瑞做生意，正在扩户外品类", 级别: "none", 来源: `${官网}/about` } }, 小结: "风险低" };
  // 最后一步：统一打分 + 像哪位老客户 + 切入建议（产品里固定 gpt-5.5）
  if (prompt.includes("怎么切入"))
    return {
      评档: [
        { 维度: "category", 档: "high", 证据: "主营户外照明", 来源: `${官网}/about` },
        { 维度: "buyerType", 档: "high", 证据: "进口分销", 来源: `${官网}/about` },
        { 维度: "market", 档: "mid", 证据: "德奥瑞", 来源: "https://made-up.example/y" },
        { 维度: "scale", 档: "unknown" },
        { 维度: "signals", 档: "high", 证据: "在招品类经理", 来源: `https://jobs.example/lumora-trading-category-manager` },
      ],
      像的老客户: [
        { 编号: 1, 档: "high", 像在哪: "同在德国、都做电气批发" },
        { 编号: 9, 档: "high", 像在哪: "编号越界，该丢" },
      ],
      建议: ["找品类经理", "主推工矿灯", "提前给 ENEC 证书"],
      型号对比: [{ 对方: "HB-150", 我们: "UFO 工矿灯 150W", 怎么比: "同功率，我们有 ENEC 版，交期 4–5 周" }, { 对方: "XX-1", 我们: "随便", 怎么比: "对方型号认不出，该丢" }],
      开发信: { 主题: "High-bay and street lights for your outdoor range", 正文: `Dear Mr Beispiel,\n\nI noticed that ${公司} is hiring a Category Manager for Outdoor Lighting to expand its street-light and high-bay range. We are an LED lighting manufacturer in China supplying distributors in Germany, Austria and Switzerland with high-bay fixtures and street lights. Our range sits close to your HB-150 and SL-60, with ENEC and CE certified versions available, stable lead times of four to five weeks, and private-label packaging for wholesalers. Many of our distributor customers start with a small trial order to check quality before they list a product. If it is useful, I can send a sample of our closest high-bay model together with a price list for your volume range. Would you have fifteen minutes next week for a short call, or should I send the samples straight to your Hamburg office?\n\nBest regards,\nLi Wei` },
      小结: "从品类经理切入",
    };
  return {};
}

/** 提示词里的用户消息全拼起来（run.ts：「背调对象 + 材料」在前，「这一步」在最后） */
const 全文 = (messages: { role: string; content?: unknown }[]) => messages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).join("\n");

/**
 * 每一步第一次先搜一次公司名，第二次读官网 About，第三次说够了。
 * 合并结论：合并 = true 时「够了」那一次直接交这一步的结论 JSON（10-16 降本），不再单独问一次
 */
function 假模型(opts: { 一直搜?: boolean; 不吃tools?: boolean; 合并?: boolean } = {}): 模型调用 & { 调用: { kind: string; prompt: string; model?: string; messages: { role: string; content?: unknown }[] }[] } {
  const 调用: { kind: string; prompt: string; model?: string; messages: { role: string; content?: unknown }[] }[] = [];
  return {
    调用,
    async tools(messages, _tools, o) {
      const prompt = 全文(messages);
      调用.push({ kind: "tools", prompt, model: o.model, messages });
      if (opts.不吃tools) throw Object.assign(new Error("接口返回 400：tools not supported"), { status: 400 });
      const 第几 = messages.filter((m) => m.role === "tool").length;
      if (opts.一直搜) return { toolCalls: [{ id: `c${调用.length}`, type: "function", function: { name: "search_web", arguments: JSON.stringify({ query: `"${公司}" news ${调用.length}` }) } }], text: "再搜一次" };
      if (第几 === 0) return { toolCalls: [{ id: `c${调用.length}`, type: "function", function: { name: "search_web", arguments: JSON.stringify({ query: `"${公司}" hiring fair` }) } }], text: "先搜公司全名" };
      if (第几 === 1 && prompt.includes("认准是哪一家")) return { toolCalls: [{ id: `c${调用.length}`, type: "function", function: { name: "read_page", arguments: JSON.stringify({ url: `${官网}/about` }) } }], text: "读官网" };
      return { toolCalls: [], text: opts.合并 ? JSON.stringify(假结论(prompt)) : "够了" };
    },
    async json(messages, o) {
      const prompt = String(messages[messages.length - 1]?.content ?? "");
      调用.push({ kind: "json", prompt: 全文(messages), model: o.model, messages });
      // JSON 协议下的「下一步」：搜一次就够
      if (prompt.includes('"tool":"search_web"')) {
        const 搜过 = messages.some((m) => m.role === "user" && String(m.content).startsWith("结果："));
        return 搜过 ? { done: true } : { thought: "先搜", tool: "search_web", query: `"${公司}"` };
      }
      return 假结论(全文(messages));
    },
  };
}

/** 模型自己要的搜索（去掉程序发的 site:linkedin.com / site:facebook.com 那两次） */
const 模型搜的 = (搜: { mock: { calls: unknown[][] } }) => 搜.mock.calls.filter((c) => !/site:(linkedin|facebook)\.com/.test(String(c[1]))).length;

async function 跑(opts: { 模型?: 模型调用; 通道?: 背调通道; 老客户?: 老客户[]; signal?: AbortSignal; 线索?: 线索; 公司?: string; 邮件?: 邮件信号; 查IP?: (ip: string) => Promise<string | null> } = {}) {
  const 事件: 研究事件[] = [];
  const 通道 = opts.通道 ?? 模拟通道();
  const r = await 跑背调({
    公司: opts.公司 ?? 公司,
    线索: opts.线索,
    b: { brief: "户外 LED 照明出口欧洲", fields: { school: "公司", grade: "职位", major: "行业" } },
    通道,
    模型: opts.模型 ?? 假模型(),
    老客户: opts.老客户 ?? 老客户们,
    发: (e) => 事件.push(e),
    signal: opts.signal,
    runId: "run-test",
    邮件: opts.邮件,
    查IP: opts.查IP,
  });
  return { r, 事件 };
}

describe("背调 6 步编排", () => {
  it("6 步按固定顺序走完，每步先 running 后 done", async () => {
    const { r, 事件 } = await 跑();
    expect(r.ok).toBe(true);
    const 阶段事件 = 事件.filter((e): e is Extract<研究事件, { type: "stage" }> => e.type === "stage");
    const 开始顺序 = 阶段事件.filter((e) => e.status === "running").map((e) => e.stage);
    expect(开始顺序).toEqual(阶段表.map((x) => x.id));
    for (const { id } of 阶段表) {
      const i = 阶段事件.findIndex((e) => e.stage === id && e.status === "running");
      const j = 阶段事件.findIndex((e) => e.stage === id && e.status === "done");
      expect(j).toBeGreaterThan(i);
    }
    expect(事件.at(-1)).toMatchObject({ type: "done", 不完整: false });
  });

  it("分数由程序算：最后一步统一评档（含信号）；老客户那一维取最像那位的档", async () => {
    const { r } = await 跑();
    if (!r.ok) throw new Error(r.error);
    const 明细 = Object.fromEntries(r.状态.评分!.明细.map((d) => [d.维度, d]));
    expect(明细.signals.证据).toBe("在招品类经理");
    expect(明细.similar.档).toBe("high");
    expect(明细.scale.档).toBe("unknown");
    // category 25×1 + buyerType 15×1 + market 15×0.6 + signals 15×1 + similar 20×1 = 84，scale 不进分母（90）→ 93
    expect(r.状态.评分!.分).toBe(93);
  });

  it("来源只认材料里出现过的网址：编的网址认不出，那条结论不进报告（评档照留，没有角标）", async () => {
    const { r } = await 跑();
    if (!r.ok) throw new Error(r.error);
    expect(r.状态.fields.buyerType).toBeUndefined();
    expect(r.状态.fields.size).toEqual({ value: "约 40 人", source: `${官网}/about` });
    expect(r.状态.sources.some((x) => x.url.includes("made-up"))).toBe(false);
    expect(r.状态.评分!.明细.find((d) => d.维度 === "market")?.来源).toBeUndefined();
  });

  it("像的老客户按编号对回清单：越界的丢掉；风险级别写错的、没带来源的丢掉", async () => {
    const { r } = await 跑();
    if (!r.ok) throw new Error(r.error);
    expect(r.状态.similar).toEqual({ items: [{ id: "c-1", name: "Nordlicht Elektro", 档: "high", 像在哪: "同在德国、都做电气批发" }], 比了: 2 });
    expect(r.状态.tags.filter((t) => t.tone === "risk").map((t) => [t.text, t.source])).toEqual([["2024 年有一次付款延迟", `${官网}/about`]]);
    expect(r.状态.approach).toHaveLength(3);
  });

  it("没有老客户：第 6 维是「查不到」，不进分母", async () => {
    const { r } = await 跑({ 老客户: [] });
    if (!r.ok) throw new Error(r.error);
    expect(r.状态.similar).toEqual({ items: [], 比了: 0 });
    expect(r.状态.评分!.明细.find((d) => d.维度 === "similar")?.档).toBe("unknown");
  });

  it("发给模型的老客户只有名字、成交/在谈、国家、档案字段", async () => {
    const m = 假模型();
    await 跑({ 模型: m });
    const fit = m.调用.find((c) => c.kind === "json" && c.prompt.includes("最多挑 3 位，按编号回"));
    expect(fit?.prompt).toContain("1. Nordlicht Elektro｜已成交｜德国｜行业：电气批发");
    expect(fit?.prompt).toContain("2. Sol Andino｜在谈｜智利");
  });

  it("模型一直要搜：整次最多搜 背调上限.搜索 次；搜满了是预算，6 步都走完的报告不标「材料不全」（10-16 ABC 试跑 C 组误标）", async () => {
    const 通道 = 模拟通道();
    const 搜 = vi.spyOn(通道, "搜索");
    const { r, 事件 } = await 跑({ 模型: 假模型({ 一直搜: true }), 通道 });
    // 程序自己发的 LinkedIn / Facebook 定向搜索另算，不占模型的次数
    expect(模型搜的(搜)).toBe(背调上限.搜索);
    expect(搜).toHaveBeenCalledTimes(背调上限.搜索 + 社媒搜索次数);
    expect(r.ok).toBe(true);
    expect(事件.filter((e) => e.type === "stage" && e.status === "done")).toHaveLength(6);
    expect(事件.at(-1)).toMatchObject({ type: "done", 不完整: false });
  });

  it("花到单次成本上限（服务器每次搜索后报的 花费）：后面不再搜、不再读，照样出报告，标「不完整」", async () => {
    const 通道 = 模拟通道();
    const 原搜 = 通道.搜索;
    let 次 = 0;
    通道.搜索 = async (...a) => {
      const r = await 原搜(...a);
      次 += 1;
      通道.花费 = { 已花元: 4.2, 上限元: 4 };
      return r;
    };
    const 读 = vi.spyOn(通道, "读页");
    const { r, 事件 } = await 跑({ 模型: 假模型({ 一直搜: true }), 通道 });
    expect(次).toBe(1);
    expect(读).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(事件.filter((e) => e.type === "stage" && e.status === "done")).toHaveLength(6);
    expect(事件.at(-1)).toMatchObject({ type: "done", 不完整: true });
  });

  it("服务器回「花费到上限」（429）也一样停手", async () => {
    const 通道 = 模拟通道();
    const 原搜 = 通道.搜索;
    let 次 = 0;
    通道.搜索 = async (...a) => {
      次 += 1;
      if (次 > 1) throw new Error("这次背调的花费到上限了（4 元），用已经查到的出报告");
      return 原搜(...a);
    };
    const { r, 事件 } = await 跑({ 模型: 假模型({ 一直搜: true }), 通道 });
    expect(次).toBe(2);
    expect(r.ok).toBe(true);
    expect(事件.at(-1)).toMatchObject({ type: "done", 不完整: true });
  });

  it("所有模型调用带同一个编号（runId）和 feature=research：网关据此不另扣", async () => {
    const opts: unknown[] = [];
    const m = 假模型();
    const 包 = { tools: (a: never, b: never, o: never) => (opts.push(o), m.tools(a, b, o)), json: (a: never, o: never) => (opts.push(o), m.json(a, o)) };
    await 跑({ 模型: 包 as unknown as 模型调用 });
    expect(opts.length).toBeGreaterThan(6);
    for (const o of opts) expect(o).toMatchObject({ requestId: "run-test", feature: "research" });
  });

  it("一条材料都没搜到、6 步照样跑完：搜索花了钱，照常出报告、收尾报跑完（10-18「我们花钱就扣」）", async () => {
    const 通道 = { ...模拟通道(), 搜索: async () => [], 读页: async () => { throw new Error("读不了"); } } as 背调通道;
    const 收尾 = vi.spyOn(通道, "收尾");
    const { r, 事件 } = await 跑({ 通道 });
    expect(r.ok).toBe(true);
    expect(收尾).toHaveBeenCalledWith("run-test", true, expect.anything());
    expect(事件.at(-1)).toMatchObject({ type: "done", 退了: false });
  });

  it("一条材料都没拿到就出错停了：不出报告；服务器退了才说「不扣次数」", async () => {
    const 坏 = { tools: async () => { throw new Error("上游模型接口超时"); }, json: async () => { throw new Error("上游模型接口超时"); } } as unknown as 模型调用;
    const 退 = { ...模拟通道(), 收尾: async () => ({ ok: true, 退了: 1, 还剩: 3 }) } as 背调通道;
    expect((await 跑({ 通道: 退, 模型: 坏 })).r).toEqual({ ok: false, error: "上游模型接口超时，这次不扣次数", 退了: true });
    const 不退 = { ...模拟通道(), 收尾: async () => ({ ok: true, 退了: 0, 还剩: 2 }) } as 背调通道;
    expect((await 跑({ 通道: 不退, 模型: 坏 })).r).toEqual({ ok: false, error: "上游模型接口超时", 退了: false });
  });

  it("开始就被服务器拒了（次数不够）：一步都不跑", async () => {
    const 通道 = { ...模拟通道(), 开始: async () => ({ ok: false as const, error: "免费的 AI 次数已经用完" }) } as 背调通道;
    const m = 假模型();
    const { r, 事件 } = await 跑({ 通道, 模型: m });
    expect(r).toEqual({ ok: false, error: "免费的 AI 次数已经用完", 退了: false });
    expect(事件).toHaveLength(0);
    expect(m.调用).toHaveLength(0);
  });

  it("中途某一步出错：已经查到的照样出报告，标「不完整」；收尾报「没跑完、不是用户停的」，退不退服务器判断", async () => {
    const m = 假模型();
    let n = 0;
    const 坏 = { ...m, json: async (a: never, o: never) => { if (++n === 3) throw new Error("AI 响应超时，请稍后重试"); return m.json(a, o); } };
    const 通道 = 模拟通道();
    const 收尾 = vi.spyOn(通道, "收尾");
    const { r, 事件 } = await 跑({ 模型: 坏 as unknown as 模型调用, 通道 });
    expect(r.ok).toBe(true);
    expect(事件.some((e) => e.type === "stage" && e.status === "error")).toBe(true);
    expect(事件.at(-1)).toMatchObject({ type: "done", 不完整: true });
    expect(收尾).toHaveBeenCalledWith("run-test", false, expect.objectContaining({ 取消: false }));
  });

  it("服务器判定退了（收尾回 退了 > 0）：done 事件带 退了，卡片照实说「已退回」", async () => {
    const m = 假模型();
    let n = 0;
    const 坏 = { ...m, json: async (a: never, o: never) => { if (++n === 3) throw new Error("上游模型接口超时"); return m.json(a, o); } };
    const 通道 = 模拟通道();
    通道.收尾 = async () => ({ ok: true, 退了: 1, 还剩: 3 });
    const { 事件 } = await 跑({ 模型: 坏 as unknown as 模型调用, 通道 });
    expect(事件.at(-1)).toMatchObject({ type: "done", 不完整: true, 退了: true });
  });

  it("6 步都跑完：收尾报 ok、不是取消；done 不带 退了", async () => {
    const 通道 = 模拟通道();
    const 收尾 = vi.spyOn(通道, "收尾");
    const { 事件 } = await 跑({ 通道 });
    expect(收尾).toHaveBeenCalledWith("run-test", true, expect.objectContaining({ 取消: false }));
    expect(事件.at(-1)).toMatchObject({ type: "done", 不完整: false, 退了: false });
  });

  it("每次模型调用都带这是哪一步（X-Research-Stage 靠它），超时是每一趟 100 秒（retry.ts 的 背调超时）", async () => {
    const 阶段们: string[] = [];
    const m = 假模型();
    const 包 = {
      tools: (a: never, t: never, o: { researchStage?: string; timeoutMs?: number }) => (阶段们.push(o.researchStage ?? "?"), expect(o.timeoutMs).toBe(100_000), m.tools(a, t, o as never)),
      json: (a: never, o: { researchStage?: string; timeoutMs?: number }) => (阶段们.push(o.researchStage ?? "?"), expect(o.timeoutMs).toBe(100_000), m.json(a, o as never)),
    };
    await 跑({ 模型: 包 as unknown as 模型调用 });
    expect(new Set(阶段们)).toEqual(new Set(["identify", "basics", "fit", "signals", "risks", "approach"]));
  });

  it("结论回的不是合法 JSON：再要一次，不让整次背调停在这一步", async () => {
    const m = 假模型();
    let 坏过 = false;
    const 包 = { ...m, json: async (a: never, o: { researchStage?: string }) => { if (o.researchStage === "approach" && !坏过) { 坏过 = true; throw new SyntaxError("Unexpected token"); } return m.json(a, o as never); } };
    const { 事件 } = await 跑({ 模型: 包 as unknown as 模型调用 });
    expect(坏过).toBe(true);
    expect(事件.filter((e) => e.type === "stage" && e.status === "done")).toHaveLength(6);
    expect(事件.some((e) => e.type === "score")).toBe(true);
  });

  it("最后打分那一步固定推理强度（背调打分推理强度）、带着买家类型 / 市场两项的判档条件；前五步不传推理强度", async () => {
    const { 背调打分推理强度 } = await import("@/lib/research/retry");
    const 强度: [string, unknown][] = [];
    const 底 = 假模型();
    const m: 模型调用 = {
      tools: (ms, t, o) => (强度.push(["tools", o.reasoningEffort]), 底.tools(ms, t, o)),
      json: (ms, o) => (强度.push([String(ms[ms.length - 1]?.content ?? "").includes("怎么切入") ? "approach" : "json", o.reasoningEffort]), 底.json(ms, o)),
    };
    await 跑({ 模型: m });
    expect(强度.filter(([k]) => k === "approach").map(([, e]) => e)).toEqual([背调打分推理强度]);
    expect(强度.filter(([k]) => k !== "approach").every(([, e]) => e === undefined)).toBe(true);
    const 最后 = 底.调用.find((c) => c.kind === "json" && c.prompt.includes("怎么切入"))!.prompt;
    expect(最后).toContain("≥ 2 个国家");
    expect(最后).toContain("对外采购或代理同类产品");
  });

  it("最后一步被截断（思考把额度用光、正文是空的）：再要一次；给的额度是 背调输出上限 不是 2000", async () => {
    const { 截断了, 背调输出上限 } = await import("@/lib/research/retry");
    const m = 假模型();
    let 截过 = false;
    const 包 = {
      ...m,
      json: async (a: never, o: { researchStage?: string; maxTokens?: number }) => {
        expect(o.maxTokens).toBe(背调输出上限);
        if (o.researchStage === "approach" && !截过) {
          截过 = true;
          throw new 截断了();
        }
        return m.json(a, o as never);
      },
    };
    const { 事件 } = await 跑({ 模型: 包 as unknown as 模型调用 });
    expect(截过).toBe(true);
    expect(事件.some((e) => e.type === "score")).toBe(true);
  });

  it("最后一步连着两次截断：这一步报错、不当成「跑完了」（服务器那边按我们这边的失败退）", async () => {
    const { 截断了 } = await import("@/lib/research/retry");
    const m = 假模型();
    const 包 = { ...m, json: async (a: never, o: { researchStage?: string }) => { if (o.researchStage === "approach") throw new 截断了(); return m.json(a, o as never); } };
    const 通道 = 模拟通道();
    const 收尾 = vi.spyOn(通道, "收尾");
    const { 事件 } = await 跑({ 模型: 包 as unknown as 模型调用, 通道 });
    expect(事件.some((e) => e.type === "stage" && e.stage === "approach" && e.status === "error")).toBe(true);
    expect(事件.some((e) => e.type === "score")).toBe(false);
    expect(收尾).toHaveBeenCalledWith("run-test", false, expect.objectContaining({ 取消: false }));
  });

  it("用户自己停的：收尾报 取消（服务器那边不退）", async () => {
    const 停 = new AbortController();
    const m = 假模型();
    let n = 0;
    const 包 = { ...m, json: async (a: never, o: never) => { if (++n === 2) 停.abort(); return m.json(a, o); } };
    const 通道 = 模拟通道();
    const 收尾 = vi.spyOn(通道, "收尾");
    await 跑({ 模型: 包 as unknown as 模型调用, 通道, signal: 停.signal });
    expect(收尾).toHaveBeenCalledWith("run-test", false, expect.objectContaining({ 取消: true }));
  });

  it("给人看的结论不带「…」（10-18 对比免费产品第四点）：太长按整句收住，模型自己写的省略号也去掉；整份报告里没有「…」", async () => {
    const 长 = "法国 Rexel 集团的官网和法国官方企业目录都显示公司注册地址在 Paris。".repeat(12);
    const m = 假模型();
    const 包 = {
      ...m,
      json: async (a: never, o: { researchStage?: string }) => {
        const r = (await m.json(a, o as never)) as Record<string, unknown>;
        if (o.researchStage === "identify") return { ...r, 说明: 长 };
        if (o.researchStage === "basics") return { ...r, 小结: "汉堡的照明进口分销商，规模中等…" };
        return r;
      },
    };
    const { 事件 } = await 跑({ 模型: 包 as unknown as 模型调用 });
    const 认 = 事件.find((e) => e.type === "stage" && e.stage === "identify" && e.status === "done") as { summary?: string };
    expect(Array.from(认.summary ?? "").length).toBeLessThanOrEqual(300);
    expect(认.summary?.endsWith("Paris。")).toBe(true);
    const 基 = 事件.find((e) => e.type === "stage" && e.stage === "basics" && e.status === "done") as { summary?: string };
    expect(基.summary).toBe("汉堡的照明进口分销商，规模中等");
    const s = 事件.reduce(归约, 初始状态({ name: 公司 }));
    expect(报告文本(s)).not.toContain("…");
  });

  it("这一步搜到 / 读到的也带材料编号，和后面「已有材料」里同一条的编号一致（来源填编号才对得上）", async () => {
    const m = 假模型();
    await 跑({ 模型: m });
    const 回执 = m.调用.flatMap((c) => c.messages).filter((x) => x.role === "tool").map((x) => String(x.content ?? ""));
    const 读 = 回执.find((t) => t.includes("Lumora") && /^\[\d+\] /.test(t));
    expect(读).toBeDefined();
    expect(回执.some((t) => /^- \[\d+\] /m.test(t))).toBe(true);
    // 读官网那条的号，后面步骤的材料里同号同网址
    const 号 = 读!.match(/^\[(\d+)\] /)![1];
    const 后面 = m.调用.at(-1)!.prompt;
    expect(后面).toContain(`[${号}] `);
    expect(后面.split(`[${号}] `)[1].split("\n")[1]).toBe(`${官网}/about`);
  });

  it("工具不叫 web_search（中转站会把同名函数当成它自家的内置搜索吞掉）", async () => {
    const 名们: string[] = [];
    const m = 假模型();
    const 包 = { ...m, tools: (a: never, t: { function: { name: string } }[], o: never) => (名们.push(...t.map((x) => x.function.name)), m.tools(a, t as never, o)) };
    await 跑({ 模型: 包 as unknown as 模型调用 });
    expect(new Set(名们)).toEqual(new Set(["search_web", "read_page"]));
  });

  it("模型分工：每步挑工具、写摘要用摘要模型；最后打分写报告用报告模型（10-16 用户：保证最后回复的质量）", async () => {
    const 通道 = { ...模拟通道(), 模型: "gpt-5.5", 摘要模型: "gpt-5.4-mini" } as 背调通道;
    const m = 假模型();
    await 跑({ 模型: m, 通道 });
    const 最后 = m.调用.filter((c) => c.prompt.includes("最多挑 3 位，按编号回"));
    expect(最后).toHaveLength(1);
    expect(最后[0].model).toBe("gpt-5.5");
    const 其余 = m.调用.filter((c) => !c.prompt.includes("最多挑 3 位，按编号回"));
    expect(其余.length).toBeGreaterThan(5);
    for (const c of 其余) expect(c.model).toBe("gpt-5.4-mini");
  });

  it("够了的那一次直接交结论：不再单独问一次（10-16 降本）", async () => {
    const 分开 = 假模型();
    await 跑({ 模型: 分开 });
    const 合并 = 假模型({ 合并: true });
    const { r } = await 跑({ 模型: 合并 });
    expect(r.ok).toBe(true);
    // 认准 / 基本面 / 相关性 / 信号 / 风险五步各省一次单独的结论调用（10-18 相关性那步给到 2 次工具、要找型号，也轮得到「够了」）；最后一步本来就只有一次
    expect(分开.调用.length - 合并.调用.length).toBe(5);
    if (r.ok) expect(r.状态.fields.founded?.value).toBe("2009 年");
  });

  it("提示缓存：系统提示、背调对象和已有材料在前面不变，「这一步」放最后；背调模式的原话带给模型", async () => {
    const m = 假模型();
    await 跑背调({
      公司,
      需求: "帮我查 Lumora 适不适合我们",
      b: { brief: "户外 LED 照明出口欧洲", fields: { school: "公司", grade: "职位", major: "行业" } },
      通道: 模拟通道(),
      模型: m,
      老客户: [],
      发: () => {},
      runId: "run-cache",
    });
    const 首 = m.调用[0].messages;
    expect(首[0].role).toBe("system");
    expect(String(首[1].content)).toMatch(/^背调对象：Lumora Trading GmbH/);
    expect(String(首[1].content)).toContain("用户的原话：帮我查 Lumora 适不适合我们");
    expect(String(首[1].content)).toContain("已有材料：");
    expect(String(首[2].content)).toMatch(/^这一步：/);
    // 下一步的前缀 = 上一步那一段，只是材料往后多了几条：开头整段不变，缓存才命中得了
    const 第二步 = m.调用.find((c) => c.prompt.includes("查基本面"))!;
    expect(String(第二步.messages[1].content).startsWith(String(首[1].content).replace(/（还没有材料）$/, ""))).toBe(true);
  });

  it("搜索上限听服务器的（降本开关 RESEARCH_SEARCH_LIMIT）", async () => {
    const 通道 = 模拟通道();
    通道.开始 = async () => ({ ok: true, 扣了: 0, 还剩: 0, 搜索上限: 3 });
    const 搜 = vi.spyOn(通道, "搜索");
    await 跑({ 模型: 假模型({ 一直搜: true }), 通道 });
    expect(模型搜的(搜)).toBe(3);
  });

  it("对面不吃 tools：退回 JSON 协议照样跑完", async () => {
    const { r } = await 跑({ 模型: 假模型({ 不吃tools: true }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.状态.usage.searches).toBeGreaterThan(0);
  });

  it("人点了停：已经查到的出一份不完整的报告", async () => {
    const ac = new AbortController();
    const 通道 = 模拟通道();
    const 原搜 = 通道.搜索;
    let 次 = 0;
    通道.搜索 = async (...a) => {
      const r = await 原搜(...a);
      if (++次 === 2) ac.abort();
      return r;
    };
    const { r, 事件 } = await 跑({ 通道, signal: ac.signal });
    expect(r.ok).toBe(true);
    expect(事件.at(-1)).toMatchObject({ type: "done", 不完整: true });
    expect(事件.filter((e) => e.type === "stage" && e.status === "running").length).toBeLessThan(6);
  });
});

describe("真实性（10-18）", () => {
  const 取核验 = (事件: 研究事件[]) => 事件.find((e): e is Extract<研究事件, { type: "verify" }> => e.type === "verify")!;

  it("认出官网就把官网、自报的线索交给服务器直查；切入建议那一步前出 verify 事件，灯和事实原样带进提示词", async () => {
    const 通道 = 模拟通道();
    const 核 = vi.spyOn(通道, "核验");
    const m = 假模型();
    const { 事件 } = await 跑({ 模型: m, 通道, 线索: { 邮箱: ["sales@lumora-trading.example"], 电话: ["+49 40 1234567"], 税号: "DE123456789", 国家: "德国" } });
    expect(核).toHaveBeenCalledTimes(1);
    expect(核.mock.calls[0][0]).toMatchObject({ runId: "run-test", 公司: "Lumora Trading GmbH", 域名: "lumora-trading.example", 邮箱: ["sales@lumora-trading.example"], 税号: "DE123456789", 国家: "DE", 自报国家: "DE" });
    const 第几 = (f: (e: 研究事件) => boolean) => 事件.findIndex(f);
    expect(第几((e) => e.type === "verify")).toBeLessThan(第几((e) => e.type === "stage" && e.stage === "approach" && e.status === "done"));
    const v = 取核验(事件);
    expect(v.真实性.项.map((x) => x.key)).toEqual(["registry", "vat", "domain", "site", "email", "phone", "ip", "sanctions", "footprint"]);
    // 网上足迹从模拟的 LinkedIn / Facebook 搜索结果里认出来
    expect(v.真实性.项.find((x) => x.key === "footprint")).toMatchObject({ 灯: "green", 态: "已核" });
    expect(v.真实性.总灯).toBe("green");
    const 最后 = m.调用.filter((c) => c.prompt.includes("怎么切入")).at(-1)!;
    expect(最后.prompt).toContain("程序直查的真实性结果");
    expect(最后.prompt).toContain("示例登记库：Lumora Trading GmbH");
  });

  it("假公司：域名才 30 天、社媒全无 → 总灯红", async () => {
    const v = 取核验((await 跑({ 公司: "Fake Lumora Trading" })).事件);
    expect(v.真实性.项.find((x) => x.key === "footprint")).toMatchObject({ 灯: "yellow", 态: "没查到" });
    expect(v.真实性.总灯).toBe("red");
  });

  it("服务器没核成（回 null）：照样出真实性块，各项写「服务器这次没核成」，足迹照认", async () => {
    const 通道 = 模拟通道();
    通道.核验 = vi.fn(async () => null);
    const v = 取核验((await 跑({ 通道 })).事件);
    expect(v.真实性.项.find((x) => x.key === "registry")?.事实).toContain("服务器这次没核成");
    expect(v.真实性.项.find((x) => x.key === "footprint")?.灯).toBe("green");
  });

  it("带了询盘邮件（第二期）：发件 IP 在本机查国家，和自称的国家对不上就黄；没给查 IP 的就是「查不了」", async () => {
    const 邮件: 邮件信号 = { 发件人: "sales@lumora-trading.example", 发件IP: "41.58.1.2", IP来源: "最早一跳", spf: "pass", 电话: [], 跳数: 3 };
    const 查IP = vi.fn(async () => "NG");
    const v = 取核验((await 跑({ 邮件, 查IP, 线索: { 邮箱: [], 电话: [], 国家: "德国" } })).事件);
    expect(查IP).toHaveBeenCalledWith("41.58.1.2");
    const ip = v.真实性.项.find((x) => x.key === "ip")!;
    expect(ip).toMatchObject({ 灯: "yellow", 态: "已核" });
    expect(ip.事实).toContain("在尼日利亚，和对方自称的国家德国对不上");
    const 查不了 = 取核验((await 跑({ 邮件 })).事件).真实性.项.find((x) => x.key === "ip")!;
    expect(查不了).toMatchObject({ 灯: "gray", 态: "查不了" });
    const 坏 = 取核验((await 跑({ 邮件, 查IP: async () => Promise.reject(new Error("断网")) })).事件).真实性.项.find((x) => x.key === "ip")!;
    expect(坏.态).toBe("查不了");
    const 没贴 = 取核验((await 跑()).事件).真实性.项.find((x) => x.key === "ip")!;
    expect(没贴.事实).toContain("没贴询盘邮件原文");
  });

  it("制裁疑似命中：风险里也列一条「高」", async () => {
    const 通道 = 模拟通道();
    通道.核验 = async () => ({ 项: [{ key: "sanctions", 灯: "red", 态: "已核", 事实: "疑似命中", 硬红: "制裁名单疑似命中（美国 OFAC 名单上有同名单位）", 链接: [{ title: "OFAC", url: "https://sanctions.example/1" }] }] });
    const { 事件 } = await 跑({ 通道 });
    expect(事件).toContainEqual(expect.objectContaining({ type: "tag", tone: "risk", level: "high", text: "制裁名单疑似命中（美国 OFAC 名单上有同名单位）" }));
  });

  it("进口记录的来源必须是材料里的；编的来源当没有。模型那一句真实性总结进 verify-note", async () => {
    const 带进口 = (来源: string) => {
      const m = 假模型();
      const 原 = m.json.bind(m);
      m.json = async (messages, o) => {
        const r = (await 原(messages, o)) as Record<string, unknown>;
        return 全文(messages).includes("怎么切入") ? { ...r, 进口记录: { 有: true, 摘要: "2025 年从宁波进口灯具", 来源 }, 真实性: "登记和域名都对得上。" } : r;
      };
      return m;
    };
    const 真 = await 跑({ 模型: 带进口(`${官网}/about`) });
    expect(真.事件).toContainEqual({ type: "import", 有: true, 摘要: "2025 年从宁波进口灯具", source: `${官网}/about` });
    expect(真.事件).toContainEqual({ type: "verify-note", text: "登记和域名都对得上。" });
    const 编 = await 跑({ 模型: 带进口("https://made-up.example/bill-of-lading") });
    expect(编.事件).toContainEqual({ type: "import", 有: false });
  });

  it("10-18 对比免费产品：必查四项、在卖型号、联系人、型号对比、英文开发信都出来；编的型号 / 联系人格子 / 对比被丢；同行判断拿去封顶", async () => {
    const { 事件 } = await 跑();
    const 取 = <T extends 研究事件["type"]>(t: T) => 事件.find((e): e is Extract<研究事件, { type: T }> => e.type === t);
    expect(取("checks")!.项.map((x) => [x.key, x.source ? "有来源" : "无"])).toEqual([
      ["母公司", "有来源"],
      ["财务", "无"],
      ["同行", "有来源"],
      ["市场", "有来源"],
    ]);
    expect(取("models")!.items.map((m) => m.型号)).toEqual(["HB-150", "SL-60"]);
    // 总经理 Max Erfunden 原文里没有：整条丢；Jan Beispiel 那条电话邮箱都在原文里
    expect(取("contacts")!.items).toEqual([{ 岗位: "采购负责人", 姓名: "Jan Beispiel", 电话: "+49 40 0000 0000", 邮箱: "sales@lumora-trading.example", source: `${官网}/about` }]);
    expect(取("compare")!.items).toEqual([{ 对方: "HB-150", 我们: "UFO 工矿灯 150W", 怎么比: "同功率，我们有 ENEC 版，交期 4–5 周" }]);
    expect(取("email")!.主题).toBe("High-bay and street lights for your outdoor range");
    expect(取("score")!.评分.结论).toBeDefined();
    const s = 事件.reduce(归约, 初始状态({ name: 公司 }));
    const t = 报告文本(s);
    for (const 段 of ["【公开联系人】", "【在卖的型号】", "【型号对比】", "【英文开发信】", "是不是同行：只做进口分销", "近两年财务：查不到（材料里没有）", "结论："]) expect(t).toContain(段);
  });

  it("同行「是」：分数封顶 40、结论不建议优先；切入那一步的提示词带上认出的型号、要求小结不给建议", async () => {
    const m = 假模型();
    const 原 = m.json.bind(m);
    m.json = async (messages, o) => {
      const r = (await 原(messages, o)) as Record<string, unknown>;
      return 全文(messages).includes("排查风险") ? { ...r, 必查: { 同行: { 结论: "自己生产户外灯具", 是: "是", 级别: "high", 来源: `${官网}/about` } } } : r;
    };
    const { 事件 } = await 跑({ 模型: m });
    const 分 = 事件.find((e): e is Extract<研究事件, { type: "score" }> => e.type === "score")!.评分;
    expect(分.分).toBeLessThanOrEqual(40);
    expect(分.封顶?.原因.join("")).toContain("同行");
    // 同行级别 high → 也算高风险：结论先核实
    expect(分.结论?.档).toBe("先核实");
    const 切入 = m.调用.find((c) => c.prompt.includes("怎么切入"))!.prompt;
    expect(切入).toContain("型号对比：拿它在卖的这几个型号（HB-150、SL-60）");
    expect(切入).toContain("小结只写事实");
  });

  it("英国公司服务器查到 HMRC 进口记录：盖过模型那句，来源是名录那条（带标题）；名录里没有就还用模型认的", async () => {
    const 通道 = 模拟通道();
    const 原核验 = 通道.核验.bind(通道);
    const 链接 = "https://api.uktradeinfo.com/Trader(42)?$expand=Imports";
    通道.核验 = async (q, sg) => ({ ...(await 原核验(q, sg))!, 进口: { 名: "LUMORA TRADING LTD", 月份: [{ 月: "2025-03", 编码: "94054000", 品类: "灯具" }], 链接 } });
    const { 事件 } = await 跑({ 通道 });
    const 进 = 事件.find((e): e is Extract<研究事件, { type: "import" }> => e.type === "import")!;
    expect(进).toMatchObject({ 有: true, source: 链接, 来源名: "HMRC 进口商名录 · LUMORA TRADING LTD" });
    expect(进.摘要).toContain("2025-03 有 1 个月申报过进口，其中照明类（灯具）1 个月");
    expect(进.摘要).toContain("不能据此判断采购量");
    const 通道2 = 模拟通道();
    const 原2 = 通道2.核验.bind(通道2);
    通道2.核验 = async (q, sg) => ({ ...(await 原2(q, sg))!, 进口: null });
    expect((await 跑({ 通道: 通道2 })).事件).toContainEqual({ type: "import", 有: false });
  });

  it("输入的是很短的缩写：社媒按认出的登记全称搜（10-18 bench：搜「SLV」回来的是同名健身房）；全称不像、名字不短都还用输入的", async () => {
    const 带全称 = (全称: string) => {
      const m = 假模型();
      const 原 = m.json.bind(m);
      m.json = async (messages, o) => {
        const r = (await 原(messages, o)) as Record<string, unknown>;
        return 全文(messages).includes("认准是哪一家") ? { ...r, 全称 } : r;
      };
      return m;
    };
    const 社媒搜的 = async (公司: string, 全称: string) => {
      const 通道 = 模拟通道();
      const 搜 = vi.spyOn(通道, "搜索");
      await 跑({ 公司, 模型: 带全称(全称), 通道 });
      return 搜.mock.calls.map((c) => String(c[1])).filter((q) => q.includes("site:facebook.com"));
    };
    expect(await 社媒搜的("LTG", "LTG Lumora Trading GmbH")).toEqual(['"LTG Lumora Trading GmbH" site:facebook.com']);
    // 全称和输入的不像；输入的名字不短（带后缀搜反而搜不到主页）：都还用输入的
    expect(await 社媒搜的("LTG", "Nordwerk Holding AG")).toEqual(['"LTG" site:facebook.com']);
    expect(await 社媒搜的("Lumora", "Lumora Trading GmbH")).toEqual(['"Lumora" site:facebook.com']);
  });

  it("风险那一步：程序先定向搜一次母公司（owned by / parent company / acquired by / subsidiary of），名字跟社媒那次一样", async () => {
    const 通道 = 模拟通道();
    const 搜 = vi.spyOn(通道, "搜索");
    const { 事件 } = await 跑({ 通道 });
    const 查 = 搜.mock.calls.map((c) => String(c[1]));
    const 母 = 查.filter((q) => q.includes('"owned by"'));
    expect(母).toEqual([`"${公司}" ("owned by" OR "parent company" OR "acquired by" OR "subsidiary of")`]);
    // 发在风险那一步，界面上看得到
    expect(事件.some((e) => e.type === "tool" && e.stage === "risks" && e.kind === "search" && e.label.includes("owned by"))).toBe(true);
  });

  it("模型要读 LinkedIn / Facebook 的页面：不打开，告诉它只用搜索结果", async () => {
    const 通道 = 模拟通道();
    const 读 = vi.spyOn(通道, "读页");
    const m = 假模型();
    const 原 = m.tools.bind(m);
    let 要过 = false;
    m.tools = async (messages, tools, o) => {
      if (!要过 && 全文(messages).includes("认准是哪一家")) {
        要过 = true;
        return { toolCalls: [{ id: "li", type: "function", function: { name: "read_page", arguments: JSON.stringify({ url: "https://www.linkedin.com/company/lumora" }) } }], text: "看看领英" };
      }
      return 原(messages, tools, o);
    };
    await 跑({ 模型: m, 通道 });
    expect(读.mock.calls.some((c) => String(c[1]).includes("linkedin.com"))).toBe(false);
    expect(m.调用.flatMap((c) => c.messages).some((x) => x.role === "tool" && String(x.content).includes("LinkedIn / Facebook 的页面不打开"))).toBe(true);
  });
});

describe("认来源（10-17 AC 回放：mini 带来源少 16 点，原来要一字不差）", () => {
  const 材料 = [
    { n: 1, kind: "search" as const, title: "官网", url: "https://www.lumora.example/about", text: "" },
    { n: 2, kind: "read" as const, title: "招聘", url: "https://jobs.example/lumora/category-manager-2026-outdoor", text: "", 别名: "https://lumora.example/jobs" },
    { n: 3, kind: "search" as const, title: "新闻", url: "https://news.example/lumora?id=7", text: "" },
  ];
  it("编号：3、[3]、【3】、数字 3", () => {
    for (const u of ["3", "[3]", "【3】", 3]) expect(认来源(材料, u)).toBe("https://news.example/lumora?id=7");
    expect(认来源(材料, "9")).toBeUndefined();
  });
  it("网址写法不同：结尾 /、没 www、http、#、utm_ 参数、大小写", () => {
    for (const u of ["https://www.lumora.example/about/", "https://lumora.example/about", "http://www.lumora.example/about#team", "https://www.lumora.example/About?utm_source=x"])
      expect(认来源(材料, u)).toBe("https://www.lumora.example/about");
    expect(认来源(材料, "https://news.example/lumora?id=7&utm_medium=y")).toBe("https://news.example/lumora?id=7");
  });
  it("跳转前的网址（别名）、截成省略号的长网址（只认唯一一条）、一格写了几个", () => {
    expect(认来源(材料, "https://lumora.example/jobs")).toBe("https://jobs.example/lumora/category-manager-2026-outdoor");
    expect(认来源(材料, "https://jobs.example/lumora/category-mana…")).toBe("https://jobs.example/lumora/category-manager-2026-outdoor");
    expect(认来源(材料, "https://made-up.example/x；https://www.lumora.example/about")).toBe("https://www.lumora.example/about");
  });
  it("编的网址、空的、不是网址的：认不出", () => {
    for (const u of ["https://made-up.example/x", "", "官网", null, undefined, "https://lumora…"]) expect(认来源(材料, u)).toBeUndefined();
  });
});
