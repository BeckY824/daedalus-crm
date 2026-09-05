/**
 * 盯盘提醒 —— 三类"正在被遗忘"的信号，按优先级排序。
 *
 * 检测是纯规则、实时计算：不需要定时任务、不需要落库、永远不过期。
 * 数据量（几百条）在页面加载里算是毫秒级的事，为它建 cron + 表纯属自找麻烦。
 * AI 不参与检测，只在销售对某一条点「起草跟进」时按需生成话术。
 *
 * 优先级即评分：状态权重 × 沉睡天数，每条附人话理由——
 * 销售不信黑盒分数，但"意向较高的学员 18 天没人碰"这句话自己会说服人。
 */
import { dayjs } from "@/lib/utils";

export type WatchItem = {
  kind: "overdue_plan" | "sleeping" | "stalled_opp";
  customerId: string;
  customerName: string;
  ownerName: string;
  reason: string;
  score: number;
};

export const KIND_LABEL: Record<WatchItem["kind"], string> = {
  overdue_plan: "计划逾期",
  sleeping: "沉睡学员",
  stalled_opp: "商机停滞",
};

/** 超过这个天数没碰就算沉睡/停滞 */
export const STALE_DAYS = 14;

/**
 * 沉睡学员的状态权重：越接近成交、被遗忘的代价越大。
 * 已签约/已流失是终态；暂缓跟进是销售有意搁置的，唤醒它反而是打脸。
 */
const STATUS_WEIGHT: Record<string, number> = {
  意向较高: 5,
  已试听: 4,
  已加微信: 3,
  跟进中: 2,
  待跟进: 1,
};

export type SentinelInput = {
  /** 未完成且已到期的跟进计划 */
  overduePlans: { customerId: string; customerName: string; ownerName: string; subject: string; plannedAt: Date }[];
  /** 非终态、非暂缓的学员 */
  customers: { id: string; name: string; followStatus: string; lastFollowAt: Date | null; createdAt: Date; ownerName: string }[];
  /** 进行中的商机 */
  opportunities: { customerId: string; customerName: string; ownerName: string; name: string; stage: string; updatedAt: Date }[];
};

export function buildWatchlist(input: SentinelInput, now: Date): WatchItem[] {
  const n = dayjs(now);
  const items: WatchItem[] = [];

  // 逾期计划最优先：这是销售自己写下的承诺，过期没做比"忘了跟"严重
  for (const p of input.overduePlans) {
    const days = n.diff(p.plannedAt, "day");
    if (days < 0) continue;
    items.push({
      kind: "overdue_plan",
      customerId: p.customerId,
      customerName: p.customerName,
      ownerName: p.ownerName,
      reason: `跟进计划「${p.subject}」已逾期 ${days} 天`,
      score: 100 + Math.min(days, 30),
    });
  }

  for (const c of input.customers) {
    const weight = STATUS_WEIGHT[c.followStatus];
    if (weight === undefined) continue;
    const days = n.diff(c.lastFollowAt ?? c.createdAt, "day");
    if (days < STALE_DAYS) continue;
    items.push({
      kind: "sleeping",
      customerId: c.id,
      customerName: c.name,
      ownerName: c.ownerName,
      reason: c.lastFollowAt
        ? `「${c.followStatus}」的学员已 ${days} 天没人跟进`
        : `录入 ${days} 天从未跟进过`,
      score: weight * 8 + Math.min(days, 40),
    });
  }

  for (const o of input.opportunities) {
    const days = n.diff(o.updatedAt, "day");
    if (days < STALE_DAYS) continue;
    items.push({
      kind: "stalled_opp",
      customerId: o.customerId,
      customerName: o.customerName,
      ownerName: o.ownerName,
      reason: `商机「${o.name}」停在「${o.stage}」已 ${days} 天没动`,
      score: 50 + Math.min(days - STALE_DAYS, 40),
    });
  }

  // 同一学员可能同时命中多条信号，只留分数最高的一条——
  // 盯盘清单的敌人是噪音，一个学员占三行没人会看完
  const byCustomer = new Map<string, WatchItem>();
  for (const it of items) {
    const cur = byCustomer.get(it.customerId);
    if (!cur || it.score > cur.score) byCustomer.set(it.customerId, it);
  }

  return [...byCustomer.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}
