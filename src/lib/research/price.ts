/**
 * 背调的成本和降本开关（10-16 总控定，用户原话「我们只用判断 gpt，不用 deepseek」「保证最后回复的质量」）。
 *
 * ## 收钱：背调单独计数
 *
 *   背调次数和问答的 AI 次数分开记、分开显示，一次背调扣 1 次（lib/tenant/credits.ts 的 按背调扣）。
 *   售价口径「成本 × 3」，等对比实验出了实际成本再由总控定数——那是运营的事，不进代码。
 *
 * ## 花钱：按中转站 b.ai 的实价算（chat.b.ai 价格表，2026-10-16 用户截图）
 *
 *   单位「积分 / token」，$1 = 100 万积分，所以数字就是「美元 / 百万 token」；「全量接入」档 = 原价。
 *   每个模型三个价：输入、缓存读（输入价的 1/10）、输出。缓存写和输入同价，不单列。
 *   10-16 账单核对：Rexel 那次 GPT 背调 27 笔调用和对比实验记的 token 完全对上，按这张表算约 $1.0。
 *   **每次搜索的按次费**先按 $0.01 留着：账单里有「网络搜索」计数列，是否另收钱等用户看账单确认后再改。
 *   Claude 的价格是官方价，**没按 b.ai 核**（背调默认不用 Claude）。
 *
 * ## 降本开关（都放服务器配置，对比实验逐个比；质量过线的组合里挑最便宜的做默认，见方案第 10 节）
 *
 *   RESEARCH_SEARCH_MODEL   搜索那一路用哪个模型（gpt-5.4-mini 比 gpt-5.5 便宜约 9 倍、快一倍）
 *   RESEARCH_SUMMARY_MODEL  每一步挑工具、写这一步摘要用哪个模型
 *   RESEARCH_REPORT_MODEL   **最后打分 + 写报告那一步，固定 gpt-5.5**（「保证最后回复的质量」）
 *   RESEARCH_SEARCH_CONTEXT GPT 搜索的 search_context_size（low / medium / high）。10-16 实测中转站收下了，
 *                           但 low 只把一次搜索的输入从约 9.9k 降到 9.5k token，作用很小
 *   RESEARCH_SEARCH_LIMIT   一次背调最多搜几次（默认 8，试 5）
 *   RESEARCH_COST_CAP       单次成本上限（元），到了就停手、用已有材料出报告。默认 10（10-17 选 A 后定）
 *   RESEARCH_PRICES         覆盖上面的单价（JSON）
 */

export type 单价 = { 入: number; 缓存: number; 出: number };

/** 美元 / 百万 token。b.ai 价格表 2026-10-16 */
export const 默认单价: Record<string, 单价> = {
  "gpt-5.5": { 入: 5, 缓存: 0.5, 出: 30 },
  "gpt-5.4-mini": { 入: 0.75, 缓存: 0.075, 出: 4.5 },
  "gpt-5.2": { 入: 1.75, 缓存: 0.175, 出: 14 },
  "gpt-5-mini": { 入: 0.25, 缓存: 0.025, 出: 2 },
  // 官方价，未按 b.ai 核
  "claude-sonnet-5.5": { 入: 3, 缓存: 0.3, 出: 15 },
  "claude-haiku-5.5": { 入: 1, 缓存: 0.1, 出: 5 },
};
/** 认不出的模型按最贵的估：宁可早停，不要超支 */
const 兜底单价: 单价 = { 入: 5, 缓存: 0.5, 出: 30 };
export const 默认汇率 = 7.2;
/** 每次联网搜索另收的钱（美元）。待用户看 b.ai 账单确认是否单独收费 */
export const 默认每次搜索美元 = 0.01;
/** 10-17 用户选 A（全 gpt-5.5，一次约 5.6 元，实验里最贵 6.2 元）：上限放到 10 元，不然每次都在半路被截断 */
export const 默认成本上限元 = 10;
export const 默认搜索上限 = 8;
/** 最后打分 + 写报告：固定 gpt-5.5（用户定，保证最后回复的质量） */
export const 默认报告模型 = "gpt-5.5";

