/**
 * 问数据 —— 查询规格与聚合。
 *
 * AI 不写 SQL：它只把自然语言翻译成下面这个受限的 QuerySpec
 * （指标 × 拆分维度 × 时间范围），能查什么、怎么组合在代码里白纸黑字。
 * 模型永远碰不到数据库，最坏结果是"这个问题答不了"，不会是查错或注入。
 *
 * 纯函数，不碰网络与数据库；取数在 reports/ask.ts 里用 Prisma 完成。
 */
import { dayjs } from "@/lib/utils";

export const METRICS = {
  leads_count: { label: "新增线索数", unit: "条" },
  lead_conversion: { label: "线索转化率", unit: "%" },
  customers_count: { label: "新增学员数", unit: "人" },
  contract_amount: { label: "签约金额", unit: "元" },
  contract_count: { label: "签约单数", unit: "笔" },
  followups_count: { label: "跟进次数", unit: "次" },
} as const;
export type Metric = keyof typeof METRICS;

export const GROUP_BYS = {
  month: "按月",
  sales: "按销售负责人",
  channel: "按来源渠道",
  source: "按线索来源",
  grade: "按年级",
  followStatus: "按跟进状态",
  decisionStatus: "按决策状态",
  type: "按跟进类型",
} as const;
export type GroupBy = keyof typeof GROUP_BYS;

/** 每个指标允许的拆分维度。不在表里的组合直接拒绝，宁可答不了也不答错 */
export const VALID_GROUPS: Record<Metric, GroupBy[]> = {
  leads_count: ["month", "source", "sales"],
  lead_conversion: ["month", "source"],
  customers_count: ["month", "sales", "channel", "grade", "followStatus", "decisionStatus"],
  contract_amount: ["month", "sales", "channel"],
  contract_count: ["month", "sales", "channel"],
  followups_count: ["month", "sales", "type"],
};

export type QuerySpec = {
  metric: Metric;
  groupBy: GroupBy | null;
  /** YYYY-MM-DD，含当天；null = 不限 */
  from: string | null;
  to: string | null;
};

function asDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = dayjs(v);
  return d.isValid() ? d.format("YYYY-MM-DD") : null;
}

/** @throws 指标未知或组合不支持时抛中文错误，直接给提问的人看 */
export function sanitizeQuerySpec(raw: unknown): QuerySpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const metric = r.metric as Metric;
  if (!(metric in METRICS)) {
    throw new Error("这个问题超出了可查的指标范围（线索/学员/转化率/签约/跟进），请换个问法");
  }
  let groupBy: GroupBy | null = null;
  if (r.groupBy != null && r.groupBy !== "") {
    const g = r.groupBy as GroupBy;
    if (!(g in GROUP_BYS)) throw new Error("不认识的拆分维度，请换个问法");
    if (!VALID_GROUPS[metric].includes(g)) {
      throw new Error(`「${METRICS[metric].label}」不支持${GROUP_BYS[g]}拆分`);
    }
    groupBy = g;
  }
  let from = asDate(r.from);
  let to = asDate(r.to);
  if (from && to && from > to) [from, to] = [to, from];

  /**
   * 起点在未来的查询一律拒绝。
   *
   * 提示词已要求模型把"明天能签几单"判为不支持，但模型不一定遵守——
   * 真实复现过：它把这问题翻译成"查明天的签约单数"，如实答"0 笔"。
   * 数字没错，可读的人会以为系统在预测明天签不了单，比直接说不支持更糟。
   * 这里做最后一道拦截：查询只回答已经发生的事。
   */
  if (from && dayjs(from).isAfter(dayjs(), "day")) {
    throw new Error("这个问题问的是将来，系统只能查已经发生的数据");
  }

  return { metric, groupBy, from, to };
}

export type ResultRow = { label: string; value: number; note?: string };

/**
 * 计数/求和类聚合。key 用实体 id 而不是显示名——成员和学员姓名允许重复，
 * 按姓名归组会把两个人的数字悄悄加进同一行（数据复盘页同款硬规则）。
 */
export function sumRows(
  items: { key: string; label: string; value: number }[],
  opts: { byMonth?: boolean } = {},
): ResultRow[] {
  const map = new Map<string, ResultRow>();
  for (const it of items) {
    const cur = map.get(it.key);
    if (cur) cur.value += it.value;
    else map.set(it.key, { label: it.label, value: it.value });
  }
  const rows = [...map.values()];
  // 按月看的是走势，必须按时间排；其余按数值倒序，第一行就是答案
  rows.sort(opts.byMonth ? (a, b) => a.label.localeCompare(b.label) : (a, b) => b.value - a.value);
  return rows.slice(0, 12);
}

/** 转化率聚合：value 为百分比（1 位小数），note 记「转化/新增」的原始分子分母 */
export function rateRows(
  items: { key: string; label: string; created: number; converted: number }[],
  opts: { byMonth?: boolean } = {},
): ResultRow[] {
  const map = new Map<string, { label: string; created: number; converted: number }>();
  for (const it of items) {
    const cur = map.get(it.key) ?? { label: it.label, created: 0, converted: 0 };
    cur.created += it.created;
    cur.converted += it.converted;
    map.set(it.key, cur);
  }
  const rows = [...map.values()].map((r) => ({
    label: r.label,
    value: r.created > 0 ? Math.round((r.converted / r.created) * 1000) / 10 : 0,
    note: `${r.converted}/${r.created}`,
  }));
  rows.sort(opts.byMonth ? (a, b) => a.label.localeCompare(b.label) : (a, b) => b.value - a.value);
  return rows.slice(0, 12);
}

export function bucketMonth(d: Date): string {
  return dayjs(d).format("YYYY-MM");
}
