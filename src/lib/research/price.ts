/**
 * 背调的价钱和成本（10-16 总控定，用户原话「你来定，我们要赚取利润」）。
 *
 * ## 收多少：一次扣 60 次 AI
 *
 *   试跑（Rexel，GPT 搜索 + GPT 分析）一次约 2.6 元；「1 次 AI」按首页问答的成本约 0.05 元；
 *   2.6 ÷ 0.05 ≈ 52，加 15% 余量取整 = 60。对比实验跑完按实测平均成本重算（成本 ÷ 0.05 × 1.15，取整）。
 *   放配置 AI_PRICE_TABLE（JSON，{"research": 60}），改价不用发版。
 *   **自己填了模型 Key 的照扣**：背调的搜索和分析都走我们的服务器、用我们的 Key，不能白用。
 *   次数包按每次 0.15 元卖（成本 3 倍），背调一次约合 9 元，毛利约 70%；新用户送的 30 次不够跑一次背调——有意的，背调是付费功能。
 *
 * ## 花多少：单次成本硬上限 4 元
 *
 *   服务器按 token 和搜索次数实时估（模型调用在模型网关里记、搜索在搜索接口里记，都累到 AiResearchRun.costLi），
 *   到了上限就不再给搜、不再给读；桌面端看到了就停手，用已有材料出报告、写「材料不全」。
 *   单价是官方价估的（中转站实价没准数），放配置 RESEARCH_PRICES 可以改。
 *
 * 这个文件两头都用：服务器（扣次、记成本、卡上限）和对比实验脚本（scripts/research-bench.ts 用同一套算法估成本）。
 */

/** 美元 / 百万 token。官方价，中转站实价可能更低——估高了只会让上限更保守 */
export const 默认单价: Record<string, { 入: number; 出: number }> = {
  "gpt-5.5": { 入: 1.25, 出: 10 },
  "claude-sonnet-5.5": { 入: 3, 出: 15 },
  "claude-haiku-5.5": { 入: 1, 出: 5 },
};
/** 认不出的模型按最贵的估：宁可早停，不要超支 */
const 兜底单价 = { 入: 3, 出: 15 };
export const 默认汇率 = 7.2;
/** 每次联网搜索另收的钱（美元）：Claude / GPT 的搜索工具官方价都是约 $10 / 千次 */
export const 默认每次搜索美元 = 0.01;
export const 默认背调扣次 = 60;
export const 默认成本上限元 = 4;
/** 「1 次 AI」约值多少元（首页问答一次的平均成本）。重算扣次时用 */
export const 一次AI约元 = 0.05;

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

/** 一次背调扣几次。AI_PRICE_TABLE 里的 research；没配、配错一律按默认，不按 0（配错了不能变成免费） */
export function 背调扣次(env: Env = process.env): number {
  const n = Number(读JSON(env.AI_PRICE_TABLE)?.research);
  return Number.isInteger(n) && n > 0 ? n : 默认背调扣次;
}

export function 成本上限元(env: Env = process.env): number {
  const n = Number(env.RESEARCH_COST_CAP);
  return Number.isFinite(n) && n > 0 ? n : 默认成本上限元;
}

export type 价目 = { 单价: Record<string, { 入: number; 出: number }>; 汇率: number; 每次搜索美元: number };

/** RESEARCH_PRICES：{"汇率":7.2,"每次搜索美元":0.01,"模型":{"gpt-5.5":{"入":1.25,"出":10}}}，写了哪样覆盖哪样 */
export function 读价目(env: Env = process.env): 价目 {
  const o = 读JSON(env.RESEARCH_PRICES) ?? {};
  const 单价 = { ...默认单价 };
  const 模型 = o.模型 && typeof o.模型 === "object" ? (o.模型 as Record<string, { 入?: unknown; 出?: unknown }>) : {};
  for (const [k, v] of Object.entries(模型)) {
    const 入 = Number(v?.入), 出 = Number(v?.出);
    if (Number.isFinite(入) && Number.isFinite(出) && 入 >= 0 && 出 >= 0) 单价[k] = { 入, 出 };
  }
  const 汇率 = Number(o.汇率);
  const 每次 = Number(o.每次搜索美元);
  return { 单价, 汇率: Number.isFinite(汇率) && 汇率 > 0 ? 汇率 : 默认汇率, 每次搜索美元: Number.isFinite(每次) && 每次 >= 0 ? 每次 : 默认每次搜索美元 };
}

/** 一次模型调用花了多少元 */
export function 模型花费元(价: 价目, model: string, 入: number, 出: number): number {
  const p = 价.单价[model] ?? 兜底单价;
  return ((入 * p.入 + 出 * p.出) / 1e6) * 价.汇率;
}

/** 一次搜索花了多少元：搜索那一路的模型 token + 每次的搜索费 */
export function 搜索花费元(价: 价目, model: string, 入: number, 出: number): number {
  return 模型花费元(价, model, 入, 出) + 价.每次搜索美元 * 价.汇率;
}

/** 按实测平均成本重算该扣几次：成本 ÷ 0.05 × 1.15，取整（向上） */
export function 建议扣次(平均成本元: number): number {
  return Math.ceil((平均成本元 / 一次AI约元) * 1.15);
}
