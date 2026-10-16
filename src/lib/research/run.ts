import { randomUUID } from "node:crypto";
/**
 * 背调的 6 步编排（2026-10-16）。
 *
 * **顺序由程序定，不让模型自己决定**：认准公司 → 基本面 → 相关性 → 近期信号 → 风险 → 切入建议。
 * 每一步里模型只能做三件事：search_web、read_page、说「这一步够了」——在本步和整次的上限之内。
 *
 * **工具不能叫 web_search**（10-16 对比实验试跑踩到）：中转站把 Claude 的 OpenAI 兼容接口里叫 web_search 的函数
 * 当成它自家内置的联网搜索吞掉了，模型那边只看得到 read_page，回一句「我没有搜索工具」，整次一条材料都没有。
 * 够了以后单独问一次「这一步的结论」（JSON），程序校验后变成事件推给浏览器。
 *
 * 为什么不是一个大 agent 自己跑到底：
 *   - 界面要「一步一步展开」，模型自己跑的话哪一步在干什么只能靠猜；
 *   - 上限要卡得住：整次最多搜 8 次、读 10 页（types.ts 背调上限），一个大循环里模型会把额度花在第一步上；
 *   - 评分要稳：模型只评档给证据，分数由 score.ts 算（同一家跑两次一个分）。
 *
 * 材料（搜到的、读到的）在 6 步之间共用：第 5 步查风险时能看到第 1 步读过的官网，不用再读一遍。
 *
 * 计费：开跑前 通道.开始() 扣一次背调的次数（服务器那边，见 api/gateway/v1/research/start）；
 * 所有模型调用带同一个编号（runId），网关认得是同一次背调、不再另扣。
 * 一条材料都没拿到就收工的（搜不到、第一步就出错、开头就被停）全退；拿到了材料就出报告，不完整的写明。
 */
import type { chatTools, ToolMessage, 工具声明, 工具调用 } from "../llm";
import type { BusinessConfig } from "../business-config";
import type { 背调通道 } from "./channel";
import { 背调上限, 阶段表, 字段表, type 研究事件, type 阶段号, type 字段键, type 来源 } from "./types";
import { 算相关性, 清洗评档, type 评档, type 风险 } from "./score";
import { 认像的老客户, 老客户表文本, 老客户维度档, type 老客户 } from "./similar";
import { 初始状态, 归约, type 背调状态 } from "./state";

type ChatOpts = NonNullable<Parameters<typeof chatTools>[2]>;

export type 模型调用 = {
  tools(messages: ToolMessage[], tools: 工具声明[], opts: ChatOpts): Promise<{ toolCalls: 工具调用[]; text: string }>;
  json(messages: ToolMessage[], opts: ChatOpts): Promise<unknown>;
};

export type 背调输入 = {
  公司: string;
  /** 从客户详情页发起的：这位客户的 id 和档案里已有的线索（国家、官网、备注），帮第一步认准 */
  客户?: { id: string; 已知: string };
  /** 背调模式里用户输入的那句原话（「帮我查 Rexel 适不适合我们」）：带给模型，让它知道人关心什么 */
  需求?: string;
  b: Pick<BusinessConfig, "brief" | "fields">;
  通道: 背调通道;
  模型: 模型调用;
  老客户: 老客户[];
  发: (e: 研究事件) => void;
  signal?: AbortSignal;
  /** 测试用：固定编号 */
  runId?: string;
};

export type 背调结果 =
  | {
      ok: true;
      状态: 背调状态;
      runId: string;
      /** 这次查到的全部材料（网址 + 正文）。产品里不用；对比实验拿它核「来源里真有这句」（scripts/research-bench.ts） */
      材料: { url: string; text: string }[];
    }
  | { ok: false; error: string; 退了: boolean };

/** 每一步最多几次工具调用（搜 + 读合计）。整次还受 背调上限 管，哪个先到算哪个 */
const 每步工具上限: Record<阶段号, number> = { identify: 3, basics: 3, fit: 1, signals: 3, risks: 3, approach: 0 };

