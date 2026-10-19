/**
 * 背调事件 → 背调状态。服务端拿它攒出最终报告，浏览器拿它把流式事件叠成界面——同一个函数，
 * 所以「屏上看到的」和「存进历史 / 客户档案的」是同一份东西（见 types.ts 事件流那段）。
 *
 * 纯函数、不可变：浏览器那边每来一条事件就出一份新状态，React 按引用判断哪块要重画。
 */
import { 阶段表, 字段表, type 来源, type 字段键, type 像的老客户, type 研究事件, type 工具事件, type 阶段号, type 必查项, type 在卖型号, type 联系人, type 型号对比, type 关键发现, type 产品匹配 } from "./types";
import type { 评分结果 } from "./score";
import type { 真实性 } from "./verify/types";
import type { 候选公司, 出现, 号码信息 } from "./person";

export type 阶段状态 = { status: "idle" | "running" | "done" | "error"; summary?: string; thought?: string; tools: 工具事件[] };

export type 背调状态 = {
  /** 背的是谁：用户说的那个名字；从客户详情页发起的带着客户 id */
  目标: { name: string; customerId?: string };
  stages: Record<阶段号, 阶段状态>;
  fields: Partial<Record<字段键, { value: string; source?: string }>>;
  评分?: 评分结果;
  tags: { tone: "signal" | "risk"; level?: "low" | "mid" | "high"; text: string; source?: string; 应对?: string }[];
  similar?: { items: 像的老客户[]; 比了: number };
  approach: string[];
  /** 真实性那一块（不进 100 分）。老版本存下来的报告没有 */
  真实性?: 真实性;
  /** 10-18 对比免费产品加的几块（老版本的报告都没有）：风险必查四项、在卖型号、联系人、型号对比、英文开发信 */
  必查?: 必查项[];
  型号?: 在卖型号[];
  联系人?: 联系人[];
  型号对比?: 型号对比[];
  开发信?: { 主题: string; 正文: string };
  /**
   * 10-18 报告结构（盲评 A + D，老版本的报告都没有）：它是哪类客户 + 开发前先弄清的 1–2 件事、关键发现（机会 / 障碍）、
   * 按我们品类的产品匹配、认证提醒（代码按业务简介和对方国家拼的）
   */
  画像?: { 类型: string; 先验证: string[] };
  发现?: 关键发现[];
  匹配?: 产品匹配[];
  认证提醒?: string[];
  /** 公开进口记录：有 = 摘要 + 来源；没有 = 「未查到公开进口记录」。老版本的报告没有这一项 */
  进口?: { 有: boolean; 摘要?: string; source?: string };
  /** 报告里引用过的来源，按第一次出现的顺序编号（界面上的 [1] [2]） */
  sources: 来源[];
  usage: { searches: number; pages: number };
  done?: { charge: number; 不完整: boolean; 退了?: boolean };
  /**
   * 只有人名 + 电话、没有公司（person.ts）：找公司那几次搜索、认出的候选、号码 / 名字在哪出现过。
   * 选了一家接着背调的，选了 = 那家的名字（报告开头写「从 XX 和号码认出」）
   */
  人?: { 名?: string; 号: 号码信息; tools: 工具事件[]; 候选?: 候选公司[]; 出现?: 出现; 建议?: string[]; 选了?: string };
};

export function 初始状态(目标: 背调状态["目标"]): 背调状态 {
  return {
    目标,
    stages: Object.fromEntries(阶段表.map((s) => [s.id, { status: "idle", tools: [] }])) as unknown as Record<阶段号, 阶段状态>,
    fields: {},
    tags: [],
    approach: [],
    sources: [],
    usage: { searches: 0, pages: 0 },
  };
}

