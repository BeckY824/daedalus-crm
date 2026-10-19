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
 * 10-18 用户定：「我们不花钱，则不扣；我们花钱就扣」。一分钱没花（开头就停了、只做了程序直查）的退；
 * 搜过、调过模型的照扣，一条材料都没搜到也出报告、写明没查到。
 * 因为我们这边的原因（超时、上游报错）没跑完 6 步的退——**退不退服务器自己判断**（credits.ts 的 收尾背调），
 * 这里只告诉它「是不是用户自己停的」。
 */
import type { chatTools, ToolMessage, 工具声明, 工具调用 } from "../llm";
import type { BusinessConfig } from "../business-config";
import type { 背调通道 } from "./channel";
import { 背调上限, 社媒搜索次数, 阶段表, 字段表, type 研究事件, type 阶段号, type 字段键, type 来源, type 搜索结果, type 必查项, type 在卖型号 } from "./types";
import { 认必查, 认型号, 认联系人, 认型号对比, 认开发信, 必查转风险, 母公司查询, 认画像, 认发现, 认匹配, 认证提醒 } from "./extras";
import { 算相关性, 清洗评档, type 评档, type 风险 } from "./score";
import { 认像的老客户, 老客户表文本, 老客户维度档, type 老客户 } from "./similar";
import { 初始状态, 归约, type 背调状态 } from "./state";
import { 背调超时, 背调输出上限, 背调打分推理强度, 截, 截断了, 全句 } from "./retry";
import { 核验项表, type 核验回应, type 真实性 } from "./verify/types";
import { 进口摘要 } from "./verify/imports";
import type { 线索 } from "./verify/clues";
import { 认国家 } from "./verify/country";
import { 主机, 主域名 } from "./verify/domain";
import { 查询名, 比名字, 名词 } from "./verify/names";
import { 合成真实性, 灯符, 邮件头项 } from "./verify/rules";
import type { 邮件信号 } from "./verify/mail";
import { 是社媒网址, 社媒查询, 认足迹 } from "./verify/social";
import { 人号项, type 候选公司, type 出现, type 号码信息 } from "./person";
import { 换引用, 删引用, 去掉没查到进口 } from "./cite";

/** reasoningEffort：只有最后打分那一步传（背调打分推理强度），网关 / 实验脚本转成 reasoning_effort */
type ChatOpts = NonNullable<Parameters<typeof chatTools>[2]> & { reasoningEffort?: "none" | "low" | "medium" };

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
  /** 对方自报的邮箱、电话、官网、税号、国家（客户档案 + 那句话里贴的），拿去做真实性核对（verify/clues.ts） */
  线索?: 线索;
  /**
   * 「粘贴询盘邮件」（第二期）：桌面端浏览器里从邮件原文认出来的几样（verify/mail.ts），原文不进来。
   * 邮箱 / 电话已经并进上面的 线索；这里只用它拼「邮件头」那一项
   */
  邮件?: 邮件信号;
  /** 发件 IP → 国家（桌面端本机的离线库，verify/ip-country.ts）；不给就当 IP 库查不了 */
  查IP?: (ip: string) => Promise<string | null>;
  b: Pick<BusinessConfig, "brief" | "fields">;
  通道: 背调通道;
  模型: 模型调用;
  老客户: 老客户[];
  发: (e: 研究事件) => void;
  signal?: AbortSignal;
  /** 测试用：固定编号。只有人名 + 电话、找公司后接着背调的，是找公司那一次的编号（服务器认得、不另扣） */
  runId?: string;
  /**
   * 只有人名 + 电话、找公司时点选了这家（person.ts）：同一个 runId 接着背调，算同一次、不另扣。
   * 认出它的那几条搜索结果先放进材料；真实性多一项「人和号码」
   */
  接着?: { 人: { 名?: string; 号: 号码信息 }; 候选: 候选公司; 出现: 出现; 证据: 搜索结果[] };
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
// risks 另有程序先发的一次母公司搜索（母公司查询），模型自己最多再调 3 次，合起来还是 4 次
const 每步工具上限: Record<阶段号, number> = { identify: 3, basics: 3, fit: 2, signals: 3, risks: 3, approach: 0 };