/** 每一步要查清什么。写给模型看的，也是界面上那一步的意思 */
const 本步目标: Record<阶段号, string> = {
  identify: "认准是哪一家：找到它的官网和至少一个独立来源（工商登记、名录、行业媒体），排除同名公司。名字里有 GmbH / Ltd / S.A. 之类的，按对应国家找。",
  basics: "查基本面：国家城市、成立年份、规模（员工 / 门店 / 营收，有什么写什么）、主营产品、买家类型（进口商 / 分销商 / 品牌商 / 工程商 / 零售）、公开的联系方式。",
  fit: "对照我们的业务，判断它和我们相不相关：品类重合、买家类型对不对、市场和认证、规模和采购力；再和我们的老客户比像不像。材料不够可以再查一次。",
  signals: "找近期信号：在招人（尤其采购 / 品类岗位）、扩品类、开新店、参展、融资、新闻。优先近一年的。",
  risks: "排查风险：付款纠纷、投诉、诉讼、破产 / 清算、被制裁、负面新闻、和我们是同行（竞争对手）。查不到负面就说查不到，不要编。",
  approach: "根据前面查到的，给出怎么切入：找谁、用什么话题开口、主推哪类产品、注意什么。",
};

const 工具表: 工具声明[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "上网搜索。查询词用英文或这家公司所在国的语言，带上公司名；一次只查一件事。",
      parameters: { type: "object", properties: { query: { type: "string", description: "搜索词" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description: "读一个网页的正文。只读搜索结果里出现过的网址，优先官网、登记信息、招聘页。",
      parameters: { type: "object", properties: { url: { type: "string", description: "网址，http(s) 开头" } }, required: ["url"] },
    },
  },
];

type 材料条 = { n: number; kind: "search" | "read"; title: string; url: string; text: string };

/**
 * 拼进提示词的材料：读过的页给 1500 字，搜索摘要给 300 字，整份封顶 30000 字（越新的越靠后、越不会被截）。
 * 封顶放宽到 30000（原来 14000）：截的是最前面那几条，一截前缀就变了、提示缓存就不命中；正常一次背调到不了这个数
 */
function 材料文本(材料: 材料条[]): string {
  if (!材料.length) return "（还没有材料）";
  const 段 = 材料.map((m) => `[${m.n}] ${m.title}\n${m.url}\n${m.text.slice(0, m.kind === "read" ? 1500 : 300)}`);
  let 出 = 段.join("\n\n");
  while (出.length > 30000 && 段.length > 1) {
    段.shift();
    出 = "（更早的材料略）\n\n" + 段.join("\n\n");
  }
  return 出;
}

function 系统提示(b: 背调输入["b"]): string {
  return (
    "你在帮一家外贸公司做客户背景调查（背调），用中文写结论。我们的业务：" + (b.brief?.trim() || "（未填写）") + "\n" +
    "规矩：只依据搜索和网页材料说话，材料里没有的写「查不到」，不许编；每条结论尽量注明来源网址（必须是材料里出现过的网址）；" +
    "同名公司要分清，拿不准就说拿不准。"
  );
}

/** 模型直接交回来的结论：去掉代码块标记，解得出对象才算 */
function 认JSON(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function 解参数(s: string): Record<string, unknown> {
  const v = JSON.parse(s || "{}") as unknown;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

const 短 = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");
const 是网址 = (s: unknown): s is string => typeof s === "string" && /^https?:\/\/\S+$/i.test(s.trim());

export async function 跑背调(input: 背调输入): Promise<背调结果> {
  const runId = input.runId ?? randomUUID();
  const { 通道, 模型, signal } = input;
  let 状态 = 初始状态({ name: input.公司, customerId: input.客户?.id });
  const 发 = (e: 研究事件) => {
    状态 = 归约(状态, e);
    input.发(e);
  };

  const 开 = await 通道.开始(runId, signal);
  if (!开.ok) return { ok: false, error: 开.error, 退了: false };
  // 这次最多搜几次听服务器的（RESEARCH_SEARCH_LIMIT，降本开关）；老服务器不回就按默认
  const 搜索上限 = 开.搜索上限 && 开.搜索上限 > 0 ? Math.min(开.搜索上限, 背调上限.搜索) : 背调上限.搜索;

  const 材料: 材料条[] = [];
  const 读过 = new Set<string>();
  let 搜索数 = 0;
  let 读页数 = 0;
  let 不完整 = false;
  /**
   * 单次成本硬上限（lib/research/price.ts，默认 4 元）：服务器每次搜索 / 读页都回「到现在花了多少」（通道.花费），
   * 到了就不再调工具——后面几步只用已有材料下结论，报告写「材料不全」。服务器那头到了也不再给搜、给读（429）
   */
  let 钱到了 = false;
  const 看钱 = (错?: string) => {
    const f = 通道.花费;
    if ((f && f.已花元 >= f.上限元) || (错 && /花费到上限/.test(错))) {
      钱到了 = true;
      不完整 = true;
    }
  };
  let 工具号 = 0;
  /** 每一步挑工具、写摘要用摘要模型（可以是便宜的 mini）；最后打分写报告那一步单独传报告模型（通道.模型，固定 gpt-5.5） */
  const opts = (超时: number, 模型名?: string): ChatOpts => ({ model: 模型名 ?? 通道.摘要模型 ?? 通道.模型, signal, requestId: runId, feature: "research", temperature: 0, thinking: false, timeoutMs: 超时, maxTokens: 2000 });
  /** 用原生 function calling；对面不吃 tools 时退回 JSON 协议（和首页 agent 同一个判断） */
  let 用原生 = true;

  const 搜 = async (stage: 阶段号, query: string): Promise<string> => {
    if (搜索数 >= 搜索上限) {
      不完整 = true;
      return "这次背调的搜索次数用完了，请用已有材料。";
    }
    搜索数 += 1;
    const id = `t${++工具号}`;
    const label = `搜索「${query.slice(0, 60)}」`;
    const t0 = Date.now();
    发({ type: "tool", stage, id, kind: "search", label, status: "running" });
    try {
      const rs = await 通道.搜索(runId, query, signal);
      const 新: 来源[] = [];
      for (const r of rs) {
        if (!是网址(r.url)) continue;
        材料.push({ n: 材料.length + 1, kind: "search", title: r.title || r.url, url: r.url, text: r.snippet ?? "" });
        新.push({ title: r.title || r.url, url: r.url });
      }
      发({ type: "tool", stage, id, kind: "search", label, status: "done", result: `${rs.length} 条结果`, ms: Date.now() - t0, sources: 新.slice(0, 6) });
      发({ type: "usage", searches: 搜索数, pages: 读页数 });
      看钱();
      return rs.length ? rs.map((r) => `- ${r.title}\n  ${r.url}\n  ${(r.snippet ?? "").slice(0, 300)}`).join("\n") : "没有搜到结果，换个说法或换个角度再搜。";
    } catch (e) {
      if (signal?.aborted) throw e;
      const msg = e instanceof Error ? e.message : "搜索出错";
      发({ type: "tool", stage, id, kind: "search", label, status: "error", result: msg.slice(0, 60), ms: Date.now() - t0 });
      看钱(msg);
      return `搜索失败：${msg}`;
    }
  };

  const 读 = async (stage: 阶段号, url: string): Promise<string> => {
    if (读过.has(url)) return "这一页前面已经读过，内容在材料里。";
    if (读页数 >= 背调上限.读页) {
      不完整 = true;
      return "这次背调能读的页数用完了，请用已有材料。";
    }
    读页数 += 1;
    读过.add(url);
    const id = `t${++工具号}`;
    const 名 = 材料.find((m) => m.url === url)?.title ?? url.replace(/^https?:\/\//, "").slice(0, 50);
    const label = `读「${名.slice(0, 50)}」`;
    const t0 = Date.now();
    发({ type: "tool", stage, id, kind: "read", label, status: "running" });
    try {
      const p = await 通道.读页(runId, url, signal);
      材料.push({ n: 材料.length + 1, kind: "read", title: p.title || 名, url: p.url || url, text: p.text });
      const 字 = p.text.length >= 1000 ? `${(p.text.length / 1000).toFixed(1)}k 字` : `${p.text.length} 字`;
      发({ type: "tool", stage, id, kind: "read", label, status: "done", result: `1 页 · ${字}`, ms: Date.now() - t0, sources: [{ title: p.title || 名, url: p.url || url }] });
      发({ type: "usage", searches: 搜索数, pages: 读页数 });
      看钱();
      return `${p.title}\n${p.text.slice(0, 4000)}`;
    } catch (e) {
      if (signal?.aborted) throw e;
      const msg = e instanceof Error ? e.message : "读不了";
      发({ type: "tool", stage, id, kind: "read", label, status: "error", result: msg.slice(0, 60), ms: Date.now() - t0 });
      看钱(msg);
      return `读不了：${msg}`;
    }
  };

  /*
    提示缓存（降本，10-16）：每一步的请求都是「系统提示 + 背调对象 + 已有材料」打头、「这一步要做什么」放最后。
    材料只往后加不往前插，所以前一步发过的那一整段就是这一步的前缀——中转站按缓存读价收（输入价的 1/10）
  */
  const 前缀 = (): ToolMessage[] => [
    { role: "system", content: 系统提示(input.b) },
    {
      role: "user",
      content:
        `背调对象：${input.公司}\n${input.客户 ? `CRM 里已有的线索：${input.客户.已知}\n` : ""}${input.需求 ? `用户的原话：${input.需求}\n` : ""}` +
        `\n已有材料：\n${材料文本(材料)}`,
    },
  ];
  const 来源规矩 = "每条结论都要带来源网址，只能填材料里出现过的网址；材料里没有的写「查不到」、不写来源，不许编。";

  /**
   * 本步的查找循环：模型挑工具 → 我们执行 → 结果交回去。**它觉得材料够了，就在同一次调用里直接交这一步的结论 JSON**
   * （10-16 降本：原来「够了」之后还要单独问一次结论，19 次分析调用里有 6 次是这么来的）。
   * 返回结论；没交出合格的 JSON（次数用完、回的不是 JSON、对面不吃 tools）返回 null，调用方再单独问一次。
   */
  const 查 = async (stage: 阶段号, 补充: string, 要什么: string): Promise<Record<string, unknown> | null> => {
    const 上限 = 每步工具上限[stage];
    if (!上限 || 钱到了) return null;
    const messages: ToolMessage[] = [
      ...前缀(),
      {
        role: "user",
        content:
          `这一步：${本步目标[stage]}\n${补充}\n` +
          `这一步最多再调 ${上限} 次工具（整次还剩搜索 ${搜索上限 - 搜索数} 次、读页 ${背调上限.读页 - 读页数} 页）。\n` +
          `材料够了就不要再调工具，直接只输出这一步的结论 JSON：${要什么}\n${来源规矩}`,
      },
    ];
    for (let i = 0; i < 上限; i++) {
      if (signal?.aborted) throw new DOMException("已停止", "AbortError");
      if (钱到了 || (搜索数 >= 搜索上限 && 读页数 >= 背调上限.读页)) return null;
      let 调用: { name: string; args: Record<string, unknown>; thought: string; 回执: ToolMessage[]; callId?: string } | null = null;
      if (用原生) {
        try {
          const r = await 模型.tools(messages, 工具表, opts(60_000));
          const c = r.toolCalls[0];
          if (!c) return 认JSON(r.text);
          let args: Record<string, unknown> = {};
          try {
            args = 解参数(c.function.arguments);
          } catch {
            /* 参数坏了：当它没给，下面按缺参数处理 */
          }
          调用 = { name: c.function.name, args, thought: r.text, 回执: [{ role: "assistant", content: r.text || null, tool_calls: [c] }], callId: c.id };
        } catch (e) {
          const 状态码 = (e as { status?: number }).status;
          const 名 = e instanceof Error ? e.name : "";
          if (名 === "TimeoutError" || 名 === "AbortError" || (状态码 !== undefined && ([401, 402, 403, 429].includes(状态码) || 状态码 >= 500))) throw e;
          用原生 = false;
        }
      }
      if (!调用) {
        const raw = (await 模型.json(
          [...messages, { role: "user", content: '只输出 JSON：要搜索 {"thought":"一句打算","tool":"search_web","query":"…"}；要读网页 {"thought":"…","tool":"read_page","url":"…"}；够了 {"done":true}' }],
          opts(60_000),
        )) as Record<string, unknown>;
        if (!raw || raw.done || (raw.tool !== "search_web" && raw.tool !== "read_page")) return null;
        调用 = { name: String(raw.tool), args: raw, thought: 短(raw.thought, 120), 回执: [{ role: "assistant", content: JSON.stringify(raw) }] };
      }
      if (调用.thought && i === 0 && !调用.thought.trim().startsWith("{")) 发({ type: "thought", stage, text: 调用.thought.slice(0, 120) });
      let 结果: string;
      if (调用.name === "search_web" && 短(调用.args.query, 200)) 结果 = await 搜(stage, 短(调用.args.query, 200));
      else if (调用.name === "read_page" && 是网址(调用.args.url)) 结果 = await 读(stage, (调用.args.url as string).trim());
      else 结果 = `参数不对：search_web 要 query，read_page 要 http(s) 网址。`;
      messages.push(...调用.回执, 调用.callId ? { role: "tool", tool_call_id: 调用.callId, content: 结果 } : { role: "user", content: `结果：\n${结果}` });
    }
    return null;
  };

  /** 本步的结论：单独问一次 JSON（查 没交出来时，以及最后那一步）。前缀和 查 一样，缓存照样命中 */
  const 结论 = async (stage: 阶段号, 要什么: string, 模型名?: string): Promise<Record<string, unknown>> => {
    const raw = await 模型.json(
      [
        ...前缀(),
        { role: "user", content: `这一步：${本步目标[stage]}\n只输出这一步的结论 JSON，不要任何 JSON 之外的文字或 Markdown 代码块标记：${要什么}\n${来源规矩}` },
      ],
      opts(90_000, 模型名),
    );
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  };
  const 材料里的 = (u: unknown) => (是网址(u) && 材料.some((m) => m.url === u.trim()) ? u.trim() : undefined);

  let 风险们: 风险[] = [];

  const 要 = {
    identify: '{"认准":true|false,"官网":"网址或空","国家城市":"…或空","说明":"一句话：凭什么认定是这一家，或者为什么拿不准","来源":"网址"}',
    basics: '{"字段":{"country":{"value":"…","source":"网址"},"founded":{…},"size":{…},"business":{…},"buyerType":{…},"contact":{…}},"小结":"一句话"}。查不到的字段不要写。value 用中文短语（≤30 字）',
    fit: '{"小结":"一句话：从材料看它和我们的业务对不对口（品类、买家类型、市场、规模），先不打分"}',
    signals: '{"信号":[{"text":"一句话（中文）","source":"网址"}],"小结":"一句话"}。最多 4 条，优先近一年的；没有就空数组',
    risks: '{"风险":[{"级别":"low|mid|high","说明":"一句话（中文）","来源":"网址"}],"小结":"一句话"}。没查到风险就空数组，小结写「没查到明显风险」',
  } as const;

  const 步骤: Record<阶段号, () => Promise<string | undefined>> = {
    async identify() {
      const r = (await 查("identify", "先搜公司全名，找官网；再找一个独立来源核对。", 要.identify)) ?? (await 结论("identify", 要.identify));
      // 官网那一格只显示域名：模型常给 About 页的网址，整串摆上去像一条来源而不是官网
      if (是网址(r.官网)) 发({ type: "field", key: "site", value: new URL((r.官网 as string).trim()).host.replace(/^www\./, ""), source: 材料里的(r.官网) ?? 材料里的(r.来源) });
      if (短(r.国家城市, 40)) 发({ type: "field", key: "country", value: 短(r.国家城市, 40), source: 材料里的(r.来源) });
      return 短(r.说明, 80) || (r.认准 ? "认准了" : "没能确认是哪一家");
    },
    async basics() {
      const r = (await 查("basics", "优先读官网的 About / 公司介绍页。", 要.basics)) ?? (await 结论("basics", 要.basics));
      const f = (r.字段 && typeof r.字段 === "object" ? r.字段 : {}) as Record<string, { value?: unknown; source?: unknown }>;
      for (const { key } of 字段表) {
        if (key === "site") continue;
        const v = 短(f[key]?.value, 40);
        if (v && !/^查不到|未知|不详$/.test(v)) 发({ type: "field", key: key as 字段键, value: v, source: 材料里的(f[key]?.source) });
      }
      return 短(r.小结, 80) || undefined;
    },
    async fit() {
      const r = (await 查("fit", "材料不够判断就再查一次，够了就直接下结论。", 要.fit)) ?? (await 结论("fit", 要.fit));
      return 短(r.小结, 80) || undefined;
    },
    async signals() {
      const r = (await 查("signals", "搜招聘、新闻、展会，各一次就够。", 要.signals)) ?? (await 结论("signals", 要.signals));
      const 信号 = Array.isArray(r.信号) ? (r.信号 as { text?: unknown; source?: unknown }[]) : [];
      for (const s of 信号.slice(0, 4)) if (短(s?.text, 60)) 发({ type: "tag", tone: "signal", text: 短(s.text, 60), source: 材料里的(s.source) });
      return 短(r.小结, 80) || (信号.length ? undefined : "近期没查到明显动作");
    },
    async risks() {
      const r = (await 查("risks", "搜付款纠纷、投诉、诉讼、破产，用英文和当地语言各试一次。", 要.risks)) ?? (await 结论("risks", 要.risks));
      风险们 = (Array.isArray(r.风险) ? (r.风险 as Record<string, unknown>[]) : [])
        .filter((x) => x && (x.级别 === "low" || x.级别 === "mid" || x.级别 === "high") && 短(x.说明, 80))
        .slice(0, 4)
        .map((x) => ({ 级别: x.级别 as 风险["级别"], 说明: 短(x.说明, 80), 来源: 材料里的(x.来源) }));
      for (const x of 风险们) 发({ type: "tag", tone: "risk", level: x.级别, text: x.说明, source: x.来源 });
      return 短(r.小结, 80) || (风险们.length ? undefined : "没查到明显风险");
    },
    /**
     * 最后一步：**打分 + 写切入建议，固定用报告模型（gpt-5.5）**——用户定「保证最后回复的质量」。
     * 前面五步（可以是便宜的模型）只负责查和摘要；评档、像哪位老客户、怎么切入都在这一步看着全部材料一次定。
     */
    async approach() {
      const r = await 结论(
        "approach",
        "对下面 5 项各评一档（high / mid / low / unknown），每项一句证据和来源网址：\n" +
          "category 品类匹配：它卖的 / 用的产品和我们的重合多少\nbuyerType 买家类型：是不是我们要找的那类买家\nmarket 市场与地区：在不在我们的目标国家、认证够不够\nscale 规模与采购力\nsignals 近期信号：在招人、扩品类、参展、开新店（近一年）\n" +
          `再和我们的老客户比像不像（国家、品类、买家类型、规模），最多挑 3 位，按编号回：\n${老客户表文本(input.老客户)}\n` +
          "最后给 3 条以内切入建议，每条一句话，具体到找谁、聊什么、推什么。\n" +
          '{"评档":[{"维度":"category","档":"high","证据":"…","来源":"网址"},…],"像的老客户":[{"编号":1,"档":"high","像在哪":"一句话"}],"建议":["…"],"小结":"一句话"}',
        通道.模型,
      );
      const 网上评档 = 清洗评档(r.评档).filter((x) => x.维度 !== "similar").map((x) => ({ ...x, 来源: 材料里的(x.来源) }));
      const 像 = 认像的老客户(r.像的老客户, input.老客户);
      发({ type: "similar", items: 像, 比了: input.老客户.length });
      const 老客户档: 评档 = { 维度: "similar", 档: 老客户维度档(像, input.老客户.length), 证据: 像[0] ? `像 ${像[0].name}：${像[0].像在哪}` : undefined };
      发({ type: "score", 评分: 算相关性([...网上评档, 老客户档], 风险们) });
      const points = (Array.isArray(r.建议) ? r.建议 : []).map((x) => 短(x, 100)).filter(Boolean).slice(0, 3);
      if (points.length) 发({ type: "approach", points });
      return 短(r.小结, 80) || undefined;
    },
  };

  let 停在: 阶段号 | null = null;
  let 出错: string | null = null;
  for (const { id } of 阶段表) {
    if (signal?.aborted) {
      停在 = id;
      break;
    }
    发({ type: "stage", stage: id, status: "running" });
    try {
      const summary = await 步骤[id]();
      发({ type: "stage", stage: id, status: "done", summary });
    } catch (e) {
      停在 = id;
      出错 = signal?.aborted ? "已停止" : e instanceof Error ? e.message : "这一步出错了";
      发({ type: "stage", stage: id, status: "error", summary: 出错.slice(0, 60) });
      break;
    }
  }

  // 一条材料都没拿到：这份「报告」什么都不是，全退
  if (!材料.length) {
    await 通道.收尾(runId, false, { searches: 搜索数, pages: 读页数 });
    return { ok: false, error: 出错 ?? "一条资料都没查到，这次不扣次数", 退了: true };
  }
  if (停在) 不完整 = true;
  await 通道.收尾(runId, true, { searches: 搜索数, pages: 读页数 });
  发({ type: "done", charge: 通道.扣次, 不完整 });
  return { ok: true, 状态, runId, 材料: 材料.map((m) => ({ url: m.url, text: m.text })) };
}
