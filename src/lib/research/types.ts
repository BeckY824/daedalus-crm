/**
 * AI 联网背调（2026-10-16）：桌面端和服务器两头共用的形状。
 *
 * 分工：
 *   桌面端（本机 Next 服务）  跑 6 步编排（lib/research/run.ts），每一步让模型在上限内调 web_search / read_page
 *   我们的服务器              /api/gateway/v1/research/{start,search,read,finish}：扣次数、真去搜、真去读网页
 *
 * 搜索 Key 只在服务器上（中转站自带搜索：Claude / GPT，10-16 用户定）；桌面端拿设备令牌来，和模型网关同一套鉴权。
 * 开发和测试一律走模拟（lib/research/mock.ts），不花钱。
 */

export const 阶段表 = [
  { id: "identify", label: "认准公司" },
  { id: "basics", label: "基本面" },
  { id: "fit", label: "和我们的相关性" },
  { id: "signals", label: "近期信号" },
  { id: "risks", label: "风险排查" },
  { id: "approach", label: "切入建议" },
] as const;

export type 阶段号 = (typeof 阶段表)[number]["id"];

/** 一次搜索回来的一条 */
export type 搜索结果 = {
  title: string;
  url: string;
  /** 这条和查询相关的那一两句（搜索服务给的摘要或引用原文），可以为空 */
  snippet: string;
  /** 发布 / 更新时间，搜索服务给就带上，原样字符串 */
  published?: string;
};

/** 读一页回来的正文（已去掉标签，截断过） */
export type 读页结果 = { url: string; title: string; text: string; 截断了: boolean };

/**
 * 一次背调的硬上限（默认值）。搜索次数可以在服务器上调（RESEARCH_SEARCH_LIMIT，price.ts），开始时随回应告诉桌面端；
 * 服务器按同一份数再卡一遍（客户端可以被改，服务器不行）
 */
export const 背调上限 = { 搜索: 8, 读页: 10 } as const;

/* 扣几次、花多少的规矩在 price.ts（服务器按配置算，桌面端开跑前问 /research/price 拿数） */

/* ---------- 网关接口（/api/gateway/v1/research/*）的请求和回应 ---------- */

/** 开跑前问价：一次扣几次背调次数（1）、还剩几次背调（和问答的 AI 次数分开；测试账号 不限） */
export type 价目回应 = { 扣次: number; 还剩: number; 不限?: true };

/** 这次背调到现在估计花了多少钱、上限多少（元）。搜索 / 读页的回应里带着，桌面端到了上限就停手 */
export type 花费 = { 已花元: number; 上限元: number };

/**
 * runId 和 X-Question-Id 同一个规矩：1–64 位 [A-Za-z0-9_-]。
 * 走我们的模型：老字段，服务器不再看——10-16 起背调的搜索和分析一律走我们的服务器、一律照价扣（price.ts）
 */
export type 开始请求 = { runId: string; 走我们的模型?: boolean };
export type 开始回应 =
  | {
      ok: true;
      扣了: number;
      /** 背调次数还剩几次 */
      还剩: number;
      /** 最后打分 + 写报告用哪个模型（服务器定，固定 gpt-5.5） */
      模型?: string;
      /** 每一步挑工具、写摘要用哪个模型（服务器定，可以是便宜的 mini） */
      摘要模型?: string;
      /** 这次最多搜几次（服务器配置 RESEARCH_SEARCH_LIMIT） */
      搜索上限?: number;
    }
  | { ok: false; error: string };

export type 搜索请求 = { runId: string; query: string };
export type 搜索回应 = { results: 搜索结果[]; 花费?: 花费 };

export type 读页请求 = { runId: string; url: string };
export type 读页回应 = 读页结果 & { 花费?: 花费 };

/**
 * 收尾。ok = 桌面端这边 6 步都跑完了（只记账用）；取消 = 用户自己停的（点了停、关了页面），不退。
 * **退不退服务器自己判断**（credits.ts 的 收尾背调）：最后一步交没交出去、我们这边失败过没有，都是服务器自己记的
 */
export type 收尾请求 = { runId: string; ok: boolean; 取消?: boolean; searches?: number; pages?: number };
export type 收尾回应 = { ok: true; 退了: number; 还剩: number };

/* ---------- 背调过程的事件流（本机 /api/ai/stream → 浏览器） ----------
 *
 * 每个看得见的变化都对应一条事件：阶段开始 / 结束、一次搜索、一格档案填上、分数出来……
 * 浏览器按 lib/research/state.ts 的 归约 一条条叠成 背调状态；最后那份状态就是报告本身，
 * 存进对话历史、存进客户档案用的都是它。所以界面上看到的和存下来的不会对不上。
 */

export type 来源 = { title: string; url: string };

/** 公司卡上的那几格。值都是一句短话，查不到就不出现 */
export const 字段表 = [
  { key: "country", label: "国家 / 城市" },
  { key: "founded", label: "成立" },
  { key: "size", label: "规模" },
  { key: "business", label: "主营" },
  { key: "buyerType", label: "买家类型" },
  { key: "site", label: "官网" },
  { key: "contact", label: "公开联系方式" },
] as const;
export type 字段键 = (typeof 字段表)[number]["key"];

export type 工具事件 = {
  type: "tool";
  stage: 阶段号;
  id: string;
  kind: "search" | "read";
  label: string;
  status: "running" | "done" | "error";
  /** 做完的一句：「9 条结果」「1 页 · 2.4k 字」「读不了：…」 */
  result?: string;
  ms?: number;
  sources?: 来源[];
};

export type 像的老客户 = { id: string; name: string; 档: "high" | "mid" | "low"; 像在哪: string };

export type 研究事件 =
  | { type: "stage"; stage: 阶段号; status: "running" | "done" | "error"; /** 做完的一句结论，折叠后那一行显示它 */ summary?: string }
  | { type: "thought"; stage: 阶段号; text: string }
  | 工具事件
  | { type: "field"; key: 字段键; value: string; source?: string }
  | { type: "score"; 评分: import("./score").评分结果 }
  | { type: "tag"; tone: "signal" | "risk"; level?: "low" | "mid" | "high"; text: string; source?: string }
  | { type: "similar"; items: 像的老客户[]; /** CRM 里拿来比的老客户有几位；0 = 还没有成交 / 在谈的客户 */ 比了: number }
  | { type: "approach"; points: string[] }
  | { type: "usage"; searches: number; pages: number }
  | {
      type: "done";
      charge: number;
      /** 某一步没跑完，或碰到单次成本上限停手：用已有材料出的报告。搜索 / 读页次数用满不算（那是预算） */
      不完整: boolean;
      /** 服务器判定这次没跑完是我们这边的原因，扣的那 1 次退回了 */
      退了?: boolean;
    };