type Env = Record<string, string | undefined>;

function 读JSON(v: string | undefined): Record<string, unknown> | null {
  if (!v?.trim()) return null;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function 成本上限元(env: Env = process.env): number {
  const n = Number(env.RESEARCH_COST_CAP);
  return Number.isFinite(n) && n > 0 ? n : 默认成本上限元;
}

/** 一次背调最多搜几次。3–8 之间，配错按默认 */
export function 搜索上限(env: Env = process.env): number {
  const n = Number(env.RESEARCH_SEARCH_LIMIT);
  return Number.isInteger(n) && n >= 3 && n <= 8 ? n : 默认搜索上限;
}

export type 背调模型们 = { 搜索: string; 摘要: string; 报告: string };

/** 三个角色各用哪个模型。没配：搜索、摘要都跟报告一样用 gpt-5.5（实验定了再换成便宜的） */
export function 背调模型们(env: Env = process.env): 背调模型们 {
  const 报告 = env.RESEARCH_REPORT_MODEL?.trim() || 默认报告模型;
  return { 搜索: env.RESEARCH_SEARCH_MODEL?.trim() || 报告, 摘要: env.RESEARCH_SUMMARY_MODEL?.trim() || 报告, 报告 };
}

export type 搜索结果量 = "low" | "medium" | "high";
export function 搜索结果量(env: Env = process.env): 搜索结果量 | undefined {
  const v = env.RESEARCH_SEARCH_CONTEXT?.trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}

export type 价目 = { 单价: Record<string, 单价>; 汇率: number; 每次搜索美元: number };

/** RESEARCH_PRICES：{"汇率":7.2,"每次搜索美元":0.01,"模型":{"gpt-5.5":{"入":5,"缓存":0.5,"出":30}}}，写了哪样覆盖哪样 */
export function 读价目(env: Env = process.env): 价目 {
  const o = 读JSON(env.RESEARCH_PRICES) ?? {};
  const 单价们 = { ...默认单价 };
  const 模型 = o.模型 && typeof o.模型 === "object" ? (o.模型 as Record<string, { 入?: unknown; 缓存?: unknown; 出?: unknown }>) : {};
  for (const [k, v] of Object.entries(模型)) {
    const 入 = Number(v?.入), 出 = Number(v?.出);
    const 缓存 = v?.缓存 === undefined ? 入 / 10 : Number(v.缓存);
    if ([入, 出, 缓存].every((x) => Number.isFinite(x) && x >= 0)) 单价们[k] = { 入, 缓存, 出 };
  }
  const 汇率 = Number(o.汇率);
  const 每次 = Number(o.每次搜索美元);
  return { 单价: 单价们, 汇率: Number.isFinite(汇率) && 汇率 > 0 ? 汇率 : 默认汇率, 每次搜索美元: Number.isFinite(每次) && 每次 >= 0 ? 每次 : 默认每次搜索美元 };
}

/**
 * 一次模型调用花了多少元。入 = 总输入 token（含缓存命中的那部分），缓存 = 其中命中缓存、按缓存读价算的
 */
export function 模型花费元(价: 价目, model: string, 入: number, 出: number, 缓存 = 0): number {
  const p = 价.单价[model] ?? 兜底单价;
  const 命中 = Math.max(0, Math.min(缓存, 入));
  return (((入 - 命中) * p.入 + 命中 * p.缓存 + 出 * p.出) / 1e6) * 价.汇率;
}

/** 一次搜索花了多少元：搜索那一路的模型 token + 每次的搜索费 */
export function 搜索花费元(价: 价目, model: string, 入: number, 出: number, 缓存 = 0): number {
  return 模型花费元(价, model, 入, 出, 缓存) + 价.每次搜索美元 * 价.汇率;
}
