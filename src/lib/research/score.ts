/**
 * 背调的「和我们的相关性」打分（2026-10-14）。
 *
 * 分工：**模型只评档、给证据；总分由这里按权重算**。
 *   - 同一家公司每次跑出来的分数稳定（模型直接报一个 0–100 的数，这次 78 下次 83，没人说得清差在哪）；
 *   - 说得清为什么是这个分：每一维一档一条证据一个来源；
 *   - 权重能按各家的业务调（「设置 → 我们的业务」），不用改提示词。
 *
 * 两条规矩：
 *   1. **「信息不足」不算 0 分**。查不到规模不等于规模为零——不知道的维度不进分母，另报一个可信度
 *      （查到的那几维的权重占比）。可信度太低时总分照算，但界面要写「信息不足，仅供参考」。
 *   2. **风险单列，不从相关性里扣**。「很对口但有付款纠纷」和「不对口」是两种判断，混成一个数就看不出来了。
 *
 * Attio 也是这个路子：没有固定公式，按用户自己写的 ICP 定义去评；评不出来就留空、不收钱。
 *
 * 10-16 加了第 6 维「像不像老客户」（用户定：既单独显示，又进分数，权重 20）。这一维不是网上查的，
 * 是拿这家公司和用户 CRM 里已成交 / 在谈的客户比（lib/research/similar.ts）。没有老客户的人这一维是 unknown，
 * 照第 1 条不进分母，不会拉低分数。
 */

export const 维度表 = [
  { key: "category", label: "品类匹配", 说明: "它卖的 / 用的产品，和我们的重合多少" },
  { key: "buyerType", label: "买家类型", 说明: "进口商、分销商、品牌商、工程商——是不是我们要找的那类" },
  { key: "market", label: "市场与地区", 说明: "在不在目标国家，我们的认证够不够它当地的要求" },
  { key: "scale", label: "规模与采购力", 说明: "员工、门店；有海关数据时看进口量" },
  { key: "signals", label: "近期信号", 说明: "在招人、扩品类、参展、开新店" },
  { key: "similar", label: "像不像老客户", 说明: "和你已成交 / 在谈的客户比：国家、品类、买家类型、规模" },
] as const;

export type 维度 = (typeof 维度表)[number]["key"];
export type 档 = "high" | "mid" | "low" | "unknown";

/** 默认权重，合计 100。各家可以在设置里改；改过的也会先归一化 */
export const 默认权重: Record<维度, number> = { category: 25, buyerType: 15, market: 15, scale: 10, signals: 15, similar: 20 };

/** 档 → 拿到这一维权重的几成。unknown 不在这里：它不进分母 */
export const 档比例: Record<Exclude<档, "unknown">, number> = { high: 1, mid: 0.6, low: 0.2 };

export type 评档 = { 维度: 维度; 档: 档; 证据?: string; 来源?: string };
export type 风险 = { 级别: "low" | "mid" | "high"; 说明: string; 来源?: string };

export type 评分结果 = {
  /** 0–100；一维都没查到时是 null */
  分: number | null;
  /** 0–1：查到的那几维的权重占比 */
  可信度: number;
  /** 可信度低于 门槛 时为真，界面写「信息不足，仅供参考」 */
  信息不足: boolean;
  明细: { 维度: 维度; label: string; 档: 档; 权重: number; 得分: number | null; 证据?: string; 来源?: string }[];
  /** 风险单列：取最高的那一级；没有就是 none */
  风险级别: "none" | "low" | "mid" | "high";
  风险: 风险[];
};

export const 信息不足门槛 = 0.5;

const 是档 = (v: unknown): v is 档 => v === "high" || v === "mid" || v === "low" || v === "unknown";

/** 模型回来的东西不可信：缺维度当 unknown、档写错当 unknown、同一维报两次取第一条 */
export function 清洗评档(原始: unknown): 评档[] {
  const 表 = Array.isArray(原始) ? 原始 : [];
  const 见过 = new Set<维度>();
  const 出: 评档[] = [];
  for (const x of 表) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const 维 = 维度表.find((d) => d.key === o.维度 || d.key === o.dimension)?.key;
    if (!维 || 见过.has(维)) continue;
    见过.add(维);
    const 档值 = 是档(o.档) ? o.档 : 是档(o.grade) ? o.grade : "unknown";
    const 证据 = typeof (o.证据 ?? o.evidence) === "string" ? String(o.证据 ?? o.evidence).slice(0, 300) : undefined;
    const 来源 = typeof (o.来源 ?? o.source) === "string" ? String(o.来源 ?? o.source).slice(0, 500) : undefined;
    // 说了「高」却拿不出证据：降一档。没证据的高分是最容易误导人的那种
    const 档最终: 档 = 档值 === "high" && !证据 ? "mid" : 档值;
    出.push({ 维度: 维, 档: 档最终, 证据, 来源 });
  }
  for (const d of 维度表) if (!见过.has(d.key)) 出.push({ 维度: d.key, 档: "unknown" });
  return 出;
}

function 归一(权重: Partial<Record<维度, number>>): Record<维度, number> {
  const w = { ...默认权重, ...权重 };
  for (const k of Object.keys(w) as 维度[]) if (!(w[k] >= 0) || !Number.isFinite(w[k])) w[k] = 0;
  const 和 = Object.values(w).reduce((a, b) => a + b, 0);
  if (和 <= 0) return { ...默认权重 };
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, (v / 和) * 100])) as Record<维度, number>;
}

export function 算相关性(评档们: 评档[], 风险们: 风险[] = [], 权重: Partial<Record<维度, number>> = {}): 评分结果 {
  const w = 归一(权重);
  const 按维 = new Map(评档们.map((x) => [x.维度, x]));
  let 分子 = 0;
  let 已知权重 = 0;
  const 明细 = 维度表.map((d) => {
    const x = 按维.get(d.key) ?? { 维度: d.key, 档: "unknown" as 档 };
    const 权 = w[d.key];
    if (x.档 === "unknown" || 权 === 0) return { 维度: d.key, label: d.label, 档: x.档, 权重: 权, 得分: null, 证据: x.证据, 来源: x.来源 };
    const 得 = 权 * 档比例[x.档];
    分子 += 得;
    已知权重 += 权;
    return { 维度: d.key, label: d.label, 档: x.档, 权重: 权, 得分: Math.round(得 * 10) / 10, 证据: x.证据, 来源: x.来源 };
  });
  const 可信度 = Math.round((已知权重 / 100) * 100) / 100;
  const 分 = 已知权重 > 0 ? Math.round((分子 / 已知权重) * 100) : null;
  const 级 = ["high", "mid", "low"] as const;
  const 风险级别 = 级.find((l) => 风险们.some((r) => r.级别 === l)) ?? "none";
  return { 分, 可信度, 信息不足: 可信度 < 信息不足门槛, 明细, 风险级别, 风险: 风险们 };
}
