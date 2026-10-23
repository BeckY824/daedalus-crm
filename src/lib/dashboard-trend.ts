import type { Dayjs } from "dayjs";
import { dayjs } from "@/lib/utils";

/**
 * 看板上的趋势数（「数据」页和没配 AI 的首页共用，见 dashboard/Board.tsx）。
 *
 * 原来写在 Board 里，是「每一天 × 每一行」都现建 dayjs 再按天比：1 万客户、2 万条跟进时
 * 90 天要建上百万个 dayjs 对象，服务端出页 6–7.5 秒（2026-10-20 测）。
 * 现在每一行只建一次 dayjs、记下它那一天的零点，之后全是数字比较。
 *
 * **口径一点没动**：比较的仍是 dayjs 按本地时区算出的「那一天的零点」，
 * 和原来 `isAfter(d, "day")` 一模一样。tests/dashboard-trend.test.ts 拿原来的写法对拍。
 */

/** dayjs(x).startOf("day") 的毫秒值：`a.isAfter(b, "day")` 就是 `零点(a) > 零点(b)` */
const 零点 = (x: Date | Dayjs) => dayjs(x).startOf("day").valueOf();

export type 趋势点 = { label: string; created: number; active: number };

/**
 * 近 90 天两条线：截至当天的**累计**客户数，和当天往前 30 天内有跟进的客户数。
 *   累计：客户建档那天 ≤ 当天
 *   活跃：跟进那天 ≤ 当天，且 > 当天往前第 30 天
 */
export function 近90天趋势(
  now: Dayjs,
  客户: { createdAt: Date }[],
  跟进: { customerId: string; occurredAt: Date }[],
): 趋势点[] {
  const 建档日 = 客户.map((c) => 零点(c.createdAt));
  const 跟进日 = 跟进.map((f) => ({ id: f.customerId, 日: 零点(f.occurredAt) }));
  return Array.from({ length: 90 }, (_, i) => {
    const d = now.subtract(89 - i, "day");
    const 当天 = 零点(d);
    const 窗口起 = 零点(d.subtract(30, "day"));
    let 累计 = 0;
    for (const 日 of 建档日) if (日 <= 当天) 累计++;
    const 活跃 = new Set<string>();
    for (const f of 跟进日) if (f.日 <= 当天 && f.日 > 窗口起) 活跃.add(f.id);
    return { label: d.format("MM-DD"), created: 累计, active: 活跃.size };
  });
}

/** 最近 8 周，每周一段 [起, 止)：本周起点往前数 7 周起 */
export function 最近8周(now: Dayjs) {
  return Array.from({ length: 8 }, (_, i) => ({
    起: now.subtract(7 - i, "week").startOf("week"),
    止: now.subtract(6 - i, "week").startOf("week"),
  }));
}

/** 每周新增客户：建档时刻严格在 起、止 之间（和原来 isAfter(起) && isBefore(止) 一样，两头都不含） */
export function 每周新增(周: { 起: Dayjs; 止: Dayjs }[], 客户: { createdAt: Date }[]): number[] {
  const 时刻 = 客户.map((c) => c.createdAt.getTime());
  return 周.map((w) => {
    const 起 = w.起.valueOf();
    const 止 = w.止.valueOf();
    let n = 0;
    for (const t of 时刻) if (t > 起 && t < 止) n++;
    return n;
  });
}