/** 来源去重：同一个网址只编一个号。标题后来的更好（读完页拿到的真标题）就换上 */
function 收来源(已有: 来源[], 新: (来源 | undefined)[]): 来源[] {
  let 出 = 已有;
  for (const s of 新) {
    if (!s?.url || !/^https?:\/\//i.test(s.url)) continue;
    const i = 出.findIndex((x) => x.url === s.url);
    if (i < 0) 出 = [...出, { title: s.title || s.url, url: s.url }];
    else if (s.title && 出[i].title === 出[i].url) 出 = 出.map((x, k) => (k === i ? { ...x, title: s.title } : x));
  }
  return 出;
}

export function 归约(s: 背调状态, e: 研究事件): 背调状态 {
  switch (e.type) {
    case "stage": {
      const old = s.stages[e.stage];
      return { ...s, stages: { ...s.stages, [e.stage]: { ...old, status: e.status, summary: e.summary ?? old.summary } } };
    }
    case "thought": {
      const old = s.stages[e.stage];
      return { ...s, stages: { ...s.stages, [e.stage]: { ...old, thought: e.text } } };
    }
    case "tool": {
      if (e.stage === "person") {
        if (!s.人) return s;
        const i = s.人.tools.findIndex((t) => t.id === e.id);
        const tools = i >= 0 ? s.人.tools.map((t, k) => (k === i ? { ...t, ...e } : t)) : [...s.人.tools, e];
        return { ...s, 人: { ...s.人, tools } };
      }
      const old = s.stages[e.stage];
      const i = old.tools.findIndex((t) => t.id === e.id);
      const tools = i >= 0 ? old.tools.map((t, k) => (k === i ? { ...t, ...e } : t)) : [...old.tools, e];
      return { ...s, stages: { ...s.stages, [e.stage]: { ...old, tools } } };
    }
    case "field":
      if (!字段表.some((f) => f.key === e.key) || !e.value.trim()) return s;
      return {
        ...s,
        fields: { ...s.fields, [e.key]: { value: e.value, source: e.source } },
        sources: 收来源(s.sources, [e.source ? { title: e.source, url: e.source } : undefined]),
      };
    case "score":
      return { ...s, 评分: e.评分, sources: 收来源(s.sources, e.评分.明细.map((d) => (d.来源 ? { title: d.来源, url: d.来源 } : undefined))) };
    case "tag":
      return { ...s, tags: [...s.tags, { tone: e.tone, level: e.level, text: e.text, source: e.source, ...(e.应对 ? { 应对: e.应对 } : {}) }], sources: 收来源(s.sources, [e.source ? { title: e.source, url: e.source } : undefined]) };
    case "similar":
      return { ...s, similar: { items: e.items, 比了: e.比了 } };
    case "approach":
      return { ...s, approach: e.points };
    case "verify":
      return { ...s, 真实性: { ...e.真实性, 总结: e.真实性.总结 ?? s.真实性?.总结 } };
    case "verify-note":
      return s.真实性 ? { ...s, 真实性: { ...s.真实性, 总结: e.text } } : s;
    case "import":
      return {
        ...s,
        进口: e.有 && e.摘要 && e.source ? { 有: true, 摘要: e.摘要, source: e.source } : { 有: false },
        sources: e.有 && e.source ? 收来源(s.sources, [{ title: e.来源名 || e.source, url: e.source }]) : s.sources,
      };
    case "checks":
      return { ...s, 必查: e.项, sources: 收来源(s.sources, e.项.map((x) => (x.source ? { title: x.source, url: x.source } : undefined))) };
    case "models":
      return { ...s, 型号: e.items, sources: 收来源(s.sources, e.items.map((x) => ({ title: x.source, url: x.source }))) };
    case "contacts":
      return { ...s, 联系人: e.items, sources: 收来源(s.sources, e.items.map((x) => ({ title: x.source, url: x.source }))) };
    case "compare":
      return { ...s, 型号对比: e.items };
    case "email":
      return { ...s, 开发信: { 主题: e.主题, 正文: e.正文 } };
    case "profile":
      return { ...s, 画像: { 类型: e.类型, 先验证: e.先验证 } };
    case "findings":
      return { ...s, 发现: e.items, sources: 收来源(s.sources, e.items.map((x) => ({ title: x.source, url: x.source }))) };
    case "match":
      return { ...s, 匹配: e.items, sources: 收来源(s.sources, e.items.map((x) => (x.source ? { title: x.source, url: x.source } : undefined))) };
    case "certs":
      return { ...s, 认证提醒: e.提醒 };
    case "usage":
      return { ...s, usage: { searches: e.searches, pages: e.pages } };
    case "done":
      return { ...s, done: { charge: e.charge, 不完整: e.不完整, 退了: e.退了 } };
    case "person":
      return { ...s, 人: { 名: e.名, 号: e.号, tools: s.人?.tools ?? [] } };
    case "person-found": {
      if (!s.人) return s;
      const 页 = [...e.候选.map((c) => c.来源), ...e.出现.号码, ...e.出现.名字];
      return { ...s, 人: { ...s.人, 候选: e.候选, 出现: e.出现, 建议: e.建议, 选了: e.选了 }, sources: 收来源(s.sources, 页) };
    }
  }
}

/**
 * 工具卡上读到的真标题补回来源表：字段 / 标签只带网址，界面上 [3] 后面显示网址不如显示「Lumora — About us」。
 * 只在渲染和存档前调一次，不在每条事件里做（工具事件和字段事件的先后不固定）。
 */
export function 补标题(s: 背调状态): 来源[] {
  const 标题 = new Map<string, string>();
  for (const t of [...Object.values(s.stages).flatMap((st) => st.tools), ...(s.人?.tools ?? [])]) for (const x of t.sources ?? []) if (x.title && x.title !== x.url) 标题.set(x.url, x.title);
  return s.sources.map((x) => (x.title === x.url && 标题.has(x.url) ? { ...x, title: 标题.get(x.url)! } : x));
}

/** 来源的编号（从 1 起）；不在表里返回 null */
export function 来源号(s: 背调状态, url: string | undefined): number | null {
  if (!url) return null;
  const i = s.sources.findIndex((x) => x.url === url);
  return i < 0 ? null : i + 1;
}

/** 浏览器 / 历史里读回来的东西不可信：形状不对就当没有 */
export function 认背调状态(v: unknown): 背调状态 | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<背调状态>;
  if (!o.目标 || typeof o.目标.name !== "string" || !o.stages || typeof o.stages !== "object") return null;
  for (const st of 阶段表) if (!o.stages[st.id] || !Array.isArray(o.stages[st.id].tools)) return null;
  return {
    ...初始状态(o.目标),
    ...o,
    tags: Array.isArray(o.tags) ? o.tags : [],
    approach: Array.isArray(o.approach) ? o.approach : [],
    sources: Array.isArray(o.sources) ? o.sources : [],
    usage: o.usage ?? { searches: 0, pages: 0 },
    真实性: o.真实性 && Array.isArray(o.真实性.项) ? o.真实性 : undefined,
    进口: o.进口 && typeof o.进口.有 === "boolean" ? o.进口 : undefined,
    必查: Array.isArray(o.必查) ? o.必查 : undefined,
    型号: Array.isArray(o.型号) ? o.型号 : undefined,
    联系人: Array.isArray(o.联系人) ? o.联系人 : undefined,
    型号对比: Array.isArray(o.型号对比) ? o.型号对比 : undefined,
    开发信: o.开发信 && typeof o.开发信.正文 === "string" && typeof o.开发信.主题 === "string" ? o.开发信 : undefined,
    画像: o.画像 && typeof o.画像.类型 === "string" && Array.isArray(o.画像.先验证) ? o.画像 : undefined,
    发现: Array.isArray(o.发现) ? o.发现.filter((x) => x && typeof x.事实 === "string") : undefined,
    匹配: Array.isArray(o.匹配) ? o.匹配.filter((x) => x && typeof x.品类 === "string" && Array.isArray(x.系列)) : undefined,
    认证提醒: Array.isArray(o.认证提醒) ? o.认证提醒.filter((x) => typeof x === "string") : undefined,
    人: o.人 && o.人.号 && typeof o.人.号.号 === "string" && Array.isArray(o.人.tools) ? o.人 : undefined,
  } as 背调状态;
}
