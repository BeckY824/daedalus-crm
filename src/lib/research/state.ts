/**
 * 背调事件 → 背调状态。服务端拿它攒出最终报告，浏览器拿它把流式事件叠成界面——同一个函数，
 * 所以「屏上看到的」和「存进历史 / 客户档案的」是同一份东西（见 types.ts 事件流那段）。
 *
 * 纯函数、不可变：浏览器那边每来一条事件就出一份新状态，React 按引用判断哪块要重画。
 */
import { 阶段表, 字段表, type 来源, type 字段键, type 像的老客户, type 研究事件, type 工具事件, type 阶段号 } from "./types";
import type { 评分结果 } from "./score";

export type 阶段状态 = { status: "idle" | "running" | "done" | "error"; summary?: string; thought?: string; tools: 工具事件[] };

export type 背调状态 = {
  /** 背的是谁：用户说的那个名字；从客户详情页发起的带着客户 id */
  目标: { name: string; customerId?: string };
  stages: Record<阶段号, 阶段状态>;
  fields: Partial<Record<字段键, { value: string; source?: string }>>;
  评分?: 评分结果;
  tags: { tone: "signal" | "risk"; level?: "low" | "mid" | "high"; text: string; source?: string }[];
  similar?: { items: 像的老客户[]; 比了: number };
  approach: string[];
  /** 报告里引用过的来源，按第一次出现的顺序编号（界面上的 [1] [2]） */
  sources: 来源[];
  usage: { searches: number; pages: number };
  done?: { charge: number; 不完整: boolean };
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
      return { ...s, tags: [...s.tags, { tone: e.tone, level: e.level, text: e.text, source: e.source }], sources: 收来源(s.sources, [e.source ? { title: e.source, url: e.source } : undefined]) };
    case "similar":
      return { ...s, similar: { items: e.items, 比了: e.比了 } };
    case "approach":
      return { ...s, approach: e.points };
    case "usage":
      return { ...s, usage: { searches: e.searches, pages: e.pages } };
    case "done":
      return { ...s, done: { charge: e.charge, 不完整: e.不完整 } };
  }
}

/**
 * 工具卡上读到的真标题补回来源表：字段 / 标签只带网址，界面上 [3] 后面显示网址不如显示「Lumora — About us」。
 * 只在渲染和存档前调一次，不在每条事件里做（工具事件和字段事件的先后不固定）。
 */
export function 补标题(s: 背调状态): 来源[] {
  const 标题 = new Map<string, string>();
  for (const st of Object.values(s.stages)) for (const t of st.tools) for (const x of t.sources ?? []) if (x.title && x.title !== x.url) 标题.set(x.url, x.title);
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
  } as 背调状态;
}
