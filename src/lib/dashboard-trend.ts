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

/*
  卡片下方另两条小曲线（进行中商机金额、赢单率）。原来写在 Board 里是「8 周 × 每条商机」各现建一个 dayjs 再 isBefore：
  企业版 10 倍数据压测时首页 CPU 九成多花在这一句上（2026-10-24 CPU 分析）。
  现在每条商机只取一次建档时刻，之后全是数字比较。isBefore 不带单位比的就是两个真实时刻，
  所以 `createdAt.getTime() < 止.valueOf()` 一模一样（北京业务钟的 valueOf 也是真实时刻，见 business-clock.ts）；
  金额按原来的顺序一条条加，浮点合计也不变。tests/dashboard-week-series.test.ts 拿原来的写法对拍
*/

/** 截至每周止（不含）建档、还在进行中的商机金额，单位千元四舍五入。`算这条` 是原来 filter 里的币种条件 */
export function 每周进行中金额<T extends { createdAt: Date; status: string; amount: number }>(
  周: { 止: Dayjs }[],
  商机: T[],
  算这条: (o: T) => boolean,
): number[] {
  const 行 = 商机.filter((o) => o.status === "OPEN" && 算这条(o)).map((o) => ({ t: o.createdAt.getTime(), amount: o.amount }));
  return 周.map((w) => {
    const 止 = w.止.valueOf();
    let sum = 0;
    for (const o of 行) if (o.t < 止) sum += o.amount;
    return Math.round(sum / 1000);
  });
}

/** 截至每周止（不含）建档的已关闭商机里赢单的百分比，四舍五入；一条都没关闭是 0 */
export function 每周赢单率(周: { 止: Dayjs }[], 商机: { createdAt: Date; status: string }[]): number[] {
  const 行 = 商机.filter((o) => o.status === "WON" || o.status === "LOST").map((o) => ({ t: o.createdAt.getTime(), 赢: o.status === "WON" }));
  return 周.map((w) => {
    const 止 = w.止.valueOf();
    let 关 = 0;
    let 赢 = 0;
    for (const o of 行) if (o.t < 止) { 关++; if (o.赢) 赢++; }
    return 关 ? Math.round((赢 / 关) * 100) : 0;
  });
}