/** 每一步要查清什么。写给模型看的，也是界面上那一步的意思 */
const 本步目标: Record<阶段号, string> = {
  identify: "认准是哪一家：找到它的官网和至少一个独立来源（工商登记、名录、行业媒体），排除同名公司。名字里有 GmbH / Ltd / S.A. 之类的，按对应国家找。",
  basics: "查基本面：国家城市、成立年份、规模（员工 / 门店 / 营收，有什么写什么）、主营产品、买家类型（进口商 / 分销商 / 品牌商 / 工程商 / 零售）、公开的联系方式；公司公开页面上的业务联系人（采购 / 品类 / 产品负责人、总经理的岗位、姓名、公开电话）；顺带留意有没有公开的进口 / 提单 / 海关记录（有就记下出处，没有不用硬找）。",
  fit: "对照我们的业务，判断它和我们相不相关：品类重合、买家类型对不对、市场和认证、规模和采购力；再和我们的老客户比像不像。找出它在卖的 2–3 个具体型号 / 产品系列（产品页上原样写的型号名），后面拿来和我们的产品比。材料不够可以再查一次。",
  signals: "找近期信号：在招人（尤其采购 / 品类岗位）、扩品类、开新店、参展（展会的参展商名单）、融资、新闻。优先近一年的。",
  risks:
    "排查风险。先必查四项，每项都要有结论：母公司 / 大股东是谁（集团自己有没有工厂、是不是在重组 / 出售）；近两年财务（营收、盈亏、再融资、裁员）；是不是同行（自己生产同类产品 = 竞争对手）；在不在我们的目标市场做生意（有没有撤出 / 收缩）。" +
    "再查付款纠纷、投诉、诉讼、破产 / 清算、负面新闻。查不到就说查不到，不要编。",
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

/** 别名：读页时要读的网址（跳转以后 url 是落地页，模型常引用跳转前那个） */
/** 长 = 官网的公司介绍 / 历史 / 生产测试设施页：拼进提示词时给得多一些（关键发现、母公司常在后半页） */
type 材料条 = { n: number; kind: "search" | "read"; title: string; url: string; text: string; 别名?: string; 长?: true };

/** 比网址用：去掉协议、www、#、utm_ 参数、结尾的 / 和省略号，小写 */
export function 规整网址(u: string): string {
  return u
    .trim()
    .replace(/(…|\.\.\.)+$/, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/#.*$/, "")
    .replace(/([?&])utm_[^&]*&?/gi, "$1")
    .replace(/[?&]+$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * 模型给的来源 → 材料里那一条的网址；认不出就 undefined（不许编：材料里没有的网址不收）。
 * 10-17 AC 回放：同一批材料，mini 摘要的结论带来源比 A 少 16 点——它常写材料编号（「3」「[3]」）、
 * 少个结尾的 /、引用跳转前的网址、把长网址截成「…」，原来要一字不差才收，全被丢了。现在这几种都认：
 * 编号；规整以后相同；带省略号的按前缀认（只认唯一一条）；一格里写了几个的取第一个认得出的
 */
export function 认来源(材料: 材料条[], u: unknown): string | undefined {
  if (typeof u === "number") return 材料.find((m) => m.n === u)?.url;
  if (typeof u !== "string" || !u.trim()) return undefined;
  const s = u.trim();
  const 号 = /^(?:\[|【)?\s*(\d{1,3})\s*(?:\]|】)?$/.exec(s);
  if (号) return 材料.find((m) => m.n === Number(号[1]))?.url;
  const 精确 = 材料.find((m) => m.url === s || m.别名 === s);
  if (精确) return 精确.url;
  const 几个 = s.split(/[\s；;，,、]+/).filter(Boolean);
  if (几个.length > 1) {
    for (const x of 几个) {
      const r = 认来源(材料, x);
      if (r) return r;
    }
    return undefined;
  }
  if (!/^\S+\.\S+/.test(s.replace(/^https?:\/\//i, ""))) return undefined;
  const k = 规整网址(s);
  const 同 = 材料.find((m) => 规整网址(m.url) === k || (m.别名 !== undefined && 规整网址(m.别名) === k));
  if (同) return 同.url;
  if (/(…|\.\.\.)$/.test(s) && k.length >= 12) {
    const 前 = [...new Set(材料.filter((m) => 规整网址(m.url).startsWith(k)).map((m) => m.url))];
    if (前.length === 1) return 前[0];
  }
  return undefined;
}

/**
 * 拼进提示词的材料：读过的页给 1500 字（官网的公司介绍 / 历史 / 设施页给 3000 字），搜索摘要给 300 字，整份封顶 30000 字（越新的越靠后、越不会被截）。
 * 封顶放宽到 30000（原来 14000）：截的是最前面那几条，一截前缀就变了、提示缓存就不命中；正常一次背调到不了这个数
 */
function 材料文本(材料: 材料条[]): string {
  if (!材料.length) return "（还没有材料）";
  const 段 = 材料.map((m) => `[${m.n}] ${m.title}\n${m.url}\n${m.text.slice(0, m.kind === "read" ? (m.长 ? 3000 : 1500) : 300)}`);
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
    "规矩：只依据搜索和网页材料说话，材料里没有的写「查不到」，不许编；每条结论都注明来源（材料前面的编号，或者材料里原样的网址）；" +
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

/**
 * 给人看的结论、标签、建议：整句收，不带省略号（10-18 对比免费产品：17 处「…」截断，见 retry.ts 全句）。
 * 上限只防模型失控写一大段，正常的一句话碰不到
 */
const 短 = 全句;

/** 风险里模型自己说拿不准是不是这一家的（同名的别家公司） */
const 拿不准同一家 = /(无法|不能|未能|难以|没法|不确定)(确认|确定|判断|核实|区分)[^。；;]{0,80}(同一|是这一家|是这家)|同名(的)?(不同|另一|别的)|(不是|并非)同一(家|主体|公司|实体)/;
/** 官网上的公司历史页 */
const 历史页路径 = /histor|our-?story|heritage|geschichte|histoire|historia|storia|geschiedenis|chronik|timeline|milestones/i;
/** 官网上的生产 / 测试设施页（自有工厂、实验室：判同行、写关键发现用，10-18 A+D 结构） */
const 设施页路径 = /facilit|factor(y|ies)|manufactur|production|testing|laborator|quality|fabrik|werk(e|s)?\b|usine|fabbrica|fabrica/i;
/** 官网上的公司介绍页：读到的给长一点（材料文本） */
const 公司页路径 = /about|company|who-?we-?are|ueber-uns|uber-uns|qui-sommes|chi-siamo|over-ons|quienes-somos|sobre/i;
/** 判了「是同行」时切入建议的第一条（10-18 免费对比复核第 6 点） */
const 先确认外采 =
  "先确认它外不外采：它自己设计、生产同类产品，多半是竞争对手；先问清楚有没有对外采购或外包的品类（产能不够的型号、配件、私标），有再谈 OEM，没有就别在它身上多花力气";
const 是网址 = (s: unknown): s is string => typeof s === "string" && /^https?:\/\/\S+$/i.test(s.trim());

export async function 跑背调(input: 背调输入): Promise<背调结果> {
  const runId = input.runId ?? randomUUID();
  const { 通道, 模型, signal } = input;
  let 状态 = 初始状态({ name: input.公司, customerId: input.客户?.id });
  const 发原样 = (e: 研究事件) => {
    状态 = 归约(状态, e);
    input.发(e);
  };
  /**
   * 正文里的材料编号（「来源:17,28」「[17]」）换成【来源】列表的编号，对不上的删；开发信里全删（cite.ts，10-18 免费对比复核第 2 点）。
   * 列表要算上这条事件自己带的来源，所以先叠一次拿到新列表再换字。每条事件只换一次：再发一遍的（去掉没查到进口）走 发原样
   */
  const 换字 = (e: 研究事件): 研究事件 => {
    const 列表 = 归约(状态, e).sources.map((x) => x.url);
    const 换 = (t: string) => 换引用(t, (n) => 材料.find((m) => m.n === n)?.url, 列表);
    switch (e.type) {
      case "stage":
        return e.status === "done" && e.summary ? { ...e, summary: 换(e.summary) } : e;
      case "tag":
        return { ...e, text: 换(e.text), ...(e.应对 ? { 应对: 换(e.应对) } : {}) };
      case "verify-note":
        return { ...e, text: 换(e.text) };
      case "profile":
        return { ...e, 类型: 换(e.类型), 先验证: e.先验证.map(换).filter(Boolean) };
      case "findings":
        return { ...e, items: e.items.map((x) => ({ ...x, 事实: 换(x.事实), ...(x.机会 ? { 机会: 换(x.机会) } : {}), ...(x.障碍 ? { 障碍: 换(x.障碍) } : {}) })) };
      case "match":
        return { ...e, items: e.items.map((x) => ({ ...x, ...(x.依据 ? { 依据: 换(x.依据) } : {}), ...(x.准备 ? { 准备: 换(x.准备) } : {}) })) };
      case "approach":
        return { ...e, points: e.points.map(换).filter(Boolean) };
      case "compare":
        return { ...e, items: e.items.map((x) => ({ ...x, 怎么比: 换(x.怎么比) })) };
      case "checks":
        return { ...e, 项: e.项.map((x) => ({ ...x, 结论: 换(x.结论), ...(x.应对 ? { 应对: 换(x.应对) } : {}) })) };
      case "models":
        return { ...e, items: e.items.map((x) => (x.是什么 ? { ...x, 是什么: 换(x.是什么) } : x)) };
      case "score":
        return { ...e, 评分: { ...e.评分, 明细: e.评分.明细.map((d) => (d.证据 ? { ...d, 证据: 换(d.证据) } : d)), ...(e.评分.结论 ? { 结论: { ...e.评分.结论, 字: 换(e.评分.结论.字) } } : {}) } };
      case "email":
        return { ...e, 主题: 删引用(e.主题), 正文: 删引用(e.正文) };
      default:
        return e;
    }
  };
  const 发 = (e: 研究事件) => 发原样(换字(e));

  const 开 = await 通道.开始(runId, signal);
  if (!开.ok) return { ok: false, error: 开.error, 退了: false };
  // 这次最多搜几次听服务器的（RESEARCH_SEARCH_LIMIT，降本开关）；老服务器不回就按默认
  const 搜索上限 = 开.搜索上限 && 开.搜索上限 > 0 ? Math.min(开.搜索上限, 背调上限.搜索) : 背调上限.搜索;

  const 材料: 材料条[] = [];
  const 接着 = input.接着;
  if (接着) {
    // 报告开头写清楚：这家是从名字和号码认出来、人点选的
    发({ type: "person", 名: 接着.人.名, 号: 接着.人.号 });
    发({ type: "person-found", 候选: [接着.候选], 出现: 接着.出现, 选了: 接着.候选.公司 });
    for (const r of 接着.证据) if (是网址(r.url) && !材料.some((m) => m.url === r.url)) 材料.push({ n: 材料.length + 1, kind: "search", title: r.title || r.url, url: r.url, text: r.snippet ?? "" });
  }
  const 读过 = new Set<string>();
  let 搜索数 = 0;
  /** 程序自己发的 LinkedIn / Facebook 定向搜索：不占模型的搜索次数（服务器那头多放 社媒搜索次数 次） */
  let 社媒数 = 0;
  let 社媒搜成 = false;
  /** 这次所有的搜索结果：「网上足迹」从里面认 LinkedIn / Facebook 链接（verify/social.ts） */
  const 全部结果: 搜索结果[] = [];
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
  /** 每次调用都带上这是哪一步（X-Research-Stage）：服务器看到最后一步交出去了才算跑完。超时是每一趟的，卡了 gateway-model 会重发一次 */
  const opts = (stage: 阶段号, 模型名?: string, 推理?: ChatOpts["reasoningEffort"]): ChatOpts => ({ model: 模型名 ?? 通道.摘要模型 ?? 通道.模型, signal, requestId: runId, feature: "research", researchStage: stage, temperature: 0, thinking: false, timeoutMs: 背调超时.模型每次, maxTokens: 背调输出上限, ...(stage === "approach" ? { reasoningEffort: 推理 ?? 背调打分推理强度 } : {}) });
  /** 用原生 function calling；对面不吃 tools 时退回 JSON 协议（和首页 agent 同一个判断） */
  let 用原生 = true;

  const 搜 = async (stage: 阶段号, query: string, 社媒 = false): Promise<string> => {
    if (社媒) {
      if (社媒数 >= 社媒搜索次数) return "";
      社媒数 += 1;
    } else {
      // 搜满了是预算（降本开关定的次数），不是材料不全：报告不标（10-16 试跑 C 组 6 步都走完了也被标了）
      if (搜索数 >= 搜索上限) {
        return "这次背调的搜索次数用完了，请用已有材料。";
      }
      搜索数 += 1;
    }
    const id = `t${++工具号}`;
    const label = `搜索「${截(query, 60)}」`;
    const t0 = Date.now();
    发({ type: "tool", stage, id, kind: "search", label, status: "running" });
    try {
      const rs = await 通道.搜索(runId, query, signal);
      全部结果.push(...rs);
      if (社媒) 社媒搜成 = true;
      const 新: 来源[] = [];
      const 号 = new Map<string, number>();
      for (const r of rs) {
        if (!是网址(r.url)) continue;
        材料.push({ n: 材料.length + 1, kind: "search", title: r.title || r.url, url: r.url, text: r.snippet ?? "" });
        号.set(r.url, 材料.length);
        新.push({ title: r.title || r.url, url: r.url });
      }
      发({ type: "tool", stage, id, kind: "search", label, status: "done", result: `${rs.length} 条结果`, ms: Date.now() - t0, sources: 新.slice(0, 6) });
      发({ type: "usage", searches: 搜索数 + 社媒数, pages: 读页数 });
      看钱();
      // 带上和「已有材料」同一套编号：来源可以填编号（认来源），这一步新搜到的不带号，模型照着位置猜就会对错条
      return rs.length ? rs.map((r) => `- ${号.has(r.url) ? `[${号.get(r.url)}] ` : ""}${r.title}\n  ${r.url}\n  ${(r.snippet ?? "").slice(0, 300)}`).join("\n") : "没有搜到结果，换个说法或换个角度再搜。";
    } catch (e) {
      if (signal?.aborted) throw e;
      const msg = e instanceof Error ? e.message : "搜索出错";
      发({ type: "tool", stage, id, kind: "search", label, status: "error", result: 全句(msg, 120), ms: Date.now() - t0 });
      看钱(msg);
      return `搜索失败：${msg}`;
    }
  };

  const 读 = async (stage: 阶段号, url: string): Promise<string> => {
    if (读过.has(url)) return "这一页前面已经读过，内容在材料里。";
    // LinkedIn / Facebook 不打开（10-18 用户定：不登录、不抓取），只用搜索结果。不占读页名额
    if (是社媒网址(url)) return "LinkedIn / Facebook 的页面不打开，只用搜索结果里的标题和摘要。";
    if (读页数 >= 背调上限.读页) {
      return "这次背调能读的页数用完了，请用已有材料。";
    }
    读页数 += 1;
    读过.add(url);
    const id = `t${++工具号}`;
    const 名 = 材料.find((m) => m.url === url)?.title ?? url.replace(/^https?:\/\//, "").slice(0, 50);
    const label = `读「${截(名, 50)}」`;
    const t0 = Date.now();
    发({ type: "tool", stage, id, kind: "read", label, status: "running" });
    try {
      const p = await 通道.读页(runId, url, signal);
      材料.push({ n: 材料.length + 1, kind: "read", title: p.title || 名, url: p.url || url, text: p.text, ...(p.url && p.url !== url ? { 别名: url } : {}), ...(是官网公司页(p.url || url) ? { 长: true as const } : {}) });
      const 字 = p.text.length >= 1000 ? `${(p.text.length / 1000).toFixed(1)}k 字` : `${p.text.length} 字`;
      发({ type: "tool", stage, id, kind: "read", label, status: "done", result: `1 页 · ${字}`, ms: Date.now() - t0, sources: [{ title: p.title || 名, url: p.url || url }] });
      发({ type: "usage", searches: 搜索数 + 社媒数, pages: 读页数 });
      看钱();
      return `[${材料.length}] ${p.title}\n${p.text.slice(0, 4000)}`;
    } catch (e) {
      if (signal?.aborted) throw e;
      const msg = e instanceof Error ? e.message : "读不了";
      发({ type: "tool", stage, id, kind: "read", label, status: "error", result: 全句(msg, 120), ms: Date.now() - t0 });
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
        (接着 ? `询盘客户只留了${接着.人.名 ? `名字 ${接着.人.名} 和` : ""}电话 ${接着.人.号.号}；从搜索结果认出在这家公司（${接着.候选.依据}），用户点选了它\n` : "") +
        `\n已有材料：\n${材料文本(材料)}`,
    },
  ];
  /*
    10-17 AC 回放：mini 摘要的结论带来源比 A 少 16 点。来源可以填材料编号（不用抄长网址），
    并且明说：不带来源的结论不进报告（下面 basics / signals / risks / 国家 都照这条丢）
  */
  const 来源规矩 =
    "每条结论都要带来源：填它出自的那条材料前面的编号（比如 3），或者把材料里的网址原样抄过来（别改、别截）；" +
    "不带来源的结论不会进报告。材料里没有的写「查不到」、不写来源，不许编。";

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
          const r = await 模型.tools(messages, 工具表, opts(stage));
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
          opts(stage),
        )) as Record<string, unknown>;
        if (!raw || raw.done || (raw.tool !== "search_web" && raw.tool !== "read_page")) return null;
        调用 = { name: String(raw.tool), args: raw, thought: 短(raw.thought, 120), 回执: [{ role: "assistant", content: JSON.stringify(raw) }] };
      }
      if (调用.thought && i === 0 && !调用.thought.trim().startsWith("{")) 发({ type: "thought", stage, text: 全句(调用.thought, 200) });
      let 结果: string;
      if (调用.name === "search_web" && 短(调用.args.query, 200)) 结果 = await 搜(stage, 短(调用.args.query, 200));
      else if (调用.name === "read_page" && 是网址(调用.args.url)) 结果 = await 读(stage, (调用.args.url as string).trim());
      else 结果 = `参数不对：search_web 要 query，read_page 要 http(s) 网址。`;
      messages.push(...调用.回执, 调用.callId ? { role: "tool", tool_call_id: 调用.callId, content: 结果 } : { role: "user", content: `结果：\n${结果}` });
    }
    return null;
  };

  /**
   * 本步的结论：单独问一次 JSON（查 没交出来时，以及最后那一步）。前缀和 查 一样，缓存照样命中。
   * 回的不是合法 JSON、被截断了就再要一次：那是模型的毛病，不该让整次背调停在这一步
   */
  const 结论 = async (stage: 阶段号, 要什么: string, 模型名?: string, 推理?: ChatOpts["reasoningEffort"]): Promise<Record<string, unknown>> => {
    const 问 = () =>
      模型.json(
        [
          ...前缀(),
          { role: "user", content: `这一步：${本步目标[stage]}\n只输出这一步的结论 JSON，不要任何 JSON 之外的文字或 Markdown 代码块标记：${要什么}\n${来源规矩}` },
        ],
        opts(stage, 模型名, 推理),
      );
    let raw: unknown;
    try {
      raw = await 问();
    } catch (e) {
      if (signal?.aborted || !(e instanceof SyntaxError || e instanceof 截断了 || (e instanceof Error && /不是合法 JSON/.test(e.message)))) throw e;
      raw = await 问();
    }
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  };
  const 材料里的 = (u: unknown) => 认来源(材料, u);

  let 风险们: (风险 & { 应对?: string })[] = [];
  let 必查们: 必查项[] = [];
  let 型号们: 在卖型号[] = [];
  // 模型写的来源 → 那条材料的原文（同一个网址搜到过又读过的拼在一起）：型号名、联系人要在原文里核（extras.ts）
  const 找原文 = (u: unknown) => {
    const url = 认来源(材料, u);
    return url ? { url, text: 材料.filter((m) => m.url === url).map((m) => `${m.title}\n${m.text}`).join("\n") } : undefined;
  };
  /** 网址在官网上、路径像某一类页（历史 / 设施 / 公司介绍） */
  const 官网上的 = (u: string, 路径: RegExp): boolean => {
    const 站 = 状态.fields.site?.value;
    const 主 = 站 ? 主域名(站) : undefined;
    if (!主 || 主域名(u) !== 主) return false;
    try {
      return 路径.test(new URL(u).pathname);
    } catch {
      return false;
    }
  };
  function 是官网公司页(u: string): boolean {
    return 官网上的(u, 历史页路径) || 官网上的(u, 设施页路径) || 官网上的(u, 公司页路径);
  }
  /**
   * 材料里官网上的公司历史页（history / our story / Geschichte…）和生产 / 测试设施页，各取没读过的第一条。
   * 被收购、母公司、自有工厂、在中国的团队常只写在这两页（10-18 免费对比复核：Ansell 的 history 页写着 2014 年被 Endo 收购）
   */
  const 官网公司页 = (): string[] => {
    const 没读 = [...new Set(材料.map((m) => m.url))].filter((u) => !读过.has(u));
    return [没读.find((u) => 官网上的(u, 历史页路径)), 没读.find((u) => 官网上的(u, 设施页路径) && !官网上的(u, 历史页路径))].filter((u): u is string => Boolean(u));
  };

  /*
    真实性（10-18）：第一步认出官网以后，就把官网、对方自报的邮箱电话税号交给服务器去程序直查（不经模型、不另扣次数），
    和后面几步并行；切入建议那一步之前等它回来，连同「网上足迹」拼成那一块。灯全是代码按规则定的（verify/rules.ts）
  */
  let 核验中: Promise<核验回应 | null> | null = null;
  let 真: 真实性 | null = null;
  let 核验回: 核验回应 | null = null;
  let 核验国家: { 国家?: string; 自报国家?: string } = {};
  // 发件 IP 一开始就去查（本机离线库，第一次要下载几秒），到拼真实性的时候多半已经好了
  const 发件IP = input.邮件?.发件IP;
  const IP国家: Promise<string | null | "查不了" | undefined> = !发件IP
    ? Promise.resolve(undefined)
    : !input.查IP
      ? Promise.resolve("查不了")
      : input.查IP(发件IP).catch(() => "查不了" as const);
  // 社媒搜什么名字：输入的是「SLV」这种很短的缩写，认出了登记全称、又是同一家，就用全称（10-18 bench：搜「SLV」回来的是
  // 健身房 SLV Sports，搜「SLV GmbH」全是它自己的主页）。名字不短就还用输入的：「Alfanar Company」「Delta Light NV」
  // 这样带后缀搜反而一条主页都搜不到
  let 社媒名 = 查询名(input.公司);
  const 开始核验 = (官网?: string, 国家城市?: string, 全称?: string) => {
    if (核验中) return;
    const 线 = input.线索;
    const 名 = 查询名(input.公司);
    if (全称 && 比名字(全称, 名) && 名词(名).join("").length <= 4) 社媒名 = 查询名(全称);
    核验国家 = { 国家: 认国家(国家城市) ?? 认国家(线?.国家), 自报国家: 认国家(线?.国家) };
    核验中 = 通道
      .核验(
        {
          runId,
          公司: 全称 || 名,
          别名: 全称 && 全称 !== 名 ? [名] : [],
          域名: (官网 && 主机(官网)) || 线?.官网,
          邮箱: 线?.邮箱 ?? [],
          电话: 线?.电话 ?? [],
          税号: 线?.税号,
          国家: 认国家(国家城市) ?? 认国家(线?.国家),
          自报国家: 认国家(线?.国家),
        },
        signal,
      )
      .catch(() => null);
  };
  const 出真实性 = async (): Promise<真实性> => {
    if (真) return 真;
    开始核验();
    let 停表: ReturnType<typeof setTimeout> | undefined;
    const 回 = await Promise.race([核验中!, new Promise<null>((r) => (停表 = setTimeout(() => r(null), 45_000)))]);
    clearTimeout(停表);
    核验回 = 回;
    const 足迹 = 认足迹(全部结果.filter((r) => 是社媒网址(r.url)), 社媒名, 社媒搜成);
    let 邮件项;
    if (input.邮件) {
      let 停IP: ReturnType<typeof setTimeout> | undefined;
      const 国 = await Promise.race([IP国家, new Promise<"查不了">((r) => (停IP = setTimeout(() => r("查不了"), 15_000)))]);
      clearTimeout(停IP);
      邮件项 = 邮件头项(input.邮件, 国, 核验国家);
    }
    const 人项 = 接着 ? 人号项(接着.人, input.公司, 状态.fields.site?.value ? 主域名(状态.fields.site.value) : undefined, 材料) : undefined;
    真 = 合成真实性(回?.项 ?? null, 足迹, { 名单更新于: 回?.名单更新于, 邮件项, 人项 });
    发({ type: "verify", 真实性: 真 });
    // 制裁疑似命中两边都出：真实性标红，风险里也列一条「高」（方案 3.1）
    const 制裁 = 真.项.find((x) => x.key === "sanctions" && x.硬红);
    if (制裁) {
      const r: 风险 = { 级别: "high", 说明: 短(制裁.硬红, 240), 来源: 制裁.链接?.[0]?.url };
      风险们 = [...风险们, r];
      发({ type: "tag", tone: "risk", level: "high", text: r.说明, source: r.来源 });
    }
    return 真;
  };
  const 真实性文本 = (x: 真实性) =>
    x.项.map((y) => `- ${核验项表.find((k) => k.key === y.key)?.label ?? y.key} ${灯符[y.灯]}：${y.事实}`).join("\n") + `\n总灯 ${灯符[x.总灯]}：${x.总字}`;

  const 要 = {
    identify: '{"认准":true|false,"官网":"网址或空","全称":"材料里写的登记全称（带 GmbH / Ltd 之类）或空","国家城市":"…或空","说明":"一句话：凭什么认定是这一家，或者为什么拿不准","来源":"材料编号或网址"}',
    basics:
      '{"字段":{"country":{"value":"…","source":"材料编号或网址"},"founded":{…},"size":{…},"business":{…},"buyerType":{…},"contact":{…}},"联系人":[{"岗位":"中文","姓名":"原文","电话":"原文","邮箱":"原文","来源":"材料编号或网址"}],"小结":"一句话"}。查不到的字段不要写。value 用中文短语（≤30 字）。' +
      "联系人最多 3 位，只写公司官网 / 名录 / 新闻稿 / LinkedIn 上公开的业务联系人，优先出口 / 国际业务（export / international）和采购的公开邮箱，姓名电话邮箱照材料原文抄，没有的格子不写；不写私人信息（住址、家人、私人社交）",
    fit: '{"型号":[{"型号":"产品页上原样写的型号名","是什么":"一句话（中文）","来源":"材料编号或网址"}],"小结":"一句话：从材料看它和我们的业务对不对口（品类、买家类型、市场、规模），先不打分"}。型号最多 3 个，必须是材料原文里写着的；没有就空数组',
    signals: '{"信号":[{"text":"一句话（中文）","source":"材料编号或网址"}],"小结":"一句话"}。最多 4 条，优先近一年的；没有就空数组',
    risks:
      '{"必查":{"母公司":{"结论":"一句话（中文）","级别":"none|low|mid|high","来源":"材料编号或网址","应对":"…"},"财务":{…},"同行":{"结论":"…","是":"是|部分|否|查不到","级别":"…","来源":"…","应对":"…"},"市场":{…}},"风险":[{"级别":"low|mid|high","说明":"一句话（中文）","来源":"材料编号或网址","应对":"…"}],"小结":"一句话，只写事实"}。' +
      "必查四项都要写；查不到的写 {\"结论\":\"查不到\"}、不写来源。级别 none = 查了、没问题。" +
      "级别不是 none 的、和「风险」里每一条，写一句「应对」（30 字以内，我们这边怎么办：先问清什么、准备什么材料）。" +
      "例：母公司是有自己工厂的照明集团 → 同行「部分」、级别 mid；集团宣布退出中东 → 市场 mid（目标市场在中东时 high）；被私募股东再融资 / 债务重组 → 财务 mid。" +
      "「风险」只列必查四项以外的（付款、诉讼、投诉、负面新闻），没有就空数组",
  } as const;

  const 步骤: Record<阶段号, () => Promise<string | undefined>> = {
    async identify() {
      const r = (await 查("identify", "先搜公司全名，找官网；再找一个独立来源核对。", 要.identify)) ?? (await 结论("identify", 要.identify));
      // 官网那一格只显示域名：模型常给 About 页的网址，整串摆上去像一条来源而不是官网
      if (是网址(r.官网)) 发({ type: "field", key: "site", value: new URL((r.官网 as string).trim()).host.replace(/^www\./, ""), source: 材料里的(r.官网) ?? 材料里的(r.来源) });
      // 不带来源的结论不进报告（官网那格除外：认准是哪一家靠它，对不对另有 认对 核）
      const 国家来源 = 材料里的(r.来源);
      if (短(r.国家城市, 80) && 国家来源) 发({ type: "field", key: "country", value: 短(r.国家城市, 80), source: 国家来源 });
      // 程序直查在后台跑，后面几步照常往下走。官网和上面那一格同一个（没认出就用对方自报的）
      开始核验(是网址(r.官网) ? (r.官网 as string) : undefined, 国家来源 ? 短(r.国家城市, 80) : undefined, 短(r.全称, 120) || undefined);
      return 短(r.说明, 300) || (r.认准 ? "认准了" : "没能确认是哪一家");
    },
    async basics() {
      const r = (await 查("basics", "优先读官网的 About / 公司介绍页。", 要.basics)) ?? (await 结论("basics", 要.basics));
      const f = (r.字段 && typeof r.字段 === "object" ? r.字段 : {}) as Record<string, { value?: unknown; source?: unknown }>;
      for (const { key } of 字段表) {
        if (key === "site") continue;
        const v = 短(f[key]?.value, 80);
        const 源 = 材料里的(f[key]?.source);
        if (v && 源 && !/^查不到|未知|不详$/.test(v)) 发({ type: "field", key: key as 字段键, value: v, source: 源 });
      }
      const 人们 = 认联系人(r.联系人, 找原文);
      if (人们.length) 发({ type: "contacts", items: 人们 });
      return 短(r.小结, 300) || undefined;
    },
    async fit() {
      const r = (await 查("fit", "材料里没有产品页就读一次官网的产品页，够了就直接下结论。", 要.fit)) ?? (await 结论("fit", 要.fit));
      型号们 = 认型号(r.型号, 找原文);
      if (型号们.length) 发({ type: "models", items: 型号们 });
      return 短(r.小结, 300) || undefined;
    },
    async signals() {
      // LinkedIn / Facebook 定向搜索：程序自己发（不让模型挑），只看搜索结果判断有没有主页、有没有在职员工（verify/social.ts）
      if (!钱到了) await Promise.all(社媒查询(社媒名).map((q) => 搜("signals", q, true)));
      const r = (await 查("signals", "搜招聘、新闻、展会，各一次就够（LinkedIn / Facebook 已经搜过了，结果在材料里）。", 要.signals)) ?? (await 结论("signals", 要.signals));
      const 信号 = Array.isArray(r.信号) ? (r.信号 as { text?: unknown; source?: unknown }[]) : [];
      for (const s of 信号.slice(0, 4)) {
        const 源 = 材料里的(s?.source);
        if (短(s?.text, 240) && 源) 发({ type: "tag", tone: "signal", text: 短(s.text, 240), source: 源 });
      }
      return 短(r.小结, 300) || (信号.length ? undefined : "近期没查到明显动作");
    },
    async risks() {
      // 母公司 / 股东：程序先定向搜一次（owned by / parent company / acquired by / subsidiary of），不让模型自己挑词
      if (!钱到了) await 搜("risks", 母公司查询(社媒名));
      // 搜到官网的公司历史页、生产 / 测试设施页就各读一次（两页一起读，不多占时间）：被收购、母公司、自有工厂常只写在那
      // （10-18 免费对比复核：Ansell 的 history 页写着 2014 年被 Endo 收购，报告只读了 about-us）
      if (!钱到了) await Promise.all(官网公司页().map((u) => 读("risks", u)));
      const r =
        (await 查(
          "risks",
          "母公司已经按「owned by / parent company / acquired by / subsidiary of」专门搜过一次，官网的公司历史页（history）、生产 / 测试设施页搜到了也读过了，都在材料里，先看它们（没搜到再换登记全称或当地语言试一次）；再搜近两年财务（年报、再融资、重组新闻），再搜付款纠纷、投诉、诉讼、破产。" +
            "拿不准是不是这一家的（同名的别家公司）不要列进风险。",
          要.risks,
        )) ?? (await 结论("risks", 要.risks));
      必查们 = 认必查(r.必查, 找原文);
      发({ type: "checks", 项: 必查们 });
      风险们 = (Array.isArray(r.风险) ? (r.风险 as Record<string, unknown>[]) : [])
        .filter((x) => x && (x.级别 === "low" || x.级别 === "mid" || x.级别 === "high") && 短(x.说明, 240))
        .slice(0, 4)
        .map((x) => ({ 级别: x.级别 as 风险["级别"], 说明: 短(x.说明, 240), 来源: 材料里的(x.来源), 应对: 短(x.应对, 120) }))
        // 模型自己都说「无法确认是同一主体」的不算这家的风险（10-18 复核：澳洲手套公司 Ansell Ltd 的集体诉讼混进了 Ansell Lighting 的风险）
        .filter((x) => x.来源 && !拿不准同一家.test(x.说明));
      for (const x of 风险们) 发({ type: "tag", tone: "risk", level: x.级别, text: x.说明, source: x.来源, ...(x.应对 ? { 应对: x.应对 } : {}) });
      return 短(r.小结, 300) || (风险们.length || 必查们.some((x) => x.级别 !== "none") ? undefined : "没查到明显风险");
    },
    /**
     * 最后一步：**打分 + 写切入建议，固定用报告模型（gpt-5.5）**——用户定「保证最后回复的质量」。
     * 前面五步（可以是便宜的模型）只负责查和摘要；评档、像哪位老客户、怎么切入都在这一步看着全部材料一次定。
     */
    async approach() {
      const 真实 = await 出真实性();
      // 英国公司的 HMRC 进口商名录是程序查的：先告诉模型，别再写「未查到进口记录」（10-18 复核第 1 点）
      const 名录 = 核验回?.进口 ? 进口摘要(核验回.进口) : null;
      // 必查里「是不是同行」判了「是」：切入先确认它外不外采（复核第 6 点）
      const 同行 = 必查们.find((x) => x.key === "同行")?.是;
      const 评估要 =
        "对下面 5 项各评一档（high / mid / low / unknown），每项一句证据和来源（材料编号或网址）：\n" +
          "category 品类匹配：它卖的 / 用的产品和我们的重合多少\n" +
          // 10-17 AC 回放：同材料同配置跑两遍，这两项在 high / mid 之间来回摇摆（每家分数差 7–9 分），判档条件写死
          "buyerType 买家类型——先从材料认出它是哪一类：进口商 / 分销商 / 批发商、品牌商（自己不生产或部分外包）、工程商 / 安装商、零售商、同类制造商、终端用户。\n" +
          "  high：属于我们业务简介里要找的那类买家，并且材料能看出它对外采购或代理同类产品（列了合作品牌 / 供应商、产品线里有外购品牌、招采购或品类岗、自称 distributor / importer）；例：自称电气分销商、官网列着几十个照明品牌。\n" +
          "  mid：类型对但看不出它对外采购；或者是相邻类型（自己设计、部分生产部分外包的品牌商，小型零售 / 安装商）；例：自称「设计和制造」灯具、看不出外包。\n" +
          "  low：同类制造商（和我们是竞争对手）、终端用户、或和我们的买家类型都不沾边。\n" +
          "  unknown：材料看不出它是哪一类。\n" +
          "market 市场与地区——只看材料里写明的总部、分公司 / 网点、主要客户所在的国家，和我们业务简介里的目标地区比：\n" +
          "  high：总部在目标地区，并且业务覆盖目标地区里 ≥ 2 个国家（同一国的不同城市算 1 个）；例：总部法国、在德国英国都有网点。\n" +
          "  mid：只覆盖目标地区里 1 个国家；或者总部在目标地区之外、但材料写明在目标地区有分公司 / 网点 / 主要客户；或者材料写明它要的认证我们没有。\n" +
          "  low：总部和业务都不在目标地区。\n" +
          "  unknown：材料看不出它在哪些国家做生意。\n" +
          "  认证没提到不扣档；只有材料写明它要某个认证、而我们的简介里没有，才降一档。\n" +
          "scale 规模与采购力\nsignals 近期信号：在招人、扩品类、参展、开新店（近一年）\n" +
          `再和我们的老客户比像不像（国家、品类、买家类型、规模），最多挑 3 位，按编号回：\n${老客户表文本(input.老客户)}\n` +
          "客户画像：一句话说它是哪类客户（例：英国照明品牌商 / 潜在 OEM 客户，不是普通进口商），再写开发前最要先弄清的 1–2 件事（具体到这家，比如它外不外采、接不接受我们的起订量），每句 40 字以内。\n" +
          (同行 === "是" ? "风险那一步判了「是同行」：先弄清的第一件写「它外不外采」。\n" : "") +
          "关键发现：最多 2 条和开发策略有关的事实（优先从官网的公司介绍、历史、生产 / 测试设施页找：自有工厂、在中国的团队、被谁收购、主要渠道），每条带来源，再各写一句对我们是机会还是障碍（可以两样都写，各 40 字以内）。\n" +
          "产品匹配：按我们业务简介里的品类，最多 3 类，各写匹配度（高 / 中 / 低）、它官网上原样写的系列名（材料里没有就空数组，不编）、开发优先级（优先 / 选择性 / 谨慎）、一句依据、一句要准备什么（参数、认证、资料），带来源。" +
          (型号们.length ? `它在卖的型号（${型号们.map((m) => m.型号).join("、")}）可以拿来对。` : "") +
          "\n" +
          "小结只写事实，不要写值不值得开发、要不要跟进——结论由程序按分数定。\n" +
          `程序直查的真实性结果（灯是代码按规则定的，你不能改，也不要另编事实）：\n${真实性文本(真实)}\n` +
          (名录
            ? `进口记录程序已经查到了（HMRC 进口商名录，代码查的）：${名录}。进口记录那一项回 {"有":false} 就行；小结、建议里不要写「未查到进口记录」。\n`
            : "进口记录：材料里有没有这家公司公开的进口 / 提单 / 海关记录（公开提单页、年报里写的进口量、行业媒体报道）。有就写一句摘要并带来源；没有就 {\"有\":false}。" +
              "不许估算：不从员工数、门店数倒推，也不拿国家或品类的宏观数据充数。\n") +
          "真实性：一句话（60 字以内），结合上面程序直查的结果和材料，说这家公司真不真、要留意什么；不能和程序结果矛盾。\n" +
          '{"评档":[{"维度":"category","档":"high","证据":"…","来源":"材料编号或网址"},…],"像的老客户":[{"编号":1,"档":"high","像在哪":"一句话"}],"画像":{"类型":"…","先验证":["…"]},"发现":[{"事实":"…","机会":"…","障碍":"…","来源":"材料编号或网址"}],"匹配":[{"品类":"我们的哪类产品","匹配":"高|中|低","系列":["它的系列名"],"开发":"优先|选择性|谨慎","依据":"…","准备":"…","来源":"材料编号或网址"}],"进口记录":{"有":true,"摘要":"一句话","来源":"材料编号或网址"},"真实性":"一句话","小结":"一句话"}';
      /*
        切入步骤和开发信单独一次、和上面那次并行问（10-18 A+D 结构）：输出多了几块，拆开不加等待时间；
        前缀一样，提示缓存照样命中，只多一次缓存读。写信不用打分那么深的推理
      */
      const 切入要 =
        "切入步骤：按这家的情况写 4 样，每样一句话（40 字以内）：切口 = 先拿我们哪类产品、对标它哪个系列；" +
        "找谁 = 2–4 个要找的岗位名（英文原名，比如 Product Manager、Sourcing Manager，只写岗位、不编人名）；" +
        "提案 = 第一次发的精简提案（3–5 页）里放哪几样；先问 = 报价前先问清的 2–3 个采购机制问题（外不外采、开不开放新供应商、起订量怎么算、要不要验厂）。\n" +
        (同行 === "是" ? "风险那一步判了「是同行」（多半是竞争对手，不是买家）：先问的第一条写「外不外采」。\n" : "") +
        "开发信：用英文写一封给这家公司的开发信（120–200 词），收件人用材料里查到的联系人岗位 / 姓名（没有就写 Purchasing team），开头一句说明为什么找它（引用材料里查到的具体事实），" +
        "中间说我们能提供什么，结尾一个具体的下一步（寄样 / 报价 / 约 15 分钟电话）。不编我们没有的认证和数字。\n" +
        '{"切入":{"切口":"…","找谁":["…"],"提案":"…","先问":["…"]},"开发信":{"主题":"英文","正文":"英文"}}';
      const [评, 切] = await Promise.allSettled([结论("approach", 评估要, 通道.模型), 结论("approach", 切入要, 通道.模型, "low")]);
      if (评.status === "rejected") throw 评.reason;
      if (切.status === "rejected" && signal?.aborted) throw 切.reason;
      // 切入那次没成：报告照出（没有切入步骤和开发信），标「材料不全」
      if (切.status === "rejected") 不完整 = true;
      const r = 评.value;
      const q = 切.status === "fulfilled" ? 切.value : {};
      // 进口记录：英国公司先看服务器直查的 HMRC 进口商名录（程序查的，模型改不了）；查到就用它，盖过模型那句。
      // 否则用模型从材料里认的：来源必须是这次真读过 / 搜到的材料（认来源），对不上就当没有——模型没法凭空写出一条进口记录
      const 进 = r.进口记录 && typeof r.进口记录 === "object" ? (r.进口记录 as Record<string, unknown>) : {};
      const 进源 = 进.有 === true ? 材料里的(进.来源) : undefined;
      const 进摘 = 短(进.摘要, 300);
      const 有名录 = Boolean(名录 && 核验回?.进口);
      // 查到了进口记录：结论、建议里「未查到进口记录」那半句删掉，前后不打架（复核第 1 点）
      const 净 = (t: string) => (有名录 || (进源 && 进摘) ? 去掉没查到进口(t) : t);
      const 网上评档 = 清洗评档(r.评档)
        .filter((x) => x.维度 !== "similar")
        .map((x) => ({ ...x, 来源: 材料里的(x.来源), ...(x.证据 ? { 证据: 净(x.证据) || undefined } : {}) }));
      const 像 = 认像的老客户(r.像的老客户, input.老客户);
      发({ type: "similar", items: 像, 比了: input.老客户.length });
      const 老客户档: 评档 = { 维度: "similar", 档: 老客户维度档(像, input.老客户.length), 证据: 像[0] ? `像 ${像[0].name}：${像[0].像在哪}` : undefined };
      // 必查里有级别的几项也算风险（进风险级别和「先核实」结论），同行那一项的判断拿去封顶（score.ts）
      发({ type: "score", 评分: 算相关性([...网上评档, 老客户档], [...风险们, ...必查转风险(必查们)], {}, { 同行 }) });
      const 画像 = 认画像(r.画像);
      if (画像) {
        const 先验证 = 同行 === "是" && !画像.先验证.some((x) => /外不外采|外采|对外采购|外包/.test(x)) ? ["它外不外采（自己生产同类产品，多半是竞争对手）", ...画像.先验证].slice(0, 2) : 画像.先验证;
        发({ type: "profile", 类型: 净(画像.类型) || 画像.类型, 先验证: 先验证.map((x) => 净(x)).filter(Boolean) });
      }
      const 发现们 = 认发现(r.发现, 找原文).map((x) => ({ ...x, 事实: 净(x.事实) || x.事实 }));
      if (发现们.length) 发({ type: "findings", items: 发现们 });
      const 匹配们 = 认匹配(r.匹配, 找原文);
      if (匹配们.length) 发({ type: "match", items: 匹配们 });
      发({ type: "certs", 提醒: 认证提醒(input.b.brief, 状态.fields.country?.value) });
      // 切入步骤：切口跟着产品匹配里「优先」那一行走（两次是并行问的，免得两处说法不一样）；联系入口用核过原文的联系人
      const 切入 = q.切入 && typeof q.切入 === "object" ? (q.切入 as Record<string, unknown>) : null;
      const 列字 = (v: unknown, n: number, 长: number) => (Array.isArray(v) ? v : []).map((x) => 短(x, 长)).filter(Boolean).slice(0, n);
      let points: string[];
      if (切入) {
        const 优先 = 匹配们.find((x) => x.开发 === "优先") ?? 匹配们[0];
        const 切口 = 优先 ? `先拿${优先.品类}切入${优先.系列.length ? `，对标它的 ${优先.系列.slice(0, 2).join("、")}` : ""}${优先.准备 ? `；准备：${优先.准备}` : ""}` : 短(切入.切口, 160);
        const 找谁 = 列字(切入.找谁, 4, 60);
        const 先问 = 列字(切入.先问, 3, 80);
        const 邮箱们 = (状态.联系人 ?? []).filter((c) => c.邮箱).sort((a, b) => Number(/出口|国际|export|international/i.test(b.岗位 ?? "")) - Number(/出口|国际|export|international/i.test(a.岗位 ?? ""))).slice(0, 2);
        points = [
          切口 && `选产品切口：${切口}`,
          找谁.length && `找对人：优先找 ${找谁.join("、")}（建议去找的岗位，不代表已经确认有这个人）`,
          短(切入.提案, 160) && `发精简提案：${短(切入.提案, 160)}`,
          先问.length && `先问采购机制，再报价：${先问.join("；")}`,
          邮箱们.length && `联系入口：${邮箱们.map((c) => `${c.岗位 ? `${c.岗位} ` : ""}${c.邮箱}`).join("；")}（官网公开的），英文开发信在下面`,
        ].filter((x): x is string => Boolean(x)).map(净).filter(Boolean);
      } else points = (Array.isArray(q.建议) ? q.建议 : Array.isArray(r.建议) ? r.建议 : []).map((x) => 净(短(x, 400))).filter(Boolean).slice(0, 3);
      if (同行 === "是" && !/外不外采|外采|对外采购|外包/.test(points[0] ?? "")) points = [先确认外采, ...points];
      if (points.length) 发({ type: "approach", points });
      // 老的「型号对比」：新提示词不再要（产品匹配顶替了），模型自己给了还照收
      const 比 = 认型号对比(q.型号对比 ?? r.型号对比, 型号们).map((x) => ({ ...x, 怎么比: 净(x.怎么比) || x.怎么比 }));
      if (比.length) 发({ type: "compare", items: 比 });
      const 信 = 认开发信(q.开发信 ?? r.开发信);
      if (信) 发({ type: "email", ...信 });
      发(
        有名录 && 名录 && 核验回?.进口
          ? { type: "import", 有: true, 摘要: 名录, source: 核验回.进口.链接, 来源名: `HMRC 进口商名录 · ${核验回.进口.名}` }
          : 进源 && 进摘
            ? { type: "import", 有: true, 摘要: 进摘, source: 进源 }
            : { type: "import", 有: false },
      );
      const 一句 = 净(短(r.真实性, 200));
      if (一句) 发({ type: "verify-note", text: 一句 });
      // 前面几步的一句话结论里也可能写了「没查到进口记录」：已经换过引用了，只删那半句、原样再发一遍
      if (状态.进口?.有) {
        for (const { id } of 阶段表) {
          const st = 状态.stages[id];
          if (st.status !== "done" || !st.summary) continue;
          const t = 去掉没查到进口(st.summary);
          if (t !== st.summary) 发原样({ type: "stage", stage: id, status: "done", summary: t });
        }
      }
      return 净(短(r.小结, 300)) || undefined;
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
      发({ type: "stage", stage: id, status: "error", summary: 全句(出错, 200) });
      break;
    }
  }

  // 没走到切入建议那一步（中途出错）：真实性那一块照样出，程序直查的结果不该跟着丢
  if (!真 && 材料.length && !signal?.aborted) {
    try {
      await 出真实性();
    } catch {
      /* 拼不出来就算了：报告其余部分照常 */
    }
  }

  // 用户自己停的（点了停、关了页面）：服务器那边不退。别的没跑完（超时、上游报错）退不退由服务器按它自己记的判断
  const 取消 = Boolean(signal?.aborted);
  // 退不退全听服务器的（10-18「我们不花钱，则不扣；我们花钱就扣」）：搜过、调过模型就是花了钱，
  // 一条材料都没搜到也照样出报告（写明没查到）；一分钱没花的（开头就停了）服务器退回
  const 收 = await 通道.收尾(runId, !停在, { searches: 搜索数 + 社媒数, pages: 读页数, 取消 });
  const 退了 = (收?.退了 ?? 0) > 0;
  if (!材料.length && 停在) return { ok: false, error: `${出错 ?? "没跑完"}${退了 ? "，这次不扣次数" : ""}`, 退了 };
  if (停在) 不完整 = true;
  发({ type: "done", charge: 通道.扣次, 不完整, 退了 });
  return { ok: true, 状态, runId, 材料: 材料.map((m) => ({ url: m.url, text: m.text })) };
}
