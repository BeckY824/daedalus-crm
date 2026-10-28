/**
 * 外贸订单的样品、验货、海运、节点负责人（0.46.30 D-44～D-47）。不碰数据库，客户端和服务端都能引。
 *
 * 不往 12 个节点里插新节点（lib/order.ts 的 节点名们 不动）：
 *   - 样品：一轮一行（TradeOrderCheck kind = 样品），界面摆在「客户确认（PI）」那一步旁边；不寄样的单标「不适用」
 *   - 验货：同一张表 kind = 验货，挂在「验货 / 货好」那一步；最近一轮「不过」= 卡在返工
 *   - 海运：一单一行（TradeOrderTrack），摆在「报关 / 开船」之后；到港的灯和节点同一套（过期红、3 天内黄）
 *   - 负责人：一个节点一行（TradeOrderNodeOwner），「我该做的」= 我负责、没完成、不是不适用
 */

import { businessDay } from "./business-clock";
import { calendarDay, calendarDaysBetween } from "./schedule-date";
import type { 灯 } from "./order";

export const 检查类们 = ["样品", "验货"] as const;
export type 检查类 = (typeof 检查类们)[number];

/** 每一类能填的结果。样品：过 / 要改 / 重打；验货：过 / 不过 */
export const 检查结果们: Record<检查类, readonly string[]> = {
  样品: ["过", "要改", "重打"],
  验货: ["过", "不过"],
};

/** 样品放在第几步旁边、验货是第几步、海运跟在第几步后面（idx 从 1 起，对 lib/order.ts 的 节点名们） */
export const 样品节点 = 4;
export const 验货节点 = 8;
export const 开船节点 = 11;

export type 检查轮 = { kind: string; round: number; at?: string | Date | null; result?: string | null; issue?: string | null };

/** 同一类里轮次最大的那一轮（没有就 null） */
export function 最近一轮<T extends 检查轮>(轮们: T[], kind: 检查类): T | null {
  let 最近: T | null = null;
  for (const x of 轮们) if (x.kind === kind && (!最近 || x.round > 最近.round)) 最近 = x;
  return 最近;
}

/** 下一轮的轮次：同类最大轮次 + 1 */
export function 下一轮次(轮们: 检查轮[], kind: 检查类): number {
  return (最近一轮(轮们, kind)?.round ?? 0) + 1;
}

/** 卡在返工：最近一轮验货是「不过」。后面补一轮「过」就不算了 */
export function 返工(轮们: 检查轮[]): boolean {
  return 最近一轮(轮们, "验货")?.result === "不过";
}

export type 样品状态 = "不适用" | "已过" | "要改" | "重打" | "已寄" | "未寄";

/**
 * 样品走到哪了，给列表和详情上那一小格用：
 * 标了不适用 → 不适用；没有任何一轮 → 未寄；最近一轮有结果 → 那个结果（过 = 已过）；寄了还没回话 → 已寄
 */
export function 样品状态(轮们: 检查轮[], 不适用: boolean): 样品状态 {
  if (不适用) return "不适用";
  const 最近 = 最近一轮(轮们, "样品");
  if (!最近) return "未寄";
  if (最近.result === "过") return "已过";
  if (最近.result === "要改" || 最近.result === "重打") return 最近.result;
  return "已寄";
}

export type 海运 = { eta?: string | Date | null; ata?: string | Date | null };

const 日串 = (v: string | Date) => (typeof v === "string" ? businessDay(v) : calendarDay(v));

/**
 * 到港的灯，和节点灯同一套：已经到了 = 绿；没填预计到港 = 无；预计到港早于今天还没到 = 红；3 天内 = 黄
 */
export function 到港灯(t: 海运 | null | undefined, 现在: Date = new Date()): 灯 {
  if (!t) return "无";
  if (t.ata) return "绿";
  if (!t.eta) return "无";
  const 差天 = calendarDaysBetween(calendarDay(现在), 日串(t.eta));
  if (差天 < 0) return "红";
  if (差天 <= 3) return "黄";
  return "无";
}

/**
 * 到港临近（或过期还没到）、钱还没收齐：尾款要显眼。
 * 未收 = 订单的钱().未收（金额 − 定金实收 − 尾款实收），货一到港就该放单，钱没到手是最要紧的事
 */
export function 尾款要催(t: 海运 | null | undefined, 未收: number, 现在: Date = new Date()): boolean {
  const 灯 = 到港灯(t, 现在);
  return (灯 === "红" || 灯 === "黄") && 未收 > 0;
}

export type 带负责人的节点 = { idx: number; status: string; ownerId?: string | null };

/** 我该做的：我负责、没完成、也不是不适用的那几步 */
export function 我该做的<T extends 带负责人的节点>(nodes: T[], 我: string): T[] {
  if (!我) return [];
  return nodes.filter((n) => n.ownerId === 我 && n.status !== "已完成" && n.status !== "不适用");
}
