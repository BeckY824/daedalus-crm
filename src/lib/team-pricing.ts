/**
 * 团队版价格表和到期日的算法（2026-10-15）。不碰库，运营台的弹框（浏览器里）和服务端（lib/tenant/team-plan.ts）共用一份：
 * 弹框里预览的「新到期日、应收」和确认后服务端写进去的一定一样。
 * 到期日都按北京时间说（客户都在国内）：「到期 11-15」= 11-15 当天还能用。
 */
/** 运营台能选的时长。label 也是桌面端价格表上的名字 */
export const 时长们 = [
  { months: 1, label: "1 个月" },
  { months: 3, label: "3 个月" },
  { months: 6, label: "半年" },
  { months: 12, label: "1 年" },
] as const;
export const 月数对 = (m: unknown): m is number => 时长们.some((x) => x.months === m);
export const 时长名 = (months: number) => 时长们.find((x) => x.months === months)?.label ?? `${months} 个月`;

export type 价格表 = { prices: { months: number; perSeat: number }[]; trialDays: number };
/** 每人的价（元）。10-15 用户定；运营台「价格表」可改，改了存 SyncPricing，这里只是没改过时的默认 */
export const 默认价格: 价格表 = {
  prices: [
    { months: 1, perSeat: 29.9 },
    { months: 3, perSeat: 84.9 },
    { months: 6, perSeat: 159 },
    { months: 12, perSeat: 299 },
  ],
  trialDays: 14,
};

/** 应收 = 每人价 × 人数，分为单位四舍五入（29.9 × 3 在浮点里是 89.69999…） */
export const 应收 = (perSeat: number, seats: number) => Math.round(perSeat * 100 * seats) / 100;

/* ---------------- 到期日 ---------------- */

const 北京偏移 = 8 * 3600_000;
/** 北京时间的日期 YYYY-MM-DD（客户都在国内，到期日按北京时间说） */
export const 北京日期 = (d: Date) => new Date(d.getTime() + 北京偏移).toISOString().slice(0, 10);
/** 北京时间那一天的最后一刻：到期日写「11-15」就是 11-15 当天还能用 */
export function 当天结束(d: Date): Date {
  const 北 = new Date(d.getTime() + 北京偏移);
  return new Date(Date.UTC(北.getUTCFullYear(), 北.getUTCMonth(), 北.getUTCDate(), 23, 59, 59, 999) - 北京偏移);
}
/** 「YYYY-MM-DD」→ 北京时间那天结束。格式不对回 null */
export function 解析日期(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00+08:00`);
  return Number.isNaN(d.getTime()) || 北京日期(d) !== s ? null : 当天结束(d);
}
/** 按日历加几个月（北京时间）：1-31 加一个月是 2-28 / 29，不跑到 3 月 */
export function 加月(d: Date, months: number): Date {
  const 北 = new Date(d.getTime() + 北京偏移);
  const y = 北.getUTCFullYear(), m = 北.getUTCMonth() + months, day = 北.getUTCDate();
  const 月末 = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const r = new Date(Date.UTC(y, m, Math.min(day, 月末), 北.getUTCHours(), 北.getUTCMinutes(), 北.getUTCSeconds(), 北.getUTCMilliseconds()));
  return new Date(r.getTime() - 北京偏移);
}

/**
 * 开通 / 续费后的新到期日：还没到期从原到期日顺延，已过期、从没开通、或原来不限期都从今天算。
 * 结果落在北京时间那天结束
 */
export function 新到期日(原: Date | null | undefined, 时长: { months: number } | { days: number }, now = new Date()): Date {
  const 起 = 原 && 原.getTime() > now.getTime() ? 原 : now;
  return 当天结束("months" in 时长 ? 加月(起, 时长.months) : new Date(起.getTime() + 时长.days * 86_400_000));
}

/** 还剩几天（按北京日期算：今天到期 = 0，明天到期 = 1，已过期是负数） */
export function 剩几天(paidUntil: Date, now = new Date()): number {
  return Math.round((Date.parse(北京日期(paidUntil)) - Date.parse(北京日期(now))) / 86_400_000);
}

/* ---------------- 闸 ---------------- */

export const 没开通话 = "团队同步还没开通";
export const 到期话 = (paidUntil: Date) => `团队同步已到期（${北京日期(paidUntil)}），暂停同步：续费后自动恢复，这台电脑上的数据照常能用`;
export const 已到期 = (plan: { paidUntil: Date | null } | null | undefined, now = new Date()) => !!plan?.paidUntil && plan.paidUntil.getTime() <= now.getTime();

/** 这个团队现在能不能同步：能回 null，不能回给成员看的那句话（402）。没开通 / 停用 / 到期都在这里 */
export function 同步闸(t: { active: boolean }, plan: { paidUntil: Date | null } | null | undefined, now = new Date()): string | null {
  if (!t.active) return 没开通话;
  if (已到期(plan, now)) return 到期话(plan!.paidUntil!);
  return null;
}
